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
});
