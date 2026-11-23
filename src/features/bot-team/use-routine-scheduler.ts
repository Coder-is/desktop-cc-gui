import { useEffect } from "react";
import { schedulerTick } from "./runtime";

/** 首次检查推迟一点：启动时让引擎列表、Bot 列表先加载完。 */
const FIRST_TICK_MS = 5_000;
const TICK_MS = 30_000;

/**
 * 定时任务调度器。只在「Bot 团队」内测开关打开时挂载（关闭 = 不调度，
 * 不只是隐藏入口）。多个窗口都挂也没关系：每次触发先向后端 claim，
 * 同一个计划时刻只有一个窗口拿得到执行权。
 */
export function useRoutineScheduler(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let ticking = false;
    const tick = async () => {
      if (disposed || ticking) return;
      ticking = true;
      try {
        await schedulerTick();
      } catch (error) {
        console.warn("[bot-team] scheduler tick failed", error);
      } finally {
        ticking = false;
      }
    };
    const first = setTimeout(() => void tick(), FIRST_TICK_MS);
    const timer = setInterval(() => void tick(), TICK_MS);
    return () => {
      disposed = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [enabled]);
}
