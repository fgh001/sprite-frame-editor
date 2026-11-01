import { useEffect, useRef } from 'react';

/**
 * 全局「数据变了」广播。
 *
 * 为什么需要：图片生成 / 循环视频 / 批量抠图 / 帧动画这几页是常驻挂载的
 * （切页只是 display:none），列表数据只在挂载时读一次。所以在别处改名、删除、
 * 新增之后，这些页面上的列表还是旧的 —— 必须让它们知道该重新读一遍。
 *
 * 用法：
 *   改完数据的地方 → notifyDataChanged()
 *   需要跟着刷新的页面 → useDataRefresh(() => void load())
 *
 * 只用一个无差别事件，不带 scope：所有刷新的都是本地 IPC 读目录，开销可以忽略，
 * 但能彻底避免「忘记订阅某个 scope 导致某页不刷新」这类问题。
 */
const EVENT = 'sprite:data-changed';

/** 通知所有页面：底层数据变了，该重新读盘了 */
export function notifyDataChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** 订阅数据变更。handler 每次渲染都会更新，但监听只注册一次 */
export function useDataRefresh(handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (): void => handlerRef.current();
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
}
