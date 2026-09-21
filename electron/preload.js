const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  /**
   * 上报角色命中包围盒（窗口客户区坐标）
   * @param {{ x:number, y:number, width:number, height:number }} bounds
   */
  setHitBounds: (bounds) => {
    ipcRenderer.send('pet:hit-bounds', bounds);
  },
  /**
   * 请求主进程设置鼠标忽略（点击穿透开启时）
   * @param {boolean} ignore
   */
  setMouseIgnore: (ignore) => {
    ipcRenderer.send('pet:mouse-ignore', !!ignore);
  },
  /**
   * 订阅全屏光标位置（主进程轮询，穿透时也能跟踪）
   * @param {(payload: {
   *   x:number,y:number,winX:number,winY:number,winW:number,winH:number,
   *   screenX:number,screenY:number,screenW:number,screenH:number
   * }) => void} callback
   * @returns {() => void} 取消订阅
   */
  onCursor: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pet:cursor', handler);
    return () => ipcRenderer.removeListener('pet:cursor', handler);
  },
  /**
   * 订阅全局键鼠（主进程 Win32 轮询）
   * @param {(payload: {
   *   type: 'enter' | 'type' | 'left' | 'right',
   *   at: number
   * }) => void} callback
   * @returns {() => void}
   */
  onInput: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pet:input', handler);
    return () => ipcRenderer.removeListener('pet:input', handler);
  },
  /**
   * 订阅托盘「点击穿透」开关
   * @param {(payload: { enabled: boolean }) => void} callback
   * @returns {() => void}
   */
  onClickThrough: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pet:click-through', handler);
    return () => ipcRenderer.removeListener('pet:click-through', handler);
  },
  /** @returns {Promise<boolean>} */
  getClickThrough: () => ipcRenderer.invoke('pet:get-click-through'),
});
