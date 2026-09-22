const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
  ipcMain,
  powerMonitor,
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

/**
 * 角色命中区（窗口客户区坐标，由渲染进程上报）
 * @type {{ x: number, y: number, width: number, height: number } | null}
 */
let hitBounds = null;

/** 全屏光标跟踪定时器 */
let cursorTrackTimer = null;

/** 全局键鼠轮询定时器 */
let inputTrackTimer = null;

/** 主进程拖动轮询 */
let dragTrackTimer = null;

/** 上一轮左键是否按下（用于拖动边沿检测） */
let dragLeftWasDown = false;

/** @type {((vk: number) => number) | null} */
let getAsyncKeyState = null;

/** 上一轮按键按下状态（vk → boolean） */
const keyDownPrev = new Map();

/** 可见性看门狗：对抗 Win+D / DWM 透明合成「假消失」 */
let visibilityWatchTimer = null;
/** 意外 hide 后的延迟恢复句柄 */
let recoverHideTimer = null;
/** 正在 hide/show 重建表面，避免 hide 事件递归 */
let recoveringSurface = false;
/** recoveringSurface 置位时间（防卡死） */
let recoveringSurfaceSince = 0;
/** 窗口重建中（与看门狗/hide 互斥，防循环） */
let recreatingWindow = false;
/** 窗口创建时间，启动后短时间内忽略 display-metrics 强制恢复 */
let windowCreatedAt = 0;
/** 重建结束冷却截止时间戳 */
let recreateCooldownUntil = 0;

const logPath = () => path.join(app.getPath('userData'), 'deskpet-error.log');

/** 追加异常/崩溃/重建原因到 userData/deskpet-error.log */
function appendLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), line, 'utf8');
  } catch (err) {
    console.error('deskpet-error.log 写入失败:', err);
  }
}

function setRecoveringSurface(on) {
  recoveringSurface = !!on;
  recoveringSurfaceSince = on ? Date.now() : 0;
}

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

/**
 * 已有 settings.json 里 clickThrough 缺键或不是布尔时，启动后写成 true。
 * 不覆盖用户已保存的 false。全新安装没有文件时只靠代码默认值，不额外建文件。
 */
let clickThroughMissing = false;

function loadSettings() {
  clickThroughMissing = false;
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.clickThrough !== 'boolean') {
      clickThroughMissing = true;
    }
    return {
      clickThrough: true,
      openAtLogin: true,
      windowX: null,
      windowY: null,
      ...parsed,
    };
  } catch {
    return {
      clickThrough: true,
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
  clickThrough: true,
  openAtLogin: true,
  windowX: null,
  windowY: null,
};

/** 保存当前窗口位置（允许探出屏幕：角色未铺满窗口时需靠探出贴齐右下角） */
function persistWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  saveSettings({ windowX: x, windowY: y });
}

/**
 * 解析初始坐标：优先用上次位置（中心仍在某屏上即可，允许探出），否则右下角
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

  // 窗口中心点仍在某显示器工作区内才恢复，避免换分辨率后完全丢失
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

/** 有效命中区；尚未上报时用窗口中心区域兜底 */
function getEffectiveHitBounds() {
  if (
    hitBounds &&
    hitBounds.width > 32 &&
    hitBounds.height > 32
  ) {
    return hitBounds;
  }
  return {
    x: Math.round(WIN_W * 0.2),
    y: Math.round(WIN_H * 0.1),
    width: Math.round(WIN_W * 0.6),
    height: Math.round(WIN_H * 0.8),
  };
}

function isCursorOverHit(cursor) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const b = mainWindow.getBounds();
  const lx = cursor.x - b.x;
  const ly = cursor.y - b.y;
  if (lx < 0 || ly < 0 || lx > b.width || ly > b.height) return false;
  const hit = getEffectiveHitBounds();
  return (
    lx >= hit.x &&
    lx <= hit.x + hit.width &&
    ly >= hit.y &&
    ly <= hit.y + hit.height
  );
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

    // 鼠标左右键（与模型动作左右相反：左键→右，右键→左）
    for (const [vk, type] of [
      [VK_LBUTTON, 'right'],
      [VK_RBUTTON, 'left'],
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

    // 点击穿透开启时：整窗（含本体）穿透；关闭则整窗接收鼠标
    if (settings.clickThrough && !dragState) {
      setMouseIgnore(true);
    }
  }, 33); // ~30fps
}

function stopDragTracking() {
  if (dragTrackTimer) {
    clearInterval(dragTrackTimer);
    dragTrackTimer = null;
  }
  dragLeftWasDown = false;
  dragState = null;
}

/**
 * 主进程拖动：用全局左键 + 命中区移动窗口。
 * Windows 透明窗即使 setIgnoreMouseEvents(false)，透明像素也常收不到 DOM 事件，
 * 因此不能只靠渲染进程 pointerdown。
 */
function startDragTracking() {
  stopDragTracking();
  if (!initKeyApi() || !getAsyncKeyState) return;

  const DRAG_THRESHOLD = 5;

  dragTrackTimer = setInterval(() => {
    if (!petVisible || !mainWindow || mainWindow.isDestroyed()) {
      dragState = null;
      dragLeftWasDown = false;
      return;
    }

    const leftDown = (getAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
    const cursor = screen.getCursorScreenPoint();

    if (dragState) {
      if (!leftDown) {
        dragState = null;
        persistWindowPosition();
        // 松手后恢复：开启穿透=继续整窗穿透；关闭=接收鼠标
        if (settings.clickThrough) {
          setMouseIgnore(true);
        } else {
          setMouseIgnore(false);
        }
      } else {
        const dx = Math.abs(cursor.x - dragState.startX);
        const dy = Math.abs(cursor.y - dragState.startY);
        if (!dragState.moved && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
          dragState.moved = true;
        }
        if (dragState.moved) {
          mainWindow.setPosition(
            Math.round(cursor.x - dragState.offsetX),
            Math.round(cursor.y - dragState.offsetY)
          );
        }
      }
      dragLeftWasDown = leftDown;
      return;
    }

    // 仅关闭穿透时可拖；开启穿透时整窗忽略鼠标
    if (
      !settings.clickThrough &&
      leftDown &&
      !dragLeftWasDown &&
      isCursorOverHit(cursor)
    ) {
      const bounds = mainWindow.getBounds();
      dragState = {
        offsetX: cursor.x - bounds.x,
        offsetY: cursor.y - bounds.y,
        startX: cursor.x,
        startY: cursor.y,
        moved: false,
      };
      setMouseIgnore(false);
    }

    dragLeftWasDown = leftDown;
  }, 16);
}

/** 当前是否忽略鼠标（避免重复调用 setIgnoreMouseEvents） */
let ignoringMouse = null;

/**
 * 设置鼠标穿透。
 * 开启「点击穿透」时：未命中角色忽略鼠标（空白穿透），命中角色时关闭忽略以便点击/拖动；
 * 开启穿透时由主进程按命中区轮询切换 ignore；forward:true 便于部分 Windows 上命中探测更稳。
 * 拖动本身由主进程全局左键轮询完成，不依赖透明像素能否收到 DOM 事件。
 */
function setMouseIgnore(ignore) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const next = !!ignore;
  if (ignoringMouse === next) return;
  ignoringMouse = next;
  if (next) {
    // forward:true keeps move delivery for hit probing on some Windows builds;
    // click-through itself still depends on toggling ignore off over the character.
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
}

function applyClickThrough(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 开启=整窗穿透（含本体）；关闭=整窗接收鼠标
  ignoringMouse = null;
  dragState = null;
  if (enabled) {
    setMouseIgnore(true);
  } else {
    setMouseIgnore(false);
  }
  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('pet:click-through', { enabled: !!enabled });
  }
}

/**
 * 在用户期望显示时，强制恢复透明窗表面。
 * Windows 上 transparent 窗可能仍 isVisible，但 DWM 丢绘；hide→show 与托盘「隐藏再显示」同理可重建。
 */
function ensureMainWindowShown(forceCycle = false) {
  if (!petVisible || !mainWindow || mainWindow.isDestroyed()) return;
  if (recoveringSurface || recreatingWindow || Date.now() < recreateCooldownUntil) return;
  setRecoveringSurface(true);
  appendLog(`ensureMainWindowShown forceCycle=${!!forceCycle}`);

  const finish = () => {
    if (!petVisible || !mainWindow || mainWindow.isDestroyed()) {
      setRecoveringSurface(false);
      return;
    }
    try {
      mainWindow.setOpacity(1);
    } catch {
      // 忽略
    }
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setBackgroundColor('#00000000');
    applyClickThrough(settings.clickThrough);
    setRecoveringSurface(false);
  };

  try {
    // 不再 hide()/show 硬切：Windows 透明窗 hide 会丢掉 WebGL/Live2D 表面（闪一下没了）
    if (forceCycle) {
      try { mainWindow.setOpacity(0.99); } catch { /* ignore */ }
      setTimeout(() => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setOpacity(1); } catch { /* ignore */ }
        finish();
      }, 40);
      return;
    }
    finish();
  } catch (err) {
    setRecoveringSurface(false);
    appendLog(`ensureMainWindowShown error: ${err && err.message ? err.message : err}`);
    console.error('恢复桌宠窗口失败:', err);
  }
}

function stopVisibilityWatch() {
  if (visibilityWatchTimer) {
    clearInterval(visibilityWatchTimer);
    visibilityWatchTimer = null;
  }
  if (recoverHideTimer) {
    clearTimeout(recoverHideTimer);
    recoverHideTimer = null;
  }
}

function startVisibilityWatch() {
  stopVisibilityWatch();
  visibilityWatchTimer = setInterval(() => {
    if (!petVisible || !mainWindow || mainWindow.isDestroyed()) return;
    // 重建窗口冷却期内不 forceCycle，避免与 recreate 打架成环
    if (recreatingWindow || Date.now() < recreateCooldownUntil) return;
    // recoveringSurface 卡死 >3s 则强制复位，避免永久跳过恢复
    if (recoveringSurface) {
      if (recoveringSurfaceSince && Date.now() - recoveringSurfaceSince > 3000) {
        appendLog('recoveringSurface stuck >3s, reset flag');
        setRecoveringSurface(false);
      } else {
        return;
      }
    }
    let visible = false;
    try {
      visible = mainWindow.isVisible();
    } catch {
      return;
    }
    if (!visible) {
      // 系统藏窗或 Electron 可见性脱节 → 用 hide/show 重建（等同托盘隐藏再显示）
      appendLog('visibilityWatch: isVisible=false → hide/show recover');
      ensureMainWindowShown(false);
      return;
    }
    // 仍可见时定期重申置顶与不透明；opacity 异常则强制复位
    try {
      let opacity = 1;
      try {
        opacity = mainWindow.getOpacity();
      } catch {
        opacity = 1;
      }
      if (!Number.isFinite(opacity) || opacity < 0.99 || opacity > 1.01) {
        appendLog(`visibilityWatch: weird opacity=${opacity} → reset 1`);
        mainWindow.setOpacity(1);
      }
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.setOpacity(1);
    } catch {
      // 忽略
    }
  }, 800);
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
  startDragTracking();
  startVisibilityWatch();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  petVisible = false;
  stopVisibilityWatch();
  mainWindow.hide();
  stopCursorTracking();
  stopInputTracking();
  stopDragTracking();
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

/**
 * 渲染进程崩溃/无响应时销毁并重建窗口，保留托盘。
 */
function recreateMainWindow(reason) {
  if (recreatingWindow || Date.now() < recreateCooldownUntil) return;
  recreatingWindow = true;
  appendLog(`recreateMainWindow: ${reason}`);
  try {
    persistWindowPosition();
  } catch {
    // 忽略
  }
  stopVisibilityWatch();
  stopCursorTracking();
  stopInputTracking();
  stopDragTracking();
  setRecoveringSurface(false);
  const old = mainWindow;
  mainWindow = null;
  if (old && !old.isDestroyed()) {
    try {
      old.removeAllListeners();
      old.destroy();
    } catch (err) {
      appendLog(`destroy old window failed: ${err && err.message ? err.message : err}`);
    }
  }
  try {
    createWindow();
  } catch (err) {
    appendLog(`createWindow after recreate failed: ${err && err.message ? err.message : err}`);
    console.error('重建窗口失败:', err);
  } finally {
    // ~1.5s 冷却：ready-to-show / 看门狗 / hide 不会立刻再 forceCycle
    recreateCooldownUntil = Date.now() + 1500;
    setTimeout(() => {
      recreatingWindow = false;
    }, 1500);
  }
}

function createWindow() {
  windowCreatedAt = Date.now();
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
    acceptFirstMouse: true,
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
  // 全屏游戏/其它工作区仍尽量可见（API 存在时）
  if (typeof mainWindow.setVisibleOnAllWorkspaces === 'function') {
    try {
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (err) {
      appendLog(`setVisibleOnAllWorkspaces failed: ${err && err.message ? err.message : err}`);
    }
  }
  mainWindow.loadFile(path.join(__dirname, '..', 'deskpet', 'pet.html'));

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendLog(
      `render-process-gone: reason=${details && details.reason} exitCode=${details && details.exitCode}`
    );
    recreateMainWindow('render-process-gone');
  });
  mainWindow.webContents.on('unresponsive', () => {
    appendLog('webContents unresponsive');
    recreateMainWindow('unresponsive');
  });

  mainWindow.once('ready-to-show', () => {
    applyClickThrough(settings.clickThrough);
    mainWindow.setMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setBackgroundColor('#00000000');
    showMainWindow();
  });

  // 系统「显示桌面」等会直接 hide，此时 petVisible 仍为 true → 自动拉回
  mainWindow.on('hide', () => {
    if (!petVisible || recoveringSurface || recreatingWindow) return;
    if (Date.now() < recreateCooldownUntil) return;
    if (recoverHideTimer) clearTimeout(recoverHideTimer);
    recoverHideTimer = setTimeout(() => {
      recoverHideTimer = null;
      if (!petVisible || recreatingWindow || Date.now() < recreateCooldownUntil) return;
      appendLog('hide event → Win+D/system hide recover');
      ensureMainWindowShown(false);
    }, 80);
  });

  mainWindow.on('moved', () => {
    // 主进程拖动中由 drag 轮询写回；其它移动（如系统）在此保存
    if (!dragState) persistWindowPosition();
  });

  mainWindow.on('closed', () => {
    stopVisibilityWatch();
    stopCursorTracking();
    stopInputTracking();
    stopDragTracking();
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
  /** 渲染进程 ignore 请求：暂不采纳（containsPoint 易误判导致整窗穿透）；主进程 hitBounds 轮询为准 */
  ipcMain.on('pet:mouse-ignore', (_event, _ignore) => {
    // intentionally ignored
  });

  /** 渲染进程上报角色包围盒（窗口客户区坐标） */
  ipcMain.on('pet:hit-bounds', (_event, bounds) => {
    if (
      !bounds ||
      typeof bounds.x !== 'number' ||
      typeof bounds.y !== 'number' ||
      typeof bounds.width !== 'number' ||
      typeof bounds.height !== 'number'
    ) {
      return;
    }
    const x = bounds.x;
    const y = bounds.y;
    const width = bounds.width;
    const height = bounds.height;
    // 拒绝异常过大的命中框（几乎整窗），避免「开启穿透却完全点不到下层」
    if (width >= WIN_W * 0.95 && height >= WIN_H * 0.95) {
      return;
    }
    hitBounds = { x, y, width, height };
  });

  ipcMain.handle('pet:get-click-through', () => !!settings.clickThrough);
}

// 单实例：第二进程退出，并把焦点/显示交给第一进程
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    appendLog('second-instance → restore window');
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) createWindow();
      return;
    }
    try {
      mainWindow.setOpacity(1);
    } catch {
      // 忽略
    }
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    showMainWindow();
  });
}

app.on('child-process-gone', (_event, details) => {
  appendLog(
    `child-process-gone: type=${details && details.type} reason=${details && details.reason} exitCode=${details && details.exitCode} name=${(details && details.name) || ''}`
  );
});

process.on('uncaughtException', (err) => {
  appendLog(`uncaughtException: ${err && err.stack ? err.stack : err}`);
  console.error('uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  const msg =
    reason && reason.stack
      ? reason.stack
      : reason && reason.message
        ? reason.message
        : String(reason);
  appendLog(`unhandledRejection: ${msg}`);
  console.error('unhandledRejection:', reason);
});

app.whenReady().then(() => {
  if (!gotTheLock) return;
  settings = loadSettings();
  appendLog('app ready');
  // 首次或偏好为真时同步登录项
  if (typeof settings.openAtLogin !== 'boolean') {
    settings.openAtLogin = true;
    saveSettings({ openAtLogin: true });
  }
  // 缺 clickThrough 或值不是布尔时默认开启并落盘；已保存的 false 保持不变
  if (clickThroughMissing || typeof settings.clickThrough !== 'boolean') {
    settings.clickThrough = true;
    saveSettings({ clickThrough: true });
  }
  applyOpenAtLogin(settings.openAtLogin);
  setupIpc();

  // 休眠唤醒 / 解锁 / 分辨率变化后，透明层常丢绘，主动重建
  const recoverAfterSystemChange = () => {
    if (!petVisible) return;
    if (windowCreatedAt && Date.now() - windowCreatedAt < 5000) {
      appendLog('skip recoverAfterSystemChange: within 5s of createWindow');
      return;
    }
    setTimeout(() => ensureMainWindowShown(false), 120);
  };
  powerMonitor.on('resume', recoverAfterSystemChange);
  powerMonitor.on('unlock-screen', recoverAfterSystemChange);
  screen.on('display-metrics-changed', recoverAfterSystemChange);

  // 稍延迟创建，让 transparent visuals 就绪
  setTimeout(() => {
    createWindow();
    createTray();
  }, 50);
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  persistWindowPosition();
  stopVisibilityWatch();
  stopCursorTracking();
  stopInputTracking();
  stopDragTracking();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
