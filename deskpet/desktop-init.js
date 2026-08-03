/**
 * Electron 桌宠初始化：放大画布、居中完整模型、窗口拖动
 */
(function () {
  const DRAG_THRESHOLD = 5;

  function fillContainer() {
    const container = document.getElementById('live2d-widget-container');
    const canvas = document.getElementById('live2d-widget-canvas');
    if (container) {
      container.style.cssText =
        'position:fixed;inset:0;left:0;right:0;bottom:0;width:100%;height:100%;z-index:1;pointer-events:none;user-select:none;';
    }
    if (canvas) {
      canvas.style.cssText =
        'width:100%;height:100%;pointer-events:auto;display:block;touch-action:none;cursor:grab;';
    }
  }

  /**
   * 在 LPKRender 自带拖动之上，改为拖 Electron 窗口；
   * 超过阈值才算拖动，避免误触动作。
   */
  function setupWindowDrag() {
    const api = window.deskpet;
    if (!api) return;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = Math.abs(e.screenX - startX);
      const dy = Math.abs(e.screenY - startY);
      if (!moved && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
        moved = true;
      }
      if (moved) {
        api.dragMove();
      }
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      api.endDrag();
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      // 发生拖动时吞掉 pointerup，避免 LPKRender 误播点击动作
      if (moved) {
        e.stopImmediatePropagation();
      }
    };

    document.addEventListener(
      'pointerdown',
      (e) => {
        const canvas = document.getElementById('live2d-widget-canvas');
        if (!canvas) return;
        if (e.target !== canvas && !canvas.contains(e.target)) return;
        if (e.button !== 0) return;

        dragging = true;
        moved = false;
        startX = e.screenX;
        startY = e.screenY;
        api.startDrag(e.clientX, e.clientY);
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
      },
      true
    );
  }

  function start() {
    if (typeof Live2DWidget === 'undefined' || !Live2DWidget.init) {
      console.error('Live2DWidget 未加载');
      return;
    }

    const w = window.innerWidth || 480;
    const h = window.innerHeight || 560;

    const widgetOptions = {
      lpkFile: './model/pet.lpk',
      width: w,
      height: h,
      position: 'right',
      bottom: 0,
      // 放大并居中，完整显示角色（解除原站半身裁切）
      scale: 0.4,
      modelX: 0.5,
      modelY: 0.5,
      modelYOffset: 0,
      mobileWidth: w,
      mobileHeight: h,
      mobileScale: 0.4,
      mobilePosition: 'right',
      mobileBottom: 0,
      mobileModelX: 0.5,
      mobileModelY: 0.5,
      mobileModelYOffset: 0,
      draggable: false,
      hitAreaMapping: {
        左手: '书',
        右手: '右耳',
        左耳: '左耳',
        右耳: '右耳',
        头: '生日帽',
        身体: '跟宠',
      },
      excludeMotions: ['Idle'],
      libUrls: {
        cubismCore: './libs/cubismcore.min.js',
        pixi: './libs/pixi.min.js',
        live2d: './libs/live2d.min.js',
        pixiLive2d: './libs/pixi-live2d-display.min.js',
        jszip: './libs/jszip.min.js',
      },
    };

    window.DESKPET_CONFIG = { options: widgetOptions };

    Live2DWidget.init(widgetOptions)
      .then(() => {
        fillContainer();
        setupWindowDrag();
      })
      .catch((err) => {
        console.error('桌宠初始化失败:', err);
      });
  }

  if (document.readyState === 'complete') {
    start();
  } else {
    window.addEventListener('load', start);
  }
})();
