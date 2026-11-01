import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDirs } from '../core/paths';
// 这个文件里有局部变量叫 msg / text（rembg 的 JSON 输出行、原始行），所以取个不会撞的别名
import { msg as t9n } from '../core/msg';

/**
 * 通过便携 Python 调用**官方 rembg** 做抠图。
 *
 * 为什么走子进程：rembg 是 Python 生态，而我们是 Electron/TypeScript。
 * 直接重写它的推理只能近似，效果必然有差距（实测：官方输出直接用，
 * 边缘比手写 ONNX 版本干净）。所以这里原样调用，不做任何额外加工。
 *
 * 依赖 pyshim/ 目录（项目内的便携 Python 3.11 + rembg + onnxruntime），
 * 全部在安装目录内，不碰系统 Python，也不写用户目录。
 */

export interface RembgOptions {
  /** u2net / birefnet / isnet-general-use ... */
  model?: string;
  /** 开启 alpha matting（边缘更细，但慢） */
  alphaMatting?: boolean;
  /** 关闭 RGB 去污染（默认开：修掉半透明像素里的背景色） */
  noDecontaminate?: boolean;
  /** 并行进程数（1 = 不并行）。每个进程各加载一次模型，别开太大 */
  workers?: number;
}

export interface RembgResult {
  dataUrl: string;
  elapsedMs: number;
  model: string;
}

/** 项目根目录（data 的上一级） */
function projectRoot(): string {
  return path.dirname(getDataDirs().root);
}

/** 找到便携 Python；找不到返回 null（调用方给出可读的错误） */
export function findPyshim(): string | null {
  const candidates = [
    path.join(projectRoot(), 'pyshim', 'python.exe'),
    path.join(projectRoot(), 'pyshim', 'python'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** rembg 依赖是否就绪（用一条极快的 import 探测） */
export async function probeRembg(python: string): Promise<{ available: boolean; message: string }> {
  return new Promise((resolve) => {
    const child = spawn(python, ['-c', 'from rembg import remove, new_session; print("ok")'], {
      cwd: projectRoot(),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => resolve({ available: false, message: err.message }));
    child.on('close', (code) => {
      if (code === 0 && stdout.includes('ok')) {
        resolve({ available: true, message: t9n('err.rembg.ready') });
        return;
      }
      const tail = (stderr || stdout).trim().split('\n').slice(-4).join(' / ');
      resolve({
        available: false,
        message: tail || t9n('err.rembg.probeFailed', { code: String(code) }),
      });
    });
  });
}

/**
 * 抠图。输入输出都走临时文件（rembg 处理大图时中间数据量大，走 stdin 会卡）。
 */
export async function removeBackgroundWithRembg(
  absPath: string,
  options: RembgOptions = {},
): Promise<RembgResult> {
  const python = findPyshim();
  if (!python) {
    throw new Error(t9n('err.rembg.noPyshim'));
  }

  const dirs = getDataDirs();
  const cacheDir = path.join(dirs.cache, 'rembg');
  fs.mkdirSync(cacheDir, { recursive: true });

  const stamp = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const outPath = path.join(cacheDir, `out-${stamp}.png`);

  /* 帧动画里的帧是内存 blob（还没有磁盘文件），传进来的会是 data:image/... 的 base64。
     这种情况先落一个临时文件再交给 rembg —— CLI 只认文件路径。 */
  let inputPath = absPath;
  let tempInput: string | null = null;
  if (absPath.startsWith('data:')) {
    const commaIndex = absPath.indexOf(',');
    if (commaIndex < 0) throw new Error(t9n('err.rembg.badImageData'));
    const base64 = absPath.slice(commaIndex + 1);
    tempInput = path.join(cacheDir, `in-${stamp}.png`);
    fs.writeFileSync(tempInput, Buffer.from(base64, 'base64'));
    inputPath = tempInput;
  } else if (!absPath || !fs.existsSync(absPath)) {
    throw new Error(t9n('err.rembg.imageMissing', { path: absPath || '(empty)' }));
  }

  const args = [path.join(projectRoot(), 'scripts', 'rembg_cli.py'), inputPath, outPath];
  if (options.model) args.push('--model', options.model);
  if (options.alphaMatting) args.push('--alpha-matting');
  if (options.noDecontaminate) args.push('--no-decontaminate');

  const started = Date.now();
  const meta = await new Promise<string>((resolve, reject) => {
    const child = spawn(python, args, { cwd: projectRoot(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) =>
      reject(new Error(t9n('err.rembg.spawnFailed', { error: err.message }))),
    );
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      // rembg/onnxruntime 的报错通常在 stderr 末尾几行
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      reject(new Error(tail || t9n('err.rembg.exitCode', { code: String(code) })));
    });
  });

  if (!fs.existsSync(outPath)) throw new Error(t9n('err.rembg.noOutput'));
  const buffer = fs.readFileSync(outPath);
  fs.unlinkSync(outPath);
  // 内存帧模式下顺手清掉临时输入文件
  if (tempInput) {
    try {
      fs.unlinkSync(tempInput);
    } catch {
      /* 删不掉就留着，下次启动清缓存时会带走 */
    }
  }

  let elapsedMs = Date.now() - started;
  try {
    const parsed = JSON.parse(meta) as { elapsed_ms?: number };
    if (typeof parsed.elapsed_ms === 'number') elapsedMs = parsed.elapsed_ms;
  } catch {
    /* 没有 JSON 就用墙钟时间 */
  }

  return {
    dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
    elapsedMs,
    model: options.model ?? 'birefnet-general',
  };
}

export interface BatchProgress {
  done: number;
  total: number;
  file: string;
  /** 附加说明（例如「内存不足，并行数已自动降低」），只用于界面提示 */
  message?: string;
}

/**
 * 正在运行的批量任务。用于「强制停止」—— 用户点到一半想换模型/换参数时，
 * 不能只能干等 80 分钟；kill 掉子进程即可立刻中断。
 */
const runningBatches = new Map<string, { kill: () => void }>();

/**
 * 结束一个子进程及其所有子孙。
 *
 * Windows 上 `child.kill()` 只干掉直接子进程，Python 用 multiprocessing 开出来的
 * worker 会变成孤儿继续吃 CPU。必须用 `taskkill /T /F` 才能连根拔掉。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      return;
    } catch {
      /* taskkill 不可用就退回普通 kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退出了 */
  }
}

/**
 * 列出本地已经下载好的 rembg 模型（data/models/*.onnx）。
 *
 * 为什么需要它：模型下拉里如果列出没下载的模型，selected 之后 rembg 会去 GitHub
 * 现场下载（几百 MB），网络一差就是 30 秒超时 + 报错。只让用户选本地有的最省事。
 */
export function listLocalModels(): { name: string; sizeMb: number }[] {
  const dir = path.join(getDataDirs().root, 'models');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const models: { name: string; sizeMb: number }[] = [];
  for (const entry of entries) {
    const matched = /^(.+)\.onnx$/i.exec(entry);
    if (!matched) continue;
    const name = matched[1].toLowerCase();
    if (seen.has(name)) continue;
    let sizeMb = 0;
    try {
      sizeMb = Math.round(fs.statSync(path.join(dir, entry)).size / (1024 * 1024));
    } catch {
      continue;
    }
    seen.add(name);
    models.push({ name, sizeMb });
  }
  // 大模型排前面：效果通常更好
  models.sort((a, b) => b.sizeMb - a.sizeMb);
  return models;
}

/** 强制停止某个批量任务；返回是否真的停到了 */
export function cancelBatch(jobId: string): boolean {
  const job = runningBatches.get(jobId);
  if (!job) return false;
  job.kill();
  runningBatches.delete(jobId);
  return true;
}

/**
 * 终止所有正在跑的批量任务。应用退出时调用 ——
 * 否则关掉窗口后 Python 会继续在后台把整批帧跑完（用户会看到"关掉了还在抠图"）。
 */
export function cancelAllBatches(): number {
  let killed = 0;
  for (const [key, job] of runningBatches) {
    job.kill();
    runningBatches.delete(key);
    killed += 1;
  }
  return killed;
}

/** 当前是否有批量任务在跑 */
export function hasRunningBatch(jobId: string): boolean {
  return runningBatches.has(jobId);
}

/**
 * 按可用内存给并行进程数封顶。
 *
 * 为什么必须卡这一道：`--workers N` 是 N 个**独立 Python 进程**，每个进程各自
 * 加载一份完整模型（birefnet-general 权重 928 MB，加上 onnxruntime arena 和
 * 中间张量，实测每个进程常驻 1.5–2.5 GB）。开 3 个并行就是 5–8 GB，
 * 物理内存不够时 Windows 会疯狂换页，整台机器卡死（不是程序崩溃，是「死机」）。
 *
 * 返回实际可用的并行数；拿不到模型大小时按保守值处理。
 */
function clampWorkersByMemory(model: string | undefined, requested: number): number {
  if (!requested || requested <= 1) return 1;

  let modelBytes = 0;
  try {
    const file = path.join(getDataDirs().root, 'models', `${model ?? 'u2net'}.onnx`);
    modelBytes = fs.statSync(file).size;
  } catch {
    modelBytes = 0;
  }
  // 模型还没下载（rembg 会现场拉）或读不到大小：按最保守的 2 个走
  if (modelBytes === 0) return Math.min(requested, 2);

  // 每个 worker 按权重的 2.5 倍估算常驻内存（arena + 中间张量 + PIL 图像）
  const perWorker = modelBytes * 2.5;
  // 只用可用内存的 70%，给系统和 Electron 本体留余量
  const allowed = Math.max(1, Math.floor((os.freemem() * 0.7) / perWorker));
  return Math.min(requested, allowed);
}

/**
 * 批量抠图：**只启动一次 Python、只加载一次模型**，处理整个目录。
 * 逐张 spawn 会让每张都重新加载模型（30 秒起步），批量会慢到无法使用。
 *
 * @param onProgress 每处理完一张回调一次，用于界面显示进度
 * @param jobId 用于 cancelBatch() 强制停止；不传则用 inDir 当标识
 */
export async function removeBackgroundBatch(
  inDir: string,
  outDir: string,
  options: RembgOptions,
  onProgress?: (progress: BatchProgress) => void,
  jobId?: string,
): Promise<{ total: number; elapsedMs: number; errors: string[] }> {
  const python = findPyshim();
  if (!python) {
    throw new Error(t9n('err.rembg.noPyshimBatch'));
  }
  if (!fs.existsSync(inDir)) throw new Error(t9n('err.rembg.inputDirMissing', { dir: inDir }));
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    path.join(projectRoot(), 'scripts', 'rembg_cli.py'),
    '--batch-in',
    inDir,
    '--batch-out',
    outDir,
  ];
  if (options.model) args.push('--model', options.model);
  if (options.alphaMatting) args.push('--alpha-matting');
  if (options.noDecontaminate) args.push('--no-decontaminate');

  /* 并行数按可用内存封顶：每个 worker 是独立进程、各自加载一份模型，
     内存不够时会把整台机器拖到卡死。超了就在这里降下来，并在进度里说明。 */
  const requested = options.workers ?? 1;
  const workers = clampWorkersByMemory(options.model, requested);
  if (requested > workers) {
    const freeGb = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
    const note = t9n('err.rembg.memoryNote', {
      free: freeGb,
      requested: String(requested),
      workers: String(workers),
    });
    console.warn(`[rembg] ${note}`);
    onProgress?.({ done: 0, total: 0, file: '', message: note });
  }
  if (workers > 1) args.push('--workers', String(workers));

  const errors: string[] = [];
  const started = Date.now();
  const key = jobId ?? inDir;

  const result = await new Promise<{ total: number }>((resolve, reject) => {
    const child = spawn(python, args, { cwd: projectRoot(), windowsHide: true });
    let stdoutBuffer = '';
    let stderr = '';
    let total = 0;
    let cancelled = false;

    runningBatches.set(key, {
      kill: () => {
        cancelled = true;
        killProcessTree(child);
      },
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      // 最后一段可能是不完整的行，留到下次
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.trim();
        if (!text.startsWith('{')) continue;
        try {
          const msg = JSON.parse(text) as {
            type?: string;
            total?: number;
            done?: number;
            file?: string;
            message?: string;
          };
          if (msg.type === 'start') total = msg.total ?? 0;
          else if (msg.type === 'progress' && onProgress) {
            onProgress({ done: msg.done ?? 0, total: msg.total ?? total, file: msg.file ?? '' });
          } else if (msg.type === 'error') {
            errors.push(`${msg.file ?? '?'}: ${msg.message ?? t9n('err.rembg.unknownError')}`);
          } else if (msg.type === 'done') {
            total = msg.total ?? total;
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      runningBatches.delete(key);
      reject(new Error(t9n('err.rembg.spawnFailed', { error: err.message })));
    });
    child.on('close', (code) => {
      runningBatches.delete(key);
      if (cancelled) {
        reject(new Error(t9n('err.rembg.cancelled')));
        return;
      }
      if (code === 0) {
        resolve({ total });
        return;
      }
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      reject(new Error(tail || t9n('err.rembg.batchExitCode', { code: String(code) })));
    });
  });

  return { total: result.total, elapsedMs: Date.now() - started, errors };
}
