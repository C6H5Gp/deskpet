/**
 * 原站内联脚本（整理换行，逻辑未改）
 * 来源：https://blog.xyy.world/
 */
window.addEventListener('load', function () {
  setTimeout(function () {
    (function () {
      const originalFetch = window.fetch;
      window.fetch = function (input, init = {}) {
        if (typeof input === 'string' && input.includes('bcmcdn.com')) {
          init.referrerPolicy = 'no-referrer';
          init.credentials = 'omit';
        }
        return originalFetch.apply(this, [input, init]);
      };
    })();

    const lpkPart1 =
      'aHR0cHM6Ly9jZG4tY29tbXVuaXR5LmJjbWNkbi5jb20vNDcvY29tbXVuaXR5L2QyVmlYek13TU';
    const lpkPart2 =
      'RGZk9EQXhPVGt6T1RZNVh6QmZNVGMzTVRZNE5Ea3dOVFEyTjE4MU1HRmhOakkxTXcuanBlZw==';

    function decryptUrl(p1, p2) {
      try {
        return atob(p1 + p2);
      } catch (e) {
        console.error('解密失败:', e);
        return null;
      }
    }

    const lpkUrl = decryptUrl(lpkPart1, lpkPart2);
    if (!lpkUrl) return;

    const lazyLoader = {
      js: function (src, callback, noRef = false) {
        if (!noRef) {
          const s = document.createElement('script');
          s.src = src.trim();
          s.onload = callback;
          document.head.appendChild(s);
        } else {
          fetch(src.trim(), { referrerPolicy: 'no-referrer' })
            .then((r) => r.text())
            .then((code) => {
              const fn = new Function('cb', code + '\ncb&&cb();');
              fn(callback);
            })
            .catch(() => {
              const s = document.createElement('script');
              s.src = src.trim();
              s.onload = callback;
              document.head.appendChild(s);
            });
        }
      },
      css: function (href, noRef = false) {
        if (!noRef) {
          const l = document.createElement('link');
          l.rel = 'stylesheet';
          l.href = href.trim();
          document.head.appendChild(l);
        } else {
          fetch(href.trim(), { referrerPolicy: 'no-referrer' })
            .then((r) => r.text())
            .then((css) => {
              const style = document.createElement('style');
              style.textContent = css;
              document.head.appendChild(style);
            });
        }
      },
    };

    lazyLoader.js(
      '/r-file/cdn/lpkr.min.js?v=1.35',
      function () {
        if (typeof Live2DWidget !== 'undefined' && Live2DWidget.init) {
          setTimeout(function () {
            Live2DWidget.init({
              lpkFile: lpkUrl,
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
                cubismCore: '/r-file/cdn/cubismcore.min.js',
                pixi: '/r-file/cdn/pixi.min.js',
                live2d: '/r-file/cdn/live2d.min.js',
              },
            });
          }, 3500);
        }
      },
      false
    );

    // 以下为原站其它懒加载（与桌宠无关，保留备查）
    lazyLoader.js('https://eoblog.xyy.world/r-file/delay.min.js?v=1.35', null, false);
    lazyLoader.css('https://eoblog.xyy.world/r-file/delay.min.css?v=1.35', false);
    lazyLoader.js('/r-file/input-with-fire.js?v=1.35', null, false);
  }, 50);
});
