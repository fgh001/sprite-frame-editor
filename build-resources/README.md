# 打包资源目录

electron-builder 从这里取图标等打包素材（`electron-builder.yml` 里 `directories.buildResources: build-resources`）。

## 放什么

### `icon.ico`（Windows 应用图标，最需要的一个）

- **路径**：`build-resources/icon.ico`
- **格式**：`.ico`
- **尺寸**：至少 256×256；建议一个文件里包含多档：`256 / 128 / 64 / 48 / 32 / 24 / 16`
  （Windows 在不同位置会用不同档位：桌面大图标用 256，任务栏用 32，标题栏用 16）
- **文件名必须是 `icon.ico`** —— electron-builder 会自动在 buildResources 里找这个文件名，
  找到就用它做 exe 图标 + 任务栏图标；找不到就用 Electron 默认图标
  （打包日志里的 `default Electron icon is used` 就是没找到它）

### `icon.png`（可选，但建议留一份）

- 路径：`build-resources/icon.png`
- 尺寸：1024×1024 或 512×512
- 用途：① 设计稿备份；② 没有 ico 时 electron-builder 可以拿 png 自动转；
  ③ macOS 打包需要 `icon.icns`（同样放这个目录）

## 从 PNG 生成 ICO

有 ImageMagick 的话一条命令：

```powershell
magick icon.png -define icon:auto-resize=256,128,64,48,32,24,16 icon.ico
```

没有 ImageMagick 就用在线转换（搜 "png to ico multi size"），选输出包含 256/128/64/48/32/16。

## 设计建议

- 应用图标在 **16×16** 下也要能看出是什么，细节别太多
- 深色 / 浅色任务栏都要能看清 → 边缘留一圈浅色或深色的安全边
- 和界面风格统一的话，主色用界面的蓝 `#3b82f6`（深色主题）/ `#2563eb`（浅色主题）

## 放好之后

```powershell
npm run dist:win
```

exe 图标、任务栏图标、开始菜单图标都会自动换成你的。
产物位置：`build\windows\win-unpacked\SpriteFrameEditor.exe`
