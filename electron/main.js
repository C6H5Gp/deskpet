const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
  ipcMain,
} = require('electron');
const path = require('path');
const fs = require('fs');

// Windows 透明合成
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

const WIN_W = 640;
const WIN_H = 640;

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;

/** 拖窗状态 */
let dragState = null;

/** 全屏光标跟踪定时器 */
let cursorTrackTimer = null;

/** 全局键鼠轮询定时器 */
let inputTrackTimer = null;

/** @type {((vk: number) => number) | null} */
let getAsyncKeyState = null;

/** 上一轮按键按下状态（vk → boolean） */
const keyDownPrev = new Map();

/** 纯修饰键，不触发桌宠动作 */
const KEY_IGNORE = new Set([
  0x04, 0x05, 0x06, // 中键 / 侧键
  0x10, 0x11, 0x12, // Shift / Ctrl / Alt
  0x14, 0x90, 0x91, // Caps / Num / Scroll
  0x5b, 0x5c, 0x5d, // Win / Apps
  0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, // 左右修饰键
]);

const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const VK_RETURN = 0x0d;

/**
 * 用户态可见性（不以 isVisible 为唯一依据）。
 * Windows 透明 + focusable:false 时，hide/show 后 Electron 的 isVisible 可能与真实状态脱节。
 */
let petVisible = true;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return {
      clickThrough: false,
      openAtLogin: true,
      windowX: null,
      windowY: null,
      ...JSON.parse(raw),
    };
  } catch {
    return {
      clickThrough: false,
      openAtLogin: true,
      windowX: null,
      windowY: null,
    };
  }
}

function saveSettings(next) {
  try {
    settings = { ...settings, ...next };
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('保存设置失败:', err);
  }
}

let settings = {
  clickThrough: false,
  openAtLogin: true,
  windowX: null,
  windowY: null,
};

/** 保存当前窗口位置 */
function persistWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  saveSettings({ windowX: x, windowY: y });
}

/**
 * 解析初始坐标：优先用上次位置（需仍落在某块屏幕上），否则右下角
 */
function resolveWindowPosition() {
  const fallback = () => {
    const { workArea } = screen.getPrimaryDisplay();
    return {
      x: Math.round(workArea.x + workArea.width - WIN_W - 16),
      y: Math.round(workArea.y + workArea.height - WIN_H - 16),
    };
  };

  const sx = settings.windowX;
  const sy = settings.windowY;
  if (typeof sx !== 'number' || typeof sy !== 'number' || Number.isNaN(sx) || Number.isNaN(sy)) {
    return fallback();
  }

  // 窗口中心点仍在某显示器工作区内才恢复，避免换分辨率后飞出屏幕
  const cx = sx + WIN_W / 2;
  const cy = sy + WIN_H / 2;
  const display = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
  const area = display.workArea;
  const visible =
    cx >= area.x &&
    cx <= area.x + area.width &&
    cy >= area.y &&
    cy <= area.y + area.height;

  if (!visible) return fallback();
  return { x: Math.round(sx), y: Math.round(sy) };
}

function stopCursorTracking() {
  if (cursorTrackTimer) {
    clearInterval(cursorTrackTimer);
    cursorTrackTimer = null;
  }
}

function initKeyApi() {
  if (getAsyncKeyState) return true;
  if (process.platform !== 'win32') return false;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    getAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int)');
    return true;
  } catch (err) {
    console.error('初始化键鼠监听失败:', err);
    return false;
  }
}

function stopInputTracking() {
  if (inputTrackTimer) {
    clearInterval(inputTrackTimer);
    inputTrackTimer = null;
  }
  keyDownPrev.clear();
}

function sendInput(payload) {
  if (!petVisible || !mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('pet:input', { ...payload, at: Date.now() });
}

/**
 * 轮询全局键鼠（窗口 focusable:false 时 DOM 收不到）
 * Enter → enter；鼠标左/右键 → left/right；其它键 → type
 */
function startInputTracking() {
  stopInputTracking();
  if (!initKeyApi() || !getAsyncKeyState) return;

  inputTrackTimer = setInterval(() => {
    if (!petVisible || !mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;

    /** @type {'enter' | 'type' | 'left' | 'right' | null} */
    let eventType = null;

    // 鼠标左右键
    for (const [vk, type] of [
      [VK_LBUTTON, 'left'],
      [VK_RBUTTON, 'right'],
    ]) {
      const down = (getAsyncKeyState(vk) & 0x8000) !== 0;
      const wasDown = keyDownPrev.get(vk) === true;
      keyDownPrev.set(vk, down);
      if (down && !wasDown) eventType = type;
    }

    // 键盘
    for (let vk = 0x08; vk <= 0xfe; vk++) {
      if (KEY_IGNORE.has(vk)) continue;
      const down = (getAsyncKeyState(vk) & 0x8000) !== 0;
      const wasDown = keyDownPrev.get(vk) === true;
      keyDownPrev.set(vk, down);
      if (!down || wasDown) continue;

      if (vk === VK_RETURN) {
        eventType = 'enter';
        break;
      }
      if (eventType !== 'enter' && eventType !== 'left' && eventType !== 'right') {
        eventType = 'type';
      }
    }

    if (eventType) {
      sendInput({ type: eventType });
    }
  }, 33);
}

function startCursorTracking() {
  stopCursorTracking();
  cursorTrackTimer = setInterval(() => {
    if (!petVisible || !mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint(cursor);
    const area = display.bounds;
    mainWindow.webContents.send('pet:cursor', {
      x: cursor.x,
      y: cursor.y,
      winX: bounds.x,
      winY: bounds.y,
      winW: bounds.width,
      winH: bounds.height,
      screenX: area.x,
      screenY: area.y,
      screenW: area.width,
      screenH: area.height,
    });
  }, 33); // ~30fps
}

function applyClickThrough(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (enabled) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
}

/**
 * 显示桌宠窗口。
 * Windows 上 transparent + focusable:false 时 showInactive() 经常无效，需用 show() 兜底并重申置顶。
 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  petVisible = true;
  try {
    mainWindow.setOpacity(1);
  } catch {
    // 忽略个别平台不支持
  }
  // show() 在 focusable:false 时通常不抢焦点，比 showInactive 更可靠
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  applyClickThrough(settings.clickThrough);
  startCursorTracking();
  startInputTracking();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  petVisible = false;
  mainWindow.hide();
  stopCursorTracking();
  stopInputTracking();
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (petVisible) {
    hideMainWindow();
  } else {
    showMainWindow();
  }
}

/** 开机自启（仅打包后的 exe 写入系统登录项） */
function applyOpenAtLogin(enabled) {
  if (!app.isPackaged) {
    console.log('[deskpet] 开机自启偏好已保存，打包为 exe 后才会写入系统登录项:', enabled);
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    name: '桌宠',
  });
}

function createTrayIcon() {
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const i = (y * size + x) * 4;
      if (dx * dx + dy * dy <= 36) {
        bitmap[i] = 110;
        bitmap[i + 1] = 198;
        bitmap[i + 2] = 176;
        bitmap[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}

function buildTrayMenu() {
  const visible =
    petVisible && mainWindow && !mainWindow.isDestroyed();
  return Menu.buildFromTemplate([
    {
      label: visible ? '隐藏' : '显示',
      click: () => {
        toggleMainWindow();
      },
    },
    {
      label: '点击穿透',
      type: 'checkbox',
      checked: !!settings.clickThrough,
      click: (item) => {
        settings.clickThrough = item.checked;
        applyClickThrough(settings.clickThrough);
        saveSettings({ clickThrough: settings.clickThrough });
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!settings.openAtLogin,
      click: (item) => {
        settings.openAtLogin = item.checked;
        saveSettings({ openAtLogin: settings.openAtLogin });
        applyOpenAtLogin(settings.openAtLogin);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        persistWindowPosition();
        app.quit();
      },
    },
  ]);
}

function createWindow() {
  const { x, y } = resolveWindowPosition();

  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    title: '',
    transparent: true,
    frame: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 不抢焦点：避免切换应用时 blur/focus 导致闪烁与伪标题栏
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, '..', 'deskpet', 'pet.html'));

  mainWindow.once('ready-to-show', () => {
    applyClickThrough(settings.clickThrough);
    mainWindow.setMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setBackgroundColor('#00000000');
    showMainWindow();
  });

  mainWindow.on('moved', () => {
    // 拖动过程中也会触发；结束拖动时再写一次更稳妥，这里做轻量节流
    if (!dragState) persistWindowPosition();
  });

  mainWindow.on('closed', () => {
    stopCursorTracking();
    stopInputTracking();
    mainWindow = null;
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('桌宠');
  // 不用固定 setContextMenu 作为右键唯一来源：每次右键现场 build，保证「显示/隐藏」文案正确
  tray.on('click', () => {
    toggleMainWindow();
  });
  tray.on('right-click', () => {
    tray.popUpContextMenu(buildTrayMenu());
  });
}

function setupIpc() {
  ipcMain.on('pet:start-drag', (_event, { offsetX, offsetY }) => {
    if (!mainWindow || mainWindow.isDestroyed() || settings.clickThrough) return;
    const bounds = mainWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    dragState = {
      offsetX: typeof offsetX === 'number' ? offsetX : cursor.x - bounds.x,
      offsetY: typeof offsetY === 'number' ? offsetY : cursor.y - bounds.y,
    };
  });

  ipcMain.on('pet:drag-move', () => {
    if (!mainWindow || mainWindow.isDestroyed() || !dragState) return;
    const cursor = screen.getCursorScreenPoint();
    mainWindow.setPosition(
      Math.round(cursor.x - dragState.offsetX),
      Math.round(cursor.y - dragState.offsetY)
    );
  });

  ipcMain.on('pet:end-drag', () => {
    dragState = null;
    persistWindowPosition();
  });
}

app.whenReady().then(() => {
  settings = loadSettings();
  // 首次或偏好为真时同步登录项
  if (typeof settings.openAtLogin !== 'boolean') {
    settings.openAtLogin = true;
    saveSettings({ openAtLogin: true });
  }
  applyOpenAtLogin(settings.openAtLogin);
  setupIpc();
  // 稍延迟创建，让 transparent visuals 就绪
  setTimeout(() => {
    createWindow();
    createTray();
  }, 50);
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  persistWindowPosition();
  stopCursorTracking();
  stopInputTracking();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
