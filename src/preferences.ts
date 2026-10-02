import type { PanelApi } from "./panel/panel-api"

/** 非关键偏好的保存失败须被捕获，避免未处理的 Promise 拒绝。 */
export function persistPreference(api: PanelApi, key: string, value: unknown): void {
  try {
    Promise.resolve(api.kv.set(key, value)).catch((error) =>
      console.error(`[cache-panel] 无法保存 ${key}`, error),
    )
  } catch (error) {
    console.error(`[cache-panel] 无法保存 ${key}`, error)
  }
}
