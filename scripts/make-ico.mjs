/**
 * 打包前生成 icon.ico（从 build-resources/icon.png）。
 *
 * 为什么不直接在 npm script 里写 `pyshim/python.exe`：
 *   npm 在 Windows 上走 cmd.exe，`pyshim/python.exe` 会被当成一个含斜杠的命令名，
 *   直接报「不是内部或外部命令」。这里用 node 拼绝对路径再 spawn，跨平台也不出错。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const python = [path.join(root, 'pyshim', 'python.exe'), path.join(root, 'pyshim', 'python')].find(
  (candidate) => fs.existsSync(candidate),
);

if (!python) {
  console.error('[icon] 找不到 pyshim/python.exe（项目自带的便携 Python）');
  console.error('[icon] 如果只是想跳过转换，请确认 build-resources/icon.ico 已存在');
  process.exit(1);
}

const result = spawnSync(python, [path.join(root, 'scripts', 'make_ico.py')], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
