/**
 * 从 https://blog.xyy.world/ 提取的桌宠初始化逻辑
 * 基于 LPKRender (https://github.com/cheezhi/LPKRender)
 *
 * 原站将 LPK 模型 URL 拆成两段 Base64，并拦截 bcmcdn 请求以去掉 referrer。
 */

(function () {
  // 原站对 B 站社区 CDN 去 referrer，避免防盗链拦截
  const originalFetch = window.fetch;
  window.fetch = function (input, init = {}) {
    if (typeof input === 'string' && input.includes('bcmcdn.com')) {
      init.referrerPolicy = 'no-referrer';
      init.credentials = 'omit';
    }
    return originalFetch.apply(this, [input, init]);
  };

  /**
   * 原站混淆后的模型地址（两段 Base64 拼接后 atob）
   * 解码结果：
   * https://cdn-community.bcmcdn.com/47/community/d2ViXzMwMDFfODAxOTkzOTY5XzBfMTc3MTY4NDkwNTQ2N181MGFhNjI1Mw.jpeg
   * （实际是 LPK/ZIP 包，扩展名伪装成 jpeg）
   */
  const LPK_REMOTE_URL =
    'https://cdn-community.bcmcdn.com/47/community/d2ViXzMwMDFfODAxOTkzOTY5XzBfMTc3MTY4NDkwNTQ2N181MGFhNjI1Mw.jpeg';

  // 路径相对站点根目录（index.html）；也可改回 LPK_REMOTE_URL
  const lpkFile = './deskpet/model/pet.lpk';

  /** 原站 Live2DWidget.init 参数（原样保留） */
  const widgetOptions = {
    lpkFile,
    width: 200,
    height: 220,
    position: 'right',
    bottom: 0,
    scale: 0.2,
    modelX: 0.8,
    modelY: 0.01,
    modelYOffset: 110,
    mobileWidth: 150,
    mobileHeight: 150,
    mobileScale: 0.15,
    mobilePosition: 'right',
    mobileBottom: 0,
    mobileModelX: 0.8,
    mobileModelY: 0.01,
    mobileModelYOffset: 0,
    // 点击命中区 → 动作组名映射
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
      cubismCore: './deskpet/libs/cubismcore.min.js',
      pixi: './deskpet/libs/pixi.min.js',
      live2d: './deskpet/libs/live2d.min.js',
      pixiLive2d: './deskpet/libs/pixi-live2d-display.min.js',
      jszip: './deskpet/libs/jszip.min.js',
    },
  };

  function start() {
    if (typeof Live2DWidget === 'undefined' || !Live2DWidget.init) {
      console.error('Live2DWidget 未加载，请确认 lpkr.min.js 已引入');
      return;
    }
    Live2DWidget.init(widgetOptions).catch(function (err) {
      console.error('桌宠初始化失败:', err);
    });
  }

  // 暴露配置，方便调试
  window.DESKPET_CONFIG = {
    remoteLpkUrl: LPK_REMOTE_URL,
    options: widgetOptions,
  };

  if (document.readyState === 'complete') {
    start();
  } else {
    window.addEventListener('load', start);
  }
})();
