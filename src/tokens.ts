// ---------------------------------------------------------------------------
// token 工具：无外部依赖的纯函数，便于单元测试。
// ---------------------------------------------------------------------------

/** 取有限数值，非数值或非有限值返回 0。 */
export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// 按字符估算 token，分别使用推理、答案和工具内容的密度。
// 标定脚本位于 benchmarks/；此处折算系数保持保守。

/** token 密度画像：按 part 形态选择 ASCII 字符/token 折算系数。 */
export type TokProfile = "thinking" | "answer" | "code"

/** 各画像的 ASCII 密度（字符/token，实测标定）。 */
export const ASCII_PER_TOKEN: Record<TokProfile, number> = {
  thinking: 4.0, // reasoning part：~95% ascii 思考流（实测密度 4.04）
  answer: 2.9, // text part：符号/代码片段密集的答案（实测 2.97，含全角/符号稀释）
  code: 3.7, // tool raw/output：纯代码/命令输出（实测密度 3.71）
}

/** 估算文本 token 数：CJK 系按字计，ASCII 按 profile 密度折算；省略 profile 时按文本形态自动检测。 */
export function estimateTokens(text: string, profile?: TokProfile): number {
  if (!text || text.length === 0) return 0
  let ascii = 0
  let cjk = 0 // 假名/谚文等：分词压缩率接近 1 字/token
  let han = 0 // 汉字：o200k 平均 ~1.5 字/token
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff)
      han++ // CJK Unified 汉字
    else if (code >= 0x3040 && code <= 0x30ff)
      cjk++ // 平假名 / 片假名
    else if (code >= 0x3000 && code <= 0x303f)
      cjk++ // CJK 全角标点（密度~1 字/token，归 ascii 会低估答案段）
    else if (code >= 0xff00 && code <= 0xffef)
      cjk++ // 全角形式（０ａｂ＊，同上）
    else if (code >= 0xac00 && code <= 0xd7a3)
      cjk++ // 韩文音节
    else if (code >= 0x1100 && code <= 0x11ff)
      cjk++ // 韩文字母
    else if (code >= 0x2e80 && code <= 0x2eff)
      cjk++ // 中日韩部首
    else ascii++
  }

  let asciiPerToken: number
  if (profile) {
    asciiPerToken = ASCII_PER_TOKEN[profile]
  } else {
    const trimmed = text.trimStart()
    // 剥离 Markdown 代码围栏前缀，使 JSON 代码块能被正确识别。
    const strippedFence = trimmed.replace(/^\x60{3}\w*\s*\n?/, "")
    // jsonLike 判定统一基于 strippedFence，避免与 startsWith 的文本口径不一致。
    const jsonLike =
      (strippedFence.startsWith("{") || strippedFence.startsWith("[")) &&
      /"[^"]+"\s*:/.test(strippedFence)
    const codeLike =
      !jsonLike &&
      /```|^import |^export |^function |^const |^let |^var |^class |^interface |^type |^def |^fn |^pub |^use |^mod |^package /m.test(
        text,
      )

    asciiPerToken = jsonLike || codeLike ? ASCII_PER_TOKEN.code : 3.3
  }
  return Math.max(1, Math.ceil(ascii / asciiPerToken + cjk / 1.0 + han / 1.5))
}
