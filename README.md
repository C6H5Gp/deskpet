# 桌宠 (deskpet)

Windows 桌面 Live2D 桌宠 —— Electron 透明置顶窗口，支持点击穿透、拖动与系统托盘。

## 功能

- Live2D 角色桌宠（透明窗 + 置顶）
- **点击穿透**（默认开启）：开启后整窗（含本体）鼠标穿透到下层，并在光标周围约 70px 径向透视桌面（中心全透至约一半半径，外圈较硬地回到不透明）；关闭后镂空立即消失，可正常点击/拖动
- 右键菜单 / 托盘控制
- 支持打包安装版与便携版（electron-builder）

## 环境

- Windows 10/11 x64
- Node.js 18+（建议 20/22）

## 开发运行

```bash
npm install
npm start
```

仅预览静态页：

```bash
npm run web
```

## 打包

```bash
npm run dist        # 安装包 + 便携版 → dist/
npm run dist:dir    # 未打包目录，便于本机热替换 asar
```

产物默认带中文 `productName`（`桌宠-…exe`）。GitHub Release 会改名为 ASCII：`deskpet-<version>-win-x64.exe` / `deskpet-<version>-portable.exe`。

## CI/CD

[![CI](https://github.com/C6H5Gp/deskpet/actions/workflows/ci.yml/badge.svg)](https://github.com/C6H5Gp/deskpet/actions/workflows/ci.yml)

- **CI**（`push` / `pull_request` → `main`）：`windows-latest` + Node 22，`npm ci` 后执行 `electron-builder --win --dir` 打包冒烟检查（只出未打包目录，不上传安装包）。
- **Release**（推送 `v*` 标签）：完整 `electron-builder --win`，创建/更新 [GitHub Release](https://github.com/C6H5Gp/deskpet/releases)，上传 NSIS + 便携 exe、`.blockmap`、`latest.yml`、`SHA256SUMS.txt`。构建未签名，SmartScreen 可能拦截。

发布新版本（标签版本须与 `package.json` 的 `version` 一致）：

```bash
git tag v1.0.1
git push origin v1.0.1
```

- [Actions](https://github.com/C6H5Gp/deskpet/actions)
- [Releases](https://github.com/C6H5Gp/deskpet/releases)

## 目录

| 路径 | 说明 |
|------|------|
| `electron/` | Electron 主进程 / preload |
| `deskpet/` | 渲染与桌宠逻辑 |
| `docs/` | 进度与说明 |
| `build/` | 打包资源 |

## 点击穿透说明

新安装或 `settings.json` 中没有 `clickThrough` 时默认开启。托盘可切换；已保存的 `false` 保持关闭。

| 模式 | 行为 |
|------|------|
| 开启穿透 | 整窗含本体均穿透，不能点不能拖。光标周围约 70px 径向透视下层：中心全透至约一半半径，外圈较硬地回到不透明 |
| 关闭穿透 | 无镂空，正常点击与拖动 |

安装版资源在 `Local\Programs\deskpet\resources\app.asar`；开发时改源码后需重新 `dist` 或覆盖 asar 才进安装目录。

## License

Private / personal project unless otherwise noted.
