# -*- coding: utf-8 -*-
"""
官方 rembg 调用入口（给 Electron 主进程用）。

两种模式：
  单张：python.exe rembg_cli.py <输入图> <输出图> [--model birefnet-general]
  批量：python.exe rembg_cli.py --batch-in <目录> --batch-out <目录> [--model ...]

批量模式的关键：**模型只加载一次**，然后循环处理整个目录。
逐张启动 Python 会让每张都重新加载模型（30 秒起步），批量会慢到没法用。

额外做的一步「边缘 RGB 去污染」：
    官网 app.py 最后一行是 image.putalpha(mask) —— 只写 alpha，RGB 原样保留。
    实测某张黑背景立绘：68317 个半透明像素里 89.1% 的 RGB 接近纯黑，
    显示出来就是一圈黑边。用 pymatting.estimate_foreground_ml 按
    C = αF + (1-α)B 反解真实 F 即可消除。

输出（stdout，每行一个 JSON）：
    批量：{"type":"start","total":20}
          {"type":"progress","done":3,"total":20,"file":"frame_002.png"}
          {"type":"done","total":20,"elapsed_ms":12345}
    单张：{"ok":true,"elapsed_ms":1234,"decontaminated":true}
"""
import argparse
import gc
import glob
import json
import os
import sys
import time
from io import BytesIO

# 让 rembg 的模型放在项目的 data/models 下（保持便携，不写用户目录 ~/.u2net）
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT = os.path.dirname(_HERE)
os.environ.setdefault("U2NET_HOME", os.path.join(_PROJECT, "data", "models"))
os.environ.setdefault("POOCH_PROGRESSBAR", "0")


def lower_priority():
    """把本进程降到「低于正常」优先级。

    为什么：批量抠图是纯 CPU 密集型，onnxruntime 默认吃满所有核心，
    Electron 界面（切页、预览、视频解码）跟着一起卡死，表现为「抠图期间点不动」。
    降优先级后 Windows 优先调度界面进程，抠图慢一点，但界面能正常响应。
    """
    if os.name != "nt":
        return
    try:
        import ctypes

        BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        ctypes.windll.kernel32.SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS)
    except Exception:  # noqa: BLE001
        pass


def make_session(model):
    """创建 rembg session，并给 onnxruntime 线程数封顶。

    默认 ORT 会用满物理核心，抠图期间界面基本没法用。这里留 1 个核给界面；
    需要极限速度时可以用环境变量 SFE_MATTING_THREADS 覆盖。
    """
    import onnxruntime as ort
    from rembg import new_session

    cores = os.cpu_count() or 4
    threads = max(1, cores - 1)
    override = os.environ.get("SFE_MATTING_THREADS")
    if override:
        try:
            threads = max(1, int(override))
        except ValueError:
            pass

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    return new_session(model, sess_opts=opts)


def decontaminate(image):
    """把半透明像素的 RGB 换成真实前景色，消除黑边/白边。

    C = αF + (1-α)B：已知观测色 C 和 alpha，反解 F 就是该像素原本的颜色。
    pymatting 用最小二乘在整幅图上求 F，比逐点反解稳（逐点在 α 很小时会放大噪声）。
    """
    import numpy as np
    from PIL import Image
    from pymatting import estimate_foreground_ml

    rgb = np.asarray(image.convert("RGB"), dtype=np.float64) / 255.0
    alpha = np.asarray(image.split()[-1], dtype=np.float64) / 255.0
    if not ((alpha > 0.004) & (alpha < 0.996)).any():
        return image, False

    fg = np.clip(estimate_foreground_ml(rgb, alpha), 0.0, 1.0)
    merged = np.dstack([fg, alpha])
    out = (np.clip(merged, 0.0, 1.0) * 255.0).round().astype(np.uint8)
    return Image.fromarray(out, mode="RGBA"), True


# ---- 多进程批量：每个子进程各自加载一次模型，然后分摊帧 ----
_WORKER = {}


def _init_worker(model, alpha_matting, no_decontaminate, batch_out, fg, bg, erode):
    """子进程初始化：加载一次模型，之后所有帧复用。"""
    import rembg

    lower_priority()  # 子进程自己再降一次，保证并行时也不抢界面的核
    _WORKER["remove"] = rembg.remove
    _WORKER["session"] = make_session(model)
    _WORKER["opts"] = {
        "alpha_matting": alpha_matting,
        "no_decontaminate": no_decontaminate,
        "batch_out": batch_out,
        "fg": fg,
        "bg": bg,
        "erode": erode,
    }


def _process_task(src):
    """子进程里处理单张，返回 (文件名, 错误信息或空串)。"""
    import types

    opts = _WORKER["opts"]
    name = os.path.basename(src)
    dst = os.path.join(opts["batch_out"], name)
    fake_args = types.SimpleNamespace(
        alpha_matting=opts["alpha_matting"],
        no_decontaminate=opts["no_decontaminate"],
        fg_threshold=opts["fg"],
        bg_threshold=opts["bg"],
        erode=opts["erode"],
    )
    try:
        process_one(_WORKER["remove"], _WORKER["session"], src, dst, fake_args)
        # 每处理 5 张强制回收一次：onnxruntime 的中间张量和 PIL 图像由 Python
        # 分配器持有，长批次里会「只涨不回」，周期回收能明显压住常驻内存。
        _WORKER["count"] = _WORKER.get("count", 0) + 1
        if _WORKER["count"] % 5 == 0:
            gc.collect()
        return (name, "")
    except Exception as exc:  # noqa: BLE001
        return (name, str(exc))


def _run_parallel(files, args, workers):
    """用进程池并行处理，返回完成的帧数。"""
    from multiprocessing import Pool

    done = 0
    total = len(files)
    with Pool(
        processes=workers,
        initializer=_init_worker,
        initargs=(
            args.model,
            bool(args.alpha_matting),
            bool(args.no_decontaminate),
            args.batch_out,
            args.fg_threshold,
            args.bg_threshold,
            args.erode,
        ),
    ) as pool:
        for name, error in pool.imap_unordered(_process_task, files):
            if error:
                print(json.dumps({"type": "error", "file": name, "message": error}), flush=True)
            else:
                done += 1
                print(
                    json.dumps({"type": "progress", "done": done, "total": total, "file": name}),
                    flush=True,
                )
    return done


def process_one(remove, session, src_path, dst_path, args):
    from PIL import Image

    with open(src_path, "rb") as fp:
        src = fp.read()
    raw = remove(
        src,
        session=session,
        alpha_matting=bool(args.alpha_matting),
        alpha_matting_foreground_threshold=args.fg_threshold,
        alpha_matting_background_threshold=args.bg_threshold,
        alpha_matting_erode_size=args.erode,
    )
    image = Image.open(BytesIO(raw)).convert("RGBA")
    did = False
    if not args.no_decontaminate:
        try:
            image, did = decontaminate(image)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("去污染跳过: %s\n" % exc)
    parent = os.path.dirname(dst_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    image.save(dst_path, "PNG")
    return did


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--batch-in", help="批量输入目录")
    parser.add_argument("--batch-out", help="批量输出目录")
    parser.add_argument("--model", default="birefnet-general")
    parser.add_argument("--alpha-matting", action="store_true")
    parser.add_argument("--no-decontaminate", action="store_true")
    parser.add_argument("--fg-threshold", type=int, default=240)
    parser.add_argument("--bg-threshold", type=int, default=10)
    parser.add_argument("--erode", type=int, default=10)
    parser.add_argument("--workers", type=int, default=1, help="并行进程数（1 = 不并行）")
    args = parser.parse_args()

    batch = bool(args.batch_in and args.batch_out)
    if not batch:
        if not args.input or not args.output:
            sys.stderr.write("单张模式需要 <输入图> <输出图>，或改用 --batch-in/--batch-out\n")
            return 2
        if not os.path.exists(args.input):
            sys.stderr.write("输入文件不存在: %s\n" % args.input)
            return 2

    try:
        from rembg import new_session, remove
    except ImportError as exc:
        sys.stderr.write(
            "缺少依赖: %s\n请先运行: python.exe -m pip install onnxruntime\n" % exc
        )
        return 3

    started = time.time()
    lower_priority()
    try:
        # 关键：模型只加载一次，批量时所有帧共用一个 session
        session = make_session(args.model)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(
            "模型加载失败（名字必须用 rembg 认的，例如 birefnet-general / u2net / isnet-anime）: %s\n"
            % exc
        )
        return 5

    # ---------- 批量 ----------
    if batch:
        os.makedirs(args.batch_out, exist_ok=True)
        files = sorted(
            glob.glob(os.path.join(args.batch_in, "*.png"))
            + glob.glob(os.path.join(args.batch_in, "*.jpg"))
            + glob.glob(os.path.join(args.batch_in, "*.jpeg"))
        )
        total = len(files)
        if total == 0:
            sys.stderr.write("目录里没有图片: %s\n" % args.batch_in)
            return 6

        print(json.dumps({"type": "start", "total": total}), flush=True)

        workers = max(1, min(8, args.workers or 1))
        if workers > 1 and total > 1:
            # 多进程：每个子进程各自加载一次模型，然后分摊帧。
            # 模型加载本身要几十秒，所以只在帧数够多时才值得开。
            print(
                json.dumps({"type": "note", "message": f"并行 {workers} 个进程处理 {total} 帧"}),
                flush=True,
            )
            done = _run_parallel(files, args, workers)
            print(
                json.dumps(
                    {"type": "done", "total": done, "elapsed_ms": int((time.time() - started) * 1000)}
                ),
                flush=True,
            )
            return 0

        for index, src in enumerate(files):
            name = os.path.basename(src)
            try:
                process_one(remove, session, src, os.path.join(args.batch_out, name), args)
            except Exception as exc:  # noqa: BLE001
                print(
                    json.dumps({"type": "error", "file": name, "message": str(exc)}),
                    flush=True,
                )
                continue
            # 逐张处理、逐张落盘：每张的临时对象在 process_one 返回时就失效了，
            # 这里再每 5 张强制回收一次，避免长批次里内存「只涨不回」。
            if (index + 1) % 5 == 0:
                gc.collect()
            print(
                json.dumps({"type": "progress", "done": index + 1, "total": total, "file": name}),
                flush=True,
            )

        print(
            json.dumps(
                {
                    "type": "done",
                    "total": total,
                    "elapsed_ms": int((time.time() - started) * 1000),
                }
            ),
            flush=True,
        )
        return 0

    # ---------- 单张 ----------
    try:
        did = process_one(remove, session, args.input, args.output, args)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("rembg 处理失败: %s\n" % exc)
        return 4

    print(
        json.dumps(
            {
                "ok": True,
                "elapsed_ms": int((time.time() - started) * 1000),
                "model": args.model,
                "decontaminated": bool(did),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
