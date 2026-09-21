# 桌宠进度

更新：2026-09-21 23:15 Asia/Shanghai

## 点击穿透（验收通过）

- **开穿透**：整窗（含本体）都穿，点击落到下层窗口
- **关穿透**：正常点击 / 拖动本体
- **验收**：用户 ook 通过（2026-09-21）
- **落点**：
  - 工作区热修：`desktop-init.js` / `electron/main.js` / `preload.js`（`F:\桌宠`）
  - 安装版 asar 已热修：`%LocalAppData%\Programs\deskpet\resources\app.asar`（约 22:09）
  - 备份：`_hotfix_backup\clickthrough-full-20260921220913`
- **备注**：尚未 git commit；后续穿透 / 窗口归属前端

## 下一步

- 需要时再补 `GROK_BOT_PARITY.md` 骨架；穿透语义变更请同步本文件
