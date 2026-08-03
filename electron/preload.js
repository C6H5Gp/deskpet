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
});
