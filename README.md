# 桌宠 (deskpet)

Windows 桌面 Live2D 桌宠。Electron 透明置顶窗口，支持点击穿透、拖动和系统托盘。

安装包**没有代码签名**。程序**不会**自己检查更新。

## 功能

- Live2D 角色（透明窗，置顶）
- **点击穿透默认开启**。新安装，或 `settings.json` 里没有 `clickThrough` 时为开；已经保存的 `false` 保持关闭
- 穿透开启时，整窗（含本体）把鼠标交给下层，并在光标周围约 70px 做径向透视：中心到大约一半半径全透，外圈较硬地回到不透明。关闭穿透后镂空马上消失，可以点击和拖动
- 托盘可切换显示/隐藏、点击穿透、开机自启
- **开机自启默认开启**。`npm start` 只把偏好记在用户数据里，不会写系统登录项；安装版或便携版 exe 才会调用系统的开机启动

## 安装

从 [Releases](https://github.com/C6H5Gp/deskpet/releases) 下载 Windows x64 包：

| 文件 | 说明 |
|------|------|
| `deskpet-<version>-win-x64.exe` | NSIS 安装包，可选安装目录，会建桌面和开始菜单快捷方式 |
| `deskpet-<version>-portable.exe` | 便携版 |
| `SHA256SUMS.txt` | 上面两个 exe 的 SHA-256 |

SmartScreen 可能提示未知发布者。这是未签名构建的正常现象，需要时选「仍要运行」。校验示例：

```bat
certutil -hashfile deskpet-<version>-win-x64.exe SHA256
```

对照 `SHA256SUMS.txt` 里同一文件名的那一行。

Release 里可能还有 `latest.yml` 和 `.blockmap`。那是 electron-builder 的产物，**当前程序没有接入 electron-updater，不会自动更新**。

## 环境

- Windows 10/11 x64
- 开发：Node.js 18 及以上，建议与 CI 一样用 22

## 开发

```bash
npm install
npm start
```

只预览静态页：

```bash
npm run web
```

发版脚本的回归（不打包 Electron）：

```bash
bash scripts/release.test.sh
```

## 打包

在 Windows 上：

```bash
npm run dist        # NSIS 安装包 + 便携版，输出到 dist/
npm run dist:dir    # 未打安装包的目录，便于本机替换 asar
```

本地文件名带中文产品名（`桌宠-…exe`）。GitHub Release 会改成 ASCII：`deskpet-<version>-win-x64.exe` 和 `deskpet-<version>-portable.exe`。

`signAndEditExecutable` 为 false，workflow 里关闭了证书自动发现。没有签名证书，也不要在仓库里放证书或密钥。

## CI

[![CI](https://github.com/C6H5Gp/deskpet/actions/workflows/ci.yml/badge.svg)](https://github.com/C6H5Gp/deskpet/actions/workflows/ci.yml)

推送到 `main` 以及针对 `main` 的 pull request 都会跑 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：

- `package`（`windows-latest`，Node 22）：`npm ci` 后执行 `electron-builder --win --dir`。只做打包冒烟，不出安装包，也不上传 Release
- `release-script`（`ubuntu-latest`）：跑 `scripts/release.test.sh`，检查发版脚本的版本决定，不构建 Electron

冒烟失败不会被发版 workflow 取消；发版有自己的完整 `electron-builder --win`。两条 workflow 互不替代。

## 发版

Actions：[CI](https://github.com/C6H5Gp/deskpet/actions/workflows/ci.yml) · [Release](https://github.com/C6H5Gp/deskpet/actions/workflows/release.yml) · [Releases](https://github.com/C6H5Gp/deskpet/releases)

### 以前为什么合并进 main 没有新 Release

v1.0.0 之后的功能已经在 `main` 上，但 `package.json` 仍是 `1.0.0`，远程也只有标签 `v1.0.0`。

- CI 在 `main` 上只做 `--dir` 冒烟，不改版本、不打标签、不上传安装包
- Release workflow 原先**只**在推送 `v*` 标签时构建并创建 GitHub Release
- 用默认 `GITHUB_TOKEN` 推上去的提交或标签**不会再触发**别的 workflow。所以即便另写一个任务只负责打标签，原来的标签任务也不会跟着跑

因此合并到 `main` 不会发布。这是 workflow 的触发条件造成的，不是某一次合并漏跑。

### 现在：推送到 main 会自动发一版

[`.github/workflows/release.yml`](.github/workflows/release.yml) 在**同一次运行**里完成：决定版本 → 构建 NSIS 和便携版 → 把版本号提交到 `main` → 推送附注标签 `vX.Y.Z` → 创建 GitHub Release。不依赖「标签推送再触发自己」。

规则：

- 默认 **patch**（`1.0.0` → `1.0.1`）
- 自上次 `v*` 标签以来，任一**提交说明**里有单独的标记时改级别（写在标题或正文都行；major 优先）：
  - `[release minor]`
  - `[release major]`
- 这些标记只看提交说明，不看文件内容
- 若 `package.json` 里的版本还没有对应标签，就发布这个版本，**不再加一档**
- 发版提交只改 `package.json` 和 `package-lock.json`，说明是 `chore: release vX.Y.Z [skip release]`。带跳过标记，避免这次推送再开一轮发版
- 短时间连续推送时，只有当前 `main` 尖端会发版。更早的运行如果发现自己已被包含，会成功跳过
- 构建在推送标签**之前**。构建失败不会留下新标签。若构建期间 `main` 又进了新提交，这次推送会放弃，由新提交的那次运行发版
- 查询 Release 失败（不是「找不到」）会中止，避免把新包覆盖到旧版本号上

提交说明里写上 `[skip release]` 可以跳过自动发版（例如只改文档）。

手动补发或指定级别：Actions → Release → Run workflow，选 `patch`、`minor` 或 `major`。若当前版本的标签已经在、但 GitHub Release 还没有，会补发而不会再跳一版。失败的运行可以重跑；若 `main` 上已经有更新的功能提交，重跑会跳过。

### 手动发版

自动发版就够用时，不要再手动切版本。需要指定 minor/major，或自动任务不可用时，在**最新的 `main`** 上、工作区干净时执行。下面两条命令与 `scripts/release.sh cut` 相同：

```bash
npm version patch -m "chore: release v%s [skip release]"
git push origin HEAD --follow-tags
```

`patch` 可换成 `minor` 或 `major`。有 bash 时也可以：

```bash
bash scripts/release.sh cut patch
```

提交说明里的 `[skip release]` 必须保留。否则这次推送到 `main` 会再自动加一版。标签推送走同一个 Release workflow，但**不改版本**，只构建并发布；标签名（去掉 `v`）必须等于该提交里的 `package.json` `version`。

`npm version` 会改 `package.json`、`package-lock.json`，并创建附注标签。

## 目录

| 路径 | 说明 |
|------|------|
| `electron/` | Electron 主进程 / preload |
| `deskpet/` | 渲染与桌宠逻辑 |
| `scripts/release.sh` | 版本决定、打标签、手动发版 |
| `docs/` | 过程记录（以本 README 为准） |
| `build/` | 打包资源 |

## 点击穿透

| 模式 | 行为 |
|------|------|
| 开启 | 整窗含本体都穿透，不能点、不能拖。光标周围约 70px 径向透视：中心一段全透，向外回到不透明 |
| 关闭 | 无镂空，可以点击和拖动 |

托盘里可以切换。安装版资源在 `%LocalAppData%\Programs\deskpet\resources\app.asar`。开发时改源码后要重新 `npm start`；改安装目录里的文件需要重新 `npm run dist` 或覆盖 asar。

## License

Private / personal project unless otherwise noted.
