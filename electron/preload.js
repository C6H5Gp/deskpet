const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  /** 开始拖动窗口（传入按下时相对窗口的偏移） */
  startDrag: (offsetX, offsetY) => {
    ipcRenderer.send('pet:start-drag', { offsetX, offsetY });
  },
  /** 拖动中更新窗口位置 */
  dragMove: () => {
    ipcRenderer.send('pet:drag-move');
  },
  /** 结束拖动 */
  endDrag: () => {
    ipcRenderer.send('pet:end-drag');
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
  /**
   * 请求主进程切换鼠标穿透（仅在点击穿透关闭时生效）
   * @param {boolean} ignore
   */
  setMouseIgnore: (ignore) => {
    ipcRenderer.send('pet:mouse-ignore', !!ignore);
  },
});
