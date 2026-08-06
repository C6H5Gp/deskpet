/**
 * Electron 桌宠初始化：按包围盒自动居中缩放，避免偏位与裁切
 */
(function () {
  const DRAG_THRESHOLD = 5;
  const FIT_PADDING = 24;

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
   * 按模型实际包围盒缩放并居中，消除锚点偏移导致的裁切
   */
  function fitModelToView(widget) {
    const model = widget && widget.model;
    const app = widget && widget.app;
    if (!model || !app) return;

    const screenW = app.screen.width;
    const screenH = app.screen.height;
    const pad = FIT_PADDING;

    model.anchor.set(0.5, 0.5);
    model.scale.set(1);
    model.position.set(screenW / 2, screenH / 2);

    const bounds1 = model.getBounds(true);
    if (!bounds1.width || !bounds1.height) return;

    const scale = Math.min(
      (screenW - pad * 2) / bounds1.width,
      (screenH - pad * 2) / bounds1.height
    );
    model.scale.set(scale);

    const bounds2 = model.getBounds(true);
    model.x += screenW / 2 - (bounds2.x + bounds2.width / 2);
    model.y += screenH / 2 - (bounds2.y + bounds2.height / 2);
  }

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

  /**
   * 全屏视线跟踪：根据屏幕光标相对窗口中心更新 focusController
   * （点击穿透时窗口收不到 mousemove，必须用主进程光标）
   */
  function setupScreenTracking(widget) {
    const api = window.deskpet;
    if (!api || !api.onCursor) return;

    api.onCursor((payload) => {
      const model = widget && widget.model;
      const focus =
        model &&
        model.internalModel &&
        model.internalModel.focusController;
      if (!focus || typeof focus.focus !== 'function') return;

      const cx = payload.winX + payload.winW / 2;
      const cy = payload.winY + payload.winH / 2;
      // 以当前显示器宽高的一半为满偏量，鼠标到屏边即看向极限
      const rangeX = Math.max(payload.screenW / 2, 1);
      const rangeY = Math.max(payload.screenH / 2, 1);
      let fx = (payload.x - cx) / rangeX;
      let fy = (payload.y - cy) / rangeY;
      fx = Math.max(-1, Math.min(1, fx));
      fy = Math.max(-1, Math.min(1, fy));
      // Live2D 垂直方向与屏幕相反
      focus.focus(fx, -fy);
    });
  }

  /**
   * Windows 透明窗：仅在光标悬停角色包围盒时关闭穿透，空白区域保持可点穿。
   * 依赖主进程光标轮询，不依赖 DOM mousemove。
   */
  function setupMouseHit(widget) {
    const api = window.deskpet;
    if (!api || !api.onCursor || !api.setMouseIgnore) return;

    let clickThrough = false;
    let lastIgnore = null;
    let pointerDown = false;
    // 包围盒略收缩，减少透明边角误捕获
    const PAD = 8;

    const endPointer = () => {
      pointerDown = false;
    };
    window.addEventListener('pointerdown', () => {
      pointerDown = true;
    }, true);
    window.addEventListener('pointerup', endPointer, true);
    window.addEventListener('pointercancel', endPointer, true);

    if (api.getClickThrough) {
      api.getClickThrough().then((enabled) => {
        clickThrough = !!enabled;
        lastIgnore = null;
        if (clickThrough) {
          api.setMouseIgnore(true);
          lastIgnore = true;
        }
      });
    }

    if (api.onClickThrough) {
      api.onClickThrough((payload) => {
        clickThrough = !!(payload && payload.enabled);
        lastIgnore = null;
        if (clickThrough) {
          api.setMouseIgnore(true);
          lastIgnore = true;
        }
      });
    }

    api.onCursor((payload) => {
      if (clickThrough) {
        if (lastIgnore !== true) {
          api.setMouseIgnore(true);
          lastIgnore = true;
        }
        return;
      }

      // 拖动中保持捕获，避免移出包围盒后突然穿透导致拖不动
      if (pointerDown) {
        if (lastIgnore !== false) {
          api.setMouseIgnore(false);
          lastIgnore = false;
        }
        return;
      }

      const model = widget && widget.model;
      if (!model || typeof model.getBounds !== 'function') return;

      const lx = payload.x - payload.winX;
      const ly = payload.y - payload.winY;
      if (
        lx < 0 ||
        ly < 0 ||
        lx > payload.winW ||
        ly > payload.winH
      ) {
        if (lastIgnore !== true) {
          api.setMouseIgnore(true);
          lastIgnore = true;
        }
        return;
      }

      const bounds = model.getBounds(true);
      const over =
        bounds &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        lx >= bounds.x + PAD &&
        lx <= bounds.x + bounds.width - PAD &&
        ly >= bounds.y + PAD &&
        ly <= bounds.y + bounds.height - PAD;

      const ignore = !over;
      if (ignore !== lastIgnore) {
        api.setMouseIgnore(ignore);
        lastIgnore = ignore;
      }
    });
  }

  /**
   * 在动作组中按名称片段查找索引
   * @param {Record<string, Array<{ Name?: string }>>} groups
   * @param {string} group
   * @param {string} namePart
   * @returns {number}
   */
  function findMotionIndex(groups, group, namePart) {
    const list = groups && groups[group];
    if (!Array.isArray(list)) return -1;
    return list.findIndex((m) => (m && m.Name ? m.Name : '').includes(namePart));
  }

  /**
   * 全局键鼠 → 播放「桌面」组动作
   * 打字→按键1/2/3，回车→回车，鼠标左键→右、右键→左
   */
  function setupInputReaction(widget) {
    const api = window.deskpet;
    if (!api || !api.onInput || !widget) return;

    const group = '桌面';
    const keyNames = ['按键1', '按键2', '按键3'];
    let keyIndices = null;
    let enterIndex = -1;
    let leftIndex = -1;
    let rightIndex = -1;

    function ensureIndices() {
      if (keyIndices) return;
      const groups = widget.motionGroups || {};
      keyIndices = keyNames
        .map((n) => findMotionIndex(groups, group, n))
        .filter((i) => i >= 0);
      enterIndex = findMotionIndex(groups, group, '回车');
      leftIndex = findMotionIndex(groups, group, '/左.motion3');
      rightIndex = findMotionIndex(groups, group, '/右.motion3');
      if (leftIndex < 0) leftIndex = findMotionIndex(groups, group, '左');
      if (rightIndex < 0) rightIndex = findMotionIndex(groups, group, '右');
    }

    api.onInput((payload) => {
      ensureIndices();
      if (!widget.playMotion || !payload) return;

      if (payload.type === 'enter') {
        if (enterIndex >= 0) widget.playMotion(group, enterIndex);
        return;
      }

      if (payload.type === 'left') {
        if (leftIndex >= 0) widget.playMotion(group, leftIndex);
        return;
      }

      if (payload.type === 'right') {
        if (rightIndex >= 0) widget.playMotion(group, rightIndex);
        return;
      }

      if (payload.type === 'type' && keyIndices && keyIndices.length) {
        const idx = keyIndices[Math.floor(Math.random() * keyIndices.length)];
        widget.playMotion(group, idx);
      }
    });
  }

  function start() {
    if (typeof Live2DWidget === 'undefined' || !Live2DWidget.init) {
      console.error('Live2DWidget 未加载');
      return;
    }

    const w = window.innerWidth || 640;
    const h = window.innerHeight || 640;

    const widgetOptions = {
      lpkFile: './model/pet.lpk',
      width: w,
      height: h,
      position: 'right',
      bottom: 0,
      // 初始 scale 仅占位，加载后由 fitModelToView 覆盖
      scale: 0.25,
      modelX: 0.5,
      modelY: 0.5,
      modelYOffset: 0,
      mobileWidth: w,
      mobileHeight: h,
      mobileScale: 0.25,
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
      .then((widget) => {
        fillContainer();
        // 等一帧再测量，确保纹理与 bounds 就绪
        requestAnimationFrame(() => {
          fitModelToView(widget);
          requestAnimationFrame(() => fitModelToView(widget));
        });
        setupWindowDrag();
        setupScreenTracking(widget);
        setupMouseHit(widget);
        setupInputReaction(widget);
        window.__deskpetWidget = widget;
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
