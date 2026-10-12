// summarize.ts — 逐字稿 → 會議紀要（方法論見 minutes-methodology.md；呼 llm/router）
//
// 可注入兩層背景：常駐「會議助理提示詞」+ 本場「前情提要」，
// 用以校正辨識錯字、框定重點、統一術語，產出更貼合的摘要。

import { complete, type ProviderEntry } from "../llm/router.ts";
import { contextBlock, type CtxOpts } from "./clean.ts";
import { cleanTopic } from "./mdfile.ts";
// 摘要方法論（內建自 asr-minutes 技能）：先聲學修復、再依內容自擬章節的會議紀要
import METHODOLOGY from "./minutes-methodology.md" with { type: "text" };
// @ts-ignore - opencc-js 無型別宣告
import * as OpenCC from "opencc-js";

// 繁簡互轉走本地 OpenCC 字典（瞬間、零網路、零外流），只有英文才需 LLM 真翻譯。
const _s2t = (OpenCC as any).Converter({ from: "cn", to: "twp" }); // → 繁體（台灣慣用）
const _t2s = (OpenCC as any).Converter({ from: "tw", to: "cn" }); // → 簡體
function cjkRatio(t: string): number {
  const m = t.match(/[\u3400-\u9fff]/g);
  const base = t.replace(/\s/g, "").length || 1;
  return (m ? m.length : 0) / base;
}

export type { CtxOpts };

export type Lang = "tw" | "cn" | "en";
const LANG_NAME: Record<Lang, string> = { tw: "繁體中文", cn: "簡體中文", en: "English" };

const PROMPT = (transcript: string, o?: CtxOpts, lang: Lang = "cn", dateHint = "") =>
  `你是專業會議記錄助理。以下是一場會議的逐字稿（語音辨識產生，可能含同音錯字、斷句錯誤）。請嚴格依照下方「會議紀要方法論」先修復聲學誤聽、再整理成可直接存檔的會議紀要。

【會議紀要方法論】
"""
${METHODOLOGY.trim()}
"""

${contextBlock(o)}補充要求：
- **輸出語言**：整份紀要一律使用「${LANG_NAME[lang]}」；即使背景或方法論範例用其他語言，也以此為準。專有名詞、英文縮寫、代號、人名保留原文。
${dateHint ? `- 會議日期 ${dateHint}；逐字稿中「明天」「下周」等相對日期據此換算，無法換算則照原話寫。` : ""}
- 只輸出紀要正文本身，不要前言、後記、自我說明或方法論複述。

逐字稿：
"""
${transcript}
"""`;

export async function summarize(
  transcript: string,
  opts?: CtxOpts & { lang?: Lang; dateHint?: string; providers?: ProviderEntry[] }
): Promise<{ provider: string; markdown: string }> {
  if (!transcript.trim()) {
    return { provider: "(none)", markdown: "_（無逐字稿內容，略過摘要）_" };
  }
  const lang: Lang = opts?.lang ?? "cn";
  const { provider, text } = await complete(PROMPT(transcript, opts, lang, (opts as any)?.dateHint ?? ""), opts?.providers);
  return { provider, markdown: text };
}

export async function translateSummary(
  summary: string,
  lang: Lang,
  providers?: ProviderEntry[]
): Promise<{ provider: string; markdown: string }> {
  if (!summary.trim()) return { provider: "(none)", markdown: summary };

  // 分流：目標為繁/簡，且來源本就是中文 → 本地 OpenCC 秒轉，不走 LLM。
  if ((lang === "tw" || lang === "cn") && cjkRatio(summary) > 0.15) {
    const conv = lang === "tw" ? _s2t : _t2s;
    return { provider: "opencc(本地)", markdown: conv(summary) };
  }

  // 其餘（英文，或來源非中文需真翻譯）→ LLM。
  const prompt = `把以下會議摘要翻譯成「${LANG_NAME[lang]}」。保留原本的段落結構與換行（首行標題、各敘述段落），只翻譯內容文字。原有的粗體、編號、項目符號、表格格式原樣保留，不要新增或刪除格式。專有名詞、英文縮寫、代號、人名保留原文不譯。只輸出翻譯後的 Markdown，不要任何前後說明。

摘要：
"""
${summary}
"""`;
  const { provider, text } = await complete(prompt, providers);
  return { provider, markdown: text.trim() || summary };
}

// 主題標籤 prompt（參考 Scriberr generateTitleFromLLM：prompt 約束 + 程式二次清洗 cleanTopic）
const TOPIC_PROMPT = (text: string) =>
  `根據以下會議內容，產生一個精準的會議主題標籤，會用作檔名與列表標題。要求：
- 4 到 14 個字的名詞片語，具體點出核心議題（有明確對方公司／團隊可帶上）。
- 不要泛稱（會議、討論、摘要、記錄、溝通），不要日期、時間、人名敬稱。
- 不要引號、括號、標點、表情符號；語言與內容一致。
- 只輸出標籤本身，不要任何說明。

會議內容：
"""
${text}
"""`;

/** 由摘要（或逐字稿）生成主題標籤；空內容回空字串 */
export async function genTopic(text: string, providers?: ProviderEntry[]): Promise<string> {
  if (!text.trim()) return "";
  const { text: out } = await complete(TOPIC_PROMPT(text.slice(0, 6000)), providers);
  return cleanTopic(out.split("\n").find((l) => l.trim()) ?? "");
}
