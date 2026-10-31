/**
 * 打包收尾：整理 electron-builder 的产物目录。
 *
 * 目标结构（按「平台-架构」分，互不覆盖）：
 *
 *   build/
 *   ├── windows-x64/
 *   │   └── SpriteFrameEditor-win64/     ← 双击里面的 exe
 *   ├── windows-ia32/                    ← 以后打 32 位会落在自己目录
 *   └── linux-x64/
 *
 * 用法（由 npm script 传入平台标签，默认 windows-x64）：
 *   node scripts/package-dir.mjs windows-x64
 *
 * 同一磁盘内 rename 是瞬时的（不是复制 4.8 GB），不额外花时间。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** 项目名：优先 productName（和 exe 文件名一致），退回 package name */
const projectName = pkg.productName || pkg.name || 'app';

/** 平台标签：windows-x64 / windows-ia32 / linux-x64 …，对应 build/ 下的子目录 */
const platformTag = process.argv[2] || 'windows-x64';

/** 包体名后缀：x64 → win64，ia32 → win32，其余按原样（linux-x64 → linux-x64） */
const archLabel = (() => {
  const part = platformTag.split('-')[1] || '';
  if (part === 'x64') return platformTag.startsWith('windows') ? 'win64' : 'x64';
  if (part === 'ia32') return 'win32';
  return part || platformTag;
})();

const baseDir = path.join(root, 'build', platformTag);
const folders = {
  src: path.join(baseDir, 'win-unpacked'),
  dest: path.join(baseDir, `${projectName}-${archLabel}`),
};

if (!fs.existsSync(folders.src)) {
  console.error(`[pack] 没找到 ${folders.src}`);
  console.error(`[pack] 先跑 electron-builder（输出目录应为 build/${platformTag}），再执行本脚本`);
  process.exit(1);
}

// 上一次的产物先删掉；如果里面的 exe 还开着会删不掉，给出可读提示
try {
  fs.rmSync(folders.dest, { recursive: true, force: true });
} catch (err) {
  console.error(`[pack] 无法删除旧产物 ${folders.dest}`);
  console.error('[pack] 可能有进程正在运行它，先关掉再重试');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

try {
  fs.renameSync(folders.src, folders.dest);
} catch (err) {
  /* Windows 上刚生成的 exe 经常被 Windows Defender / 索引服务短暂锁住，
     renameSync 会直接 EPERM。这时退回 robocopy /MOVE —— 它对被占用文件
     会自动重试，同卷移动同样是瞬时的。 */
  console.warn('[pack] 直接重命名被拒绝（文件可能正被扫描），改用 robocopy /MOVE 重试…');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    'robocopy',
    [folders.src, folders.dest, '/E', '/MOVE', '/R:3', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS'],
    { stdio: 'inherit' },
  );
  // robocopy 的退出码：0-7 都算成功，>=8 才是失败
  if (result.status === null || result.status >= 8) {
    console.error(`[pack] 重命名失败：${folders.src} → ${folders.dest}`);
    console.error(err instanceof Error ? err.message : String(err));
    console.error('[pack] 请关掉正在运行的 exe / 关掉资源管理器预览后重试');
    process.exit(1);
  }
}

/* electron-builder 每次还会在输出目录里留下调试快照：
     builder-debug.yml             —— 它匹配了哪些文件、依赖树
     builder-effective-config.yaml —— 合并后的最终配置
   这两个只有排查打包报错时才用得上，分发时纯属垃圾，打包完顺手清掉。 */
for (const junk of ['builder-debug.yml', 'builder-effective-config.yaml']) {
  try {
    fs.rmSync(path.join(baseDir, junk), { force: true });
  } catch {
    /* 删不掉也不影响产物本身 */
  }
}

console.log(`[pack] 平台目录：build/${platformTag}`);
console.log(`[pack] 产物目录：${folders.dest}`);
console.log(`[pack] 可执行文件：${path.join(folders.dest, `${projectName}.exe`)}`);
