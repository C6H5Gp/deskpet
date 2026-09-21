/**
 * Electron 桌宠初始化：按包围盒缩放并贴齐窗口右下，避免角色往中间缩
 */
(function () {
  const FIT_PADDING = 16;

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
   * 按模型实际包围盒缩放，并贴齐窗口右下角（透明余量留在左上，便于探出屏幕贴齐桌面右下）
   */
  /**
   * 按模型实际包围盒缩放，并保证整只落在窗口内（右下对齐，禁止飞出窗外）。
   */
  /**
   * 按模型包围盒缩放到窗口内，右下对齐。不要改 anchor（会把 Live2D 变换搞飞）。
   */
  function fitModelToView(widget) {
    const model = widget && widget.model;
    const app = widget && widget.app;
    if (!model || !app) return false;

    const screenW = app.screen.width;
    const screenH = app.screen.height;
    const pad = FIT_PADDING;
    if (!(screenW > 0) || !(screenH > 0)) return false;

    // 用原始像素尺寸估缩放，避免错误 anchor / 脏 bounds
    let baseW = 0;
    let baseH = 0;
    try {
      if (model.internalModel && model.internalModel.width && model.internalModel.height) {
        baseW = model.internalModel.width;
        baseH = model.internalModel.height;
      }
    } catch (e) {
      // ignore
    }

    model.scale.set(1);
    try {
      if (typeof model.updateTransform === 'function') model.updateTransform();
    } catch (e) {
      // ignore
    }
    let b = model.getBounds(true);
    if (!(baseW > 1) || !(baseH > 1)) {
      if (!b || !(b.width > 1) || !(b.height > 1)) return false;
      baseW = b.width;
      baseH = b.height;
    }

    const scale = Math.min(
      (screenW - pad * 2) / baseW,
      (screenH - pad * 2) / baseH,
      1
    );
    if (!(scale > 0) || !Number.isFinite(scale)) return false;
    model.scale.set(scale);

    try {
      if (typeof model.updateTransform === 'function') model.updateTransform();
    } catch (e) {
      // ignore
    }
    b = model.getBounds(true);
    if (!b || !(b.width > 1) || !(b.height > 1)) return false;

    // 先居中，再推到右下，最后夹紧
    model.position.set(
      model.position.x + (screenW / 2 - (b.x + b.width / 2)),
      model.position.y + (screenH / 2 - (b.y + b.height / 2))
    );
    try {
      if (typeof model.updateTransform === 'function') model.updateTransform();
    } catch (e) {
      // ignore
    }
    b = model.getBounds(true);
    model.position.set(
      model.position.x + ((screenW - pad) - (b.x + b.width)),
      model.position.y + ((screenH - pad) - (b.y + b.height))
    );
    try {
      if (typeof model.updateTransform === 'function') model.updateTransform();
    } catch (e) {
      // ignore
    }
    b = model.getBounds(true);
    let dx = 0;
    let dy = 0;
    if (b.x < pad) dx += pad - b.x;
    if (b.y < pad) dy += pad - b.y;
    if (b.x + dx + b.width > screenW - pad) dx -= b.x + dx + b.width - (screenW - pad);
    if (b.y + dy + b.height > screenH - pad) dy -= b.y + dy + b.height - (screenH - pad);
    if (dx || dy) {
      model.position.set(model.position.x + dx, model.position.y + dy);
    }

    try {
      if (app.renderer && app.stage) app.renderer.render(app.stage);
    } catch (e) {
      // ignore
    }
    return true;
  }

  /** 纹理/包围盒可能晚几帧才就绪 */
  function fitModelToViewWithRetry(widget, attempt) {
    const n = attempt || 0;
    const ok = fitModelToView(widget);
    // 拟合成功后再上报，避免未缩放前的超大包围盒把整窗当成命中区
    if (ok) reportHitBounds(widget);
    if (ok || n >= 40) {
      if (!ok) reportHitBounds(widget);
      return;
    }
    setTimeout(() => fitModelToViewWithRetry(widget, n + 1), 100);
  }


  /**
   * 全屏视线跟踪：根据屏幕光标相对窗口中心更新 focusController
   * （点击穿透时窗口收不到 mousemove，必须用主进程光标）
   */
  function setupScreenTracking(widget) {
    const api = window.deskpet;
    if (!api || !api.onCursor) return;

    let boundsTick = 0;
    api.onCursor((payload) => {
      // 动作会微变包围盒，隔几帧同步一次即可
      if (boundsTick % 6 === 0) {
        reportHitBounds(widget);
      }
      boundsTick += 1;

      // 点击穿透由主进程按 hitBounds 切换 setIgnoreMouseEvents，渲染侧不调 setMouseIgnore

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
   * 把模型包围盒上报给主进程（拖动 / 动态点击穿透用）
   */
  function reportHitBounds(widget) {
    const api = window.deskpet;
    if (!api || !api.setHitBounds) return;
    const model = widget && widget.model;
    if (!model || typeof model.getBounds !== 'function') return;

    const bounds = model.getBounds(true);
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return;

    const PAD = 12; // 略扩命中，避免角色边缘点到空白穿透
    api.setHitBounds({
      x: bounds.x - PAD,
      y: bounds.y - PAD,
      width: Math.max(0, bounds.width + PAD * 2),
      height: Math.max(0, bounds.height + PAD * 2),
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
        fitModelToViewWithRetry(widget, 0);
        setupScreenTracking(widget);
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
