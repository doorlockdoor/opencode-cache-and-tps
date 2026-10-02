// ── 通用小工具 ──
// 无业务依赖的通用工具（单元测试见 tests/util.test.ts）。

/**
 * 前沿+尾沿节流：interval 内首个事件立即触发，间隔满后至多补触发一次。
 * 与纯尾沿去抖的区别：连续事件流下去抖的定时器不断重置会被饿死，
 * 本实现触发锚定 lastBump + interval，突发期间节奏稳定。
 * now 可注入以便单测；dispose 供 onCleanup 清理挂起的尾沿定时器。
 */
export function createThrottledBumper(
  bump: () => void,
  intervalMs: number,
  now: () => number = Date.now,
): {
  bump: () => void
  dispose: () => void
} {
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    last = now()
    bump()
  }
  return {
    bump() {
      const t = now()
      if (t - last >= intervalMs) {
        fire()
        return
      }
      if (timer === undefined) {
        timer = setTimeout(
          () => {
            timer = undefined
            fire()
          },
          intervalMs - (t - last),
        )
      }
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
