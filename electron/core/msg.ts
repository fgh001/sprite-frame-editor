import { tErr } from '../../shared/err-i18n';

/**
 * 主进程里生成「给人看的文案」的唯一入口。
 *
 * 为什么需要它：IPC 返回的 error 字符串会原样显示在界面上，
 * 所以必须跟着界面语言走 —— 不能写死中文。
 * 语言由 electron/core/ui.ts 同步到 shared/err-i18n（读取 / 切换时都会刷）。
 */
export function msg(key: string, vars?: Record<string, string>): string {
  return tErr(key, undefined, vars);
}
