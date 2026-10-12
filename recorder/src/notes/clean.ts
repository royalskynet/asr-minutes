// clean.ts — 逐字稿 LLM 校稿（同音錯字 / 專有名詞 / 誤斷詞）+ 背景區塊共用工具
//
// 排序建議 #2：摘要前先用「領域背景 + 本場前情提要」校正 STT 辨識錯誤，
// 再餵給摘要層。複用既有 llm/router（訂閱/免費，非計量）。
// 校稿輸出僅用於摘要輸入，不覆寫已存的逐字稿原文（保留可就地修正）。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete, type ProviderEntry } from "../llm/router.ts";

/** ASR 詞彙表唯一權威來源（可用 ASR_GLOSSARY 覆寫）；App／腳本／會後摘要一律由此讀 */
export const GLOSSARY_FILE = process.env.ASR_GLOSSARY ?? join(homedir(), "Downloads", "OFF", "asr-glossary.md");
export function readGlossary(): string {
  try { return readFileSync(GLOSSARY_FILE, "utf8"); } catch { return ""; }
}

export interface CtxOpts {
  /** 常駐會議助理提示詞（領域背景，跨會議通用） */
  assistant?: string;
  /** 本場會議前情提要（具體主題/需求） */
  context?: string;
  /** ASR 誤聽對照表（外部 asr-glossary.md，隨摘要一併注入） */
  glossary?: string;
}

/** 把背景兩層組成 prompt 區塊；皆空則回空字串 */
export function contextBlock(o?: CtxOpts): string {
  if (!o) return "";
  let s = "";
  if (o.assistant?.trim())
    s += `【會議助理設定 · 領域背景（用以理解術語、還原專有名詞）】\n"""\n${o.assistant.trim()}\n"""\n\n`;
  if (o.context?.trim())
    s += `【本場會議前情提要 · 具體主題與需求】\n"""\n${o.context.trim()}\n"""\n\n`;
  if (o.glossary?.trim())
    s += `【術語對照表 · ASR 誤聽還原】
"""
${o.glossary.trim()}
"""

`;
  return s;
}

const CLEAN_PROMPT = (transcript: string, o?: CtxOpts) =>
  `你是中文語音辨識校對員。下面逐字稿由 STT 即時產生，含同音錯字、誤斷詞、專有名詞與數字單位辨識錯誤。請依背景校正成通順正確的逐字稿。

${contextBlock(o)}規則：
- 只修正明顯辨識錯誤（同音字、專有名詞、人名、技術術語、數字單位），依背景還原正確寫法。
- 嚴格保留「發言人：內容」每行格式與「行數」，不可合併行、刪行、增行、加註解。
- 不確定的內容保持原樣，不要臆造或補充未說出口的內容。
- 只輸出校正後的逐字稿本體，不要任何前言或說明。

逐字稿：
"""
${transcript}
"""`;

/** 校稿逐字稿，回傳校正後純文字（失敗或空則回原文） */
export async function cleanTranscript(
  transcript: string,
  opts?: CtxOpts & { providers?: ProviderEntry[] }
): Promise<{ provider: string; text: string }> {
  if (!transcript.trim()) return { provider: "(none)", text: transcript };
  const { provider, text } = await complete(CLEAN_PROMPT(transcript, opts), opts?.providers);
  return { provider, text: text.trim() || transcript };
}
