"""
一张源图 → 两处产物：Windows 的 icon.ico + 界面的 logo.png。

为什么要这一步：
  electron-builder 自带的 png→ico 转换（icon-tool.js）在 Node 24 上退出时会崩
  （0xC0000005），虽然 ico 转出来了但整个打包判定失败。所以打包前用这里的
  Pillow 自己转，electron-builder 拿到现成的 .ico 就不会再调用那个脚本。

产物：
  build-resources/icon.ico   ← exe 图标（7 个尺寸，打包时写进 PE 资源段）
  src/assets/logo.png        ← 界面侧边栏头像（256×256，Vite 打进 bundle）

规则：
  - 源图不是正方形 → 居中裁成正方形
  - 源图小于 256 → 放大到 256（ICO 最大只支持 256）
  - ICO 输出 7 个尺寸：16 / 24 / 32 / 48 / 64 / 128 / 256
    （16 用于标题栏、32 任务栏、256 桌面大图标）

用法（由 npm run icon 调用，dist:win 会自动先跑它）：
  pyshim/python.exe scripts/make_ico.py
"""
import os
import sys

from PIL import Image

SRC = 'build-resources/icon.png'
ICO_DST = 'build-resources/icon.ico'
LOGO_DST = 'src/assets/logo.png'
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
LOGO_SIZE = 256


def main() -> int:
    if not os.path.exists(SRC):
        if os.path.exists(ICO_DST):
            print(f'[icon] 没有 {SRC}，沿用现有的 {ICO_DST} 和 {LOGO_DST}')
        else:
            print(f'[icon] 找不到 {SRC}，也没有 {ICO_DST}，跳过（将使用 Electron 默认图标）')
        return 0

    image = Image.open(SRC).convert('RGBA')
    width, height = image.size

    if width != height:
        side = min(width, height)
        left = (width - side) // 2
        top = (height - side) // 2
        image = image.crop((left, top, left + side, top + side))
        print(f'[icon] 源图不是正方形（{width}×{height}），已居中裁成 {side}×{side}')

    if image.size[0] < 256:
        print(f'[icon] 源图只有 {image.size[0]}px，放大到 256×256')
        image = image.resize((256, 256), Image.LANCZOS)

    # ① exe 图标：7 个尺寸打进一个 .ico
    image.save(ICO_DST, sizes=SIZES)
    size_kb = max(1, os.path.getsize(ICO_DST) // 1024)
    print(f'[icon] exe 图标   → {ICO_DST}（{len(SIZES)} 个尺寸，{size_kb} KB）')

    # ② 界面头像：同一张图缩到 256×256
    os.makedirs(os.path.dirname(LOGO_DST), exist_ok=True)
    image.resize((LOGO_SIZE, LOGO_SIZE), Image.LANCZOS).save(LOGO_DST, optimize=True)
    logo_kb = max(1, os.path.getsize(LOGO_DST) // 1024)
    print(f'[icon] 界面头像   → {LOGO_DST}（{LOGO_SIZE}×{LOGO_SIZE}，{logo_kb} KB）')

    return 0


if __name__ == '__main__':
    sys.exit(main())
