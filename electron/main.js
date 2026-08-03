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

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { clickThrough: false, windowX: null, windowY: null, ...JSON.parse(raw) };
  } catch {
    return { clickThrough: false, windowX: null, windowY: null };
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

let settings = { clickThrough: false, windowX: null, windowY: null };

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

function startCursorTracking() {
  stopCursorTracking();
  cursorTrackTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
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
  const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  return Menu.buildFromTemplate([
    {
      label: visible ? '隐藏' : '显示',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.showInactive();
        }
        tray.setContextMenu(buildTrayMenu());
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
    mainWindow.showInactive();
    mainWindow.setBackgroundColor('#00000000');
    startCursorTracking();
  });

  mainWindow.on('show', () => {
    startCursorTracking();
  });
  mainWindow.on('hide', () => {
    stopCursorTracking();
  });

  mainWindow.on('moved', () => {
    // 拖动过程中也会触发；结束拖动时再写一次更稳妥，这里做轻量节流
    if (!dragState) persistWindowPosition();
  });

  mainWindow.on('closed', () => {
    stopCursorTracking();
    mainWindow = null;
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('桌宠');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.showInactive();
    }
    tray.setContextMenu(buildTrayMenu());
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
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
