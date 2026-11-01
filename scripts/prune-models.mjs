/**
 * 打包后清理产物里的 data/models，只保留随包发布的 3 个模型。
 *
 * 为什么要这一步：源目录 data/models 里放全部模型方便开发时对比测试，
 * 但整个目录会 3 GB 左右，跟着安装包走太占空间。发布版只带选定的几个。
 *
 * 发布版保留：
 *   u2net.onnx               168 MB  rembg 默认模型，320 输入，最快
 *   birefnet-lite-512.onnx   183 MB  轻量 BiRefNet，512 输入
 *   birefnet-general.onnx    928 MB  官方同款 BiRefNet，1024 输入，最准
 *
 * 用法：node scripts/prune-models.mjs [平台目录名]
 * 默认平台目录：windows-x64 → 产物 build/windows-x64/SpriteFrameEditor-win64
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const platform = process.argv[2] ?? 'windows-x64';

/** 随包发布的模型文件名（相对 data/models） */
const KEEP = [
  // u2net：rembg 默认模型，320 输入，最快（约 2 秒/张），必带
  'u2net.onnx',
  // isnet-general-use：rembg 通用模型，约 5 秒/张，抠人像/产品比 u2net 干净，必带
  'isnet-general-use.onnx',
  // 中间档：BiRefNet 官方 lite（bb_swin_v1_tiny），1024 输入，实测约 13 秒/张。
  // 不用 birefnet-lite-512.onnx 的原因：那是 512 输入的第三方导出，
  // rembg 的模型名表里没有它，发布版里选了会直接报 Unknown model（等于摆设）。
  'birefnet-general-lite.onnx',
  // 最强档：BiRefNet 官方原版（fp32 1024），约 80 秒/张，必带
  'birefnet-general.onnx',
];

/** 找到产物根目录：优先按约定路径，找不到就扫含 exe 的那一层 */
function resolveAppDir() {
  const base = path.join(projectRoot, 'build', platform);
  const expected = path.join(base, 'SpriteFrameEditor-win64');
  if (fs.existsSync(expected)) return expected;

  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    if (fs.existsSync(path.join(dir, 'SpriteFrameEditor.exe'))) return dir;
  }
  return null;
}

const appDir = resolveAppDir();
if (!appDir) {
  console.error(`[prune] 找不到打包产物：build/${platform}/SpriteFrameEditor-win64`);
  console.error('[prune] 先跑 npm run dist:win');
  process.exit(1);
}

const modelsDir = path.join(appDir, 'data', 'models');
if (!fs.existsSync(modelsDir)) {
  console.error(`[prune] 产物里没有模型目录：${modelsDir}`);
  process.exit(1);
}

let removed = 0;
let freed = 0;
const kept = [];

for (const entry of fs.readdirSync(modelsDir, { withFileTypes: true })) {
  const abs = path.join(modelsDir, entry.name);

  if (entry.isDirectory()) {
    fs.rmSync(abs, { recursive: true, force: true });
    removed += 1;
    continue;
  }

  if (!KEEP.includes(entry.name)) {
    freed += fs.statSync(abs).size;
    fs.rmSync(abs, { force: true });
    removed += 1;
    continue;
  }

  kept.push({ name: entry.name, bytes: fs.statSync(abs).size });
}

const missing = KEEP.filter((name) => !kept.some((item) => item.name === name));
const total = kept.reduce((sum, item) => sum + item.bytes, 0);

console.log(`[prune] 产物模型目录：${modelsDir}`);
console.log(`[prune] 保留 ${kept.length} 个模型，共 ${(total / 1024 / 1024).toFixed(0)} MB：`);
for (const item of kept.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`        ${(item.bytes / 1024 / 1024).toFixed(0).padStart(5)} MB  ${item.name}`);
}
console.log(`[prune] 删除 ${removed} 项，省下 ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB`);

if (missing.length > 0) {
  console.error(`[prune] ⚠ 源 data/models 里缺少：${missing.join('、')}`);
  console.error('[prune] 这些模型没被打进包里，界面上对应档位会显示「未下载」');
  process.exit(1);
}
