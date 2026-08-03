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

// Windows 下透明窗需尽早开启，否则易出现黑底 / 标题栏残留
app.commandLine.appendSwitch('enable-transparent-visuals');

const WIN_W = 640;
const WIN_H = 640;

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;

/** 拖窗状态 */
let dragState = null;

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
          mainWindow.show();
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

  // 彻底去掉菜单，避免 Windows 画出标题栏区域
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    title: '',
    transparent: true,
    frame: false,
    thickFrame: false,
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
    // 再清一次，防止部分 Windows 版本恢复系统菜单
    mainWindow.setMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
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
  createWindow();
  createTray();
});

// 托盘常驻：所有窗口关闭后也不退出（由托盘「退出」结束进程）
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
