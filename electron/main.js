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
    return { clickThrough: false, ...JSON.parse(raw) };
  } catch {
    return { clickThrough: false };
  }
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('保存设置失败:', err);
  }
}

let settings = { clickThrough: false };

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

/**
 * Electron Windows 透明窗失焦后可能冒出系统标题栏（已知 bug）。
 * 轻微改尺寸强制 DWM 重绘，去掉伪标题条。
 */
function forceRedrawFrame() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getSize();
  const canResize = mainWindow.isResizable();
  if (!canResize) mainWindow.setResizable(true);
  mainWindow.setSize(w, h + 1);
  mainWindow.setSize(w, h);
  if (!canResize) mainWindow.setResizable(false);
  mainWindow.setBackgroundColor('#00000000');
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
          mainWindow.show();
          forceRedrawFrame();
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
        saveSettings(settings);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      },
    },
  ]);
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + workArea.width - WIN_W - 16);
  const y = Math.round(workArea.y + workArea.height - WIN_H - 16);

  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    title: '',
    transparent: true,
    frame: false,
    // 不要设 titleBarStyle: 'hidden'（与 transparent 组合在 Win 上更容易冒标题栏）
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: true,
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
    // 先以透明显示，再强制重绘去掉可能的伪标题栏
    mainWindow.setOpacity(0.99);
    mainWindow.show();
    mainWindow.setBackgroundColor('#00000000');
    forceRedrawFrame();
    startCursorTracking();
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setOpacity(1);
      forceRedrawFrame();
    }, 80);
  });

  mainWindow.on('show', () => {
    startCursorTracking();
  });
  mainWindow.on('hide', () => {
    stopCursorTracking();
  });

  mainWindow.on('blur', () => {
    // 失焦时 Windows 常画出蓝色/灰色标题条，立刻重绘抹掉
    setTimeout(forceRedrawFrame, 0);
  });
  mainWindow.on('focus', () => {
    setTimeout(forceRedrawFrame, 0);
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
      mainWindow.show();
      forceRedrawFrame();
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
  stopCursorTracking();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
