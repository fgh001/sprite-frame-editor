/**
 * 打包前清理平台输出目录。
 *
 * 为什么必须清：
 *   electron-builder 的 dir target 在 appOutDir（build/<平台>/win-unpacked）**已存在**时，
 *   会复用它里面的 exe，不再重新解压 electron、也不重新写图标资源。
 *   结果就是「明明换了图标、重新打包了，exe 里还是旧图标」——
 *   只要上一次打包中途失败（比如改名被 Defender 锁住 EPERM），win-unpacked 就会残留下来，
 *   后续每次打包都踩这个坑。
 *
 * 用法（dist:win / dist:win:only 会自动在 electron-builder 之前调用）：
 *   node scripts/clean-dist.mjs windows-x64
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const platformTag = process.argv[2] || 'windows-x64';
const target = path.join(root, 'build', platformTag);

if (!fs.existsSync(target)) {
  console.log(`[clean] build/${platformTag} 不存在，无需清理`);
  process.exit(0);
}

try {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[clean] 已删除 build/${platformTag}（保证这次是从零构建）`);
} catch (err) {
  console.error(`[clean] 删除失败：build/${platformTag}`);
  console.error(`[clean] ${err instanceof Error ? err.message : String(err)}`);
  console.error('[clean] 通常是有进程正在运行里面的 exe，先关掉再打包');
  process.exit(1);
}
