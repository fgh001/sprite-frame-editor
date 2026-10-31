# 精灵帧动画编辑器 · Sprite Frame Editor

一个本地运行的 2D 精灵动画流水线工具：**AI 图片 → 无缝循环视频 → 抽帧 → 批量抠图 → 循环裁剪 → 导出帧序列**。

面向做 2D 游戏美术 / 独立开发的人，把「生成素材、抽帧、扣背景、修循环」这几步原本要在多个软件里来回倒的活，串成一条能重复跑的流水线。

> 所有数据都在本地 `data/` 目录里，删掉这个目录就彻底清理，不会在系统其他位置留残留。

---

## 功能

| 阶段 | 做什么 | 用到的模型 |
|---|---|---|
| **图像生成** | 文生图出素材，强制纯色背景（方便后续抠图），结果可直接进素材库 | 任意 OpenAI 兼容图像接口（豆包 Seedream / gpt-image 等） |
| **循环视频** | 一张图 → 首尾帧相同的无缝循环短视频 | 豆包 Seedance |
| **帧动画** | 视频抽帧成 PNG 序列，支持框选只抽角色区域、按时间区间抽 | 本地 FFmpeg / Canvas，不消耗 API |
| **批量抠图** | 整组帧一键去背景，四条路线：BiRefNet(ONNX) / ISNet / 官方 rembg / 传统色键 | 全部本地推理 |
| **找循环帧** | 自动识别最小循环周期，裁掉尾部多余帧，可缩成 1 个循环 | 本地算法（RGB 指纹 + 多帧窗口比对） |
| **素材库** | 图片 / 视频集中管理，标签、备注、AI 参考标记 | — |
| **模型设置** | 按能力槽位接入：文本 / 图像 / 视频，Key 用系统 DPAPI 加密存储 | — |
| **AI 助手** | 右侧问答窗口，走文本槽位模型（快捷键 `Ctrl+K`） | 任意文本模型 |

---

## 快速开始

```bash
# 1. 装依赖（Node 20+，推荐 22/24）
npm install

# 2. 开发模式（Vite 热更新 + Electron）
npm run dev

# 3. 类型检查
npm run typecheck
```

### 打包 Windows 版

```bash
npm run dist:win
```

产物：`build/windows-x64/SpriteFrameEditor-win64/SpriteFrameEditor.exe`
（免安装绿色版，整个文件夹拷走就能用，`data/` 跟着走）

### 换应用图标

只需要维护**一张图**：

```
build-resources/icon.png     ← 换成你的图（正方形，≥256，1024 最佳）
```

打包时会自动生成：
- `build-resources/icon.ico` → 写进 exe 资源（资源管理器 / 任务栏图标）
- `src/assets/logo.png` → 界面侧边栏头像

---

## 目录结构

```
├── electron/              主进程
│   ├── main.ts            窗口 / 生命周期 / 单实例锁
│   ├── preload.ts         唯一通道（contextBridge，白名单 API）
│   ├── core/              数据目录、设置存储、帧项目管理、素材库
│   ├── ipc/               各域 IPC handler
│   └── services/          AI 调用、抠图（BiRefNet/ISNet/rembg/色键）、循环裁剪
├── src/                   渲染层（React）
│   ├── pages/             八个页面
│   ├── components/        编辑器、播放器、裁剪窗口、侧边栏
│   └── theme.css          全部配色令牌（深色 / 浅色两套）
├── shared/                主进程与渲染层共享的 IPC 契约
├── scripts/               构建 / 打包 / 图标生成
├── build-resources/       打包素材（icon.png 是你唯一要改的）
└── data/                  运行时数据（不入库，见下）
```

## 数据目录（便携）

首次运行会在 exe 同级创建：

```
data/
├── config/        模型服务商与 API Key（DPAPI 加密，换机器需重新填）
├── knowledge/     素材库原图 / 视频 + 缩略图
├── frames/        sources/（抽帧集合） + outputs/（抠图结果）
├── models/        本地 ONNX 权重（BiRefNet 等）
├── cache/         可随时删除的缓存
└── logs/
```

> ⚠️ API Key 用 Windows DPAPI 加密，**绑定当前用户 + 这台机器**。把 `data/` 拷到别的电脑 Key 会解不开，需要重新填。

---

## 关于 `pyshim/`（不入库）

「批量抠图」里的 **官方 rembg** 路线依赖项目内的便携 Python：

```
pyshim/python.exe        Python 3.11 embeddable
pyshim/Lib/site-packages rembg + onnxruntime
```

它 **没有纳入 Git**（515 MB，会导致仓库急剧膨胀）。要让 rembg 抠图可用，需要自己准备：

1. 下载 [Python 3.11 embeddable](https://www.python.org/downloads/windows/)，解压到 `pyshim/`
2. 启用 pip（编辑 `pyshim/python311._pth`，取消 `import site` 的注释）
3. 安装依赖：
   ```powershell
   .\pyshim\python.exe -m pip install rembg onnxruntime
   ```

**不装也能用**：批量抠图还有 BiRefNet（纯 ONNX）、ISNet、传统色键三条路，都不需要 Python。

---

## 技术栈

- **Electron 45** + **React 19** + **Vite 6** + **TypeScript 5.7**
- 主进程用 esbuild 打包（`dist-electron/`），渲染层用 Vite
- 抠图推理：`onnxruntime-node`（BiRefNet 多模型）、`@imgly/background-removal-node`（ISNet）、rembg（Python 子进程）
- 打包：`electron-builder`（`dir` target，输出绿色版目录）

---

## 已知限制

- 只做了 Windows 打包（改 `electron-builder.yml` 的 `directories.output` 和 `win.target` 可扩到 mac / linux）
- 视频抽帧依赖 Chromium 的解码能力，HEVC/H.265 可能读不了，建议 H.264
- 没有代码签名证书，首次运行 Windows 会弹「未知发布者」

---

## License

[MIT](LICENSE)
