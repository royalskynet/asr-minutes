// mdfile.ts — 會議記錄 MD 的純函式讀改工具（供 server 端點 read-modify-write 複用）
//
// 不碰檔案系統，全為字串操作；server 負責 read/write。
// 檔案格式（由 transcript.ts 產出）：
//   ---\n<frontmatter>\n---\n\n# 會議記錄 …\n\n## 逐字稿\n\n[HH:MM:SS] 發言人：內容\n\n…
//   \n---\n\n## 重點摘要\n\n<摘要 markdown>\n

const SUMMARY_HEADING = "## 重點摘要";

/** 逐字稿單句行：[時間] 發言人：內容 */
const UTT_RE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^：:]{1,16})[：:]\s*(.*)$/;
/** 待辦行：- [ ] / - [x] */
const TODO_RE = /^(\s*[-*]\s*)\[([ xX])\]\s*(.*)$/;

/** 抽出逐字稿純文字（去時間戳），供 LLM 摘要 */
export function extractTranscript(md: string): string {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(UTT_RE);
    if (m) out.push(`${m[2]}：${m[3]}`);
  }
  return out.join("\n");
}

/** 取現有摘要區內容（## 重點摘要 之後到檔尾），無則空字串 */
export function getSummary(md: string): string {
  const i = md.indexOf(SUMMARY_HEADING);
  if (i === -1) return "";
  return md.slice(i + SUMMARY_HEADING.length).replace(/^\s+/, "").trimEnd();
}

/** 取代（或新增）摘要區 */
export function replaceSummary(md: string, summaryMarkdown: string): string {
  const body = summaryMarkdown.trim();
  const i = md.indexOf(SUMMARY_HEADING);
  if (i === -1) {
    const base = md.replace(/\s+$/, "");
    return `${base}\n\n---\n\n${SUMMARY_HEADING}\n\n${body}\n`;
  }
  // 保留 heading 前內容（含分隔線），重寫之後
  return `${md.slice(0, i)}${SUMMARY_HEADING}\n\n${body}\n`;
}

/** 改寫第 index 句逐字稿（保留原時間戳），回傳新 md；index 越界則原樣回傳 */
export function editUtterance(md: string, index: number, speaker: string, text: string): string {
  const lines = md.split("\n");
  let n = -1;
  const spk = speaker.replace(/[：:\n]/g, "").trim() || "對方";
  const txt = text.replace(/\n/g, " ").trim();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(UTT_RE);
    if (!m) continue;
    n++;
    if (n === index) {
      lines[i] = `[${m[1]}] ${spk}：${txt}`;
      break;
    }
  }
  return lines.join("\n");
}

/** 切換第 index 個待辦的勾選狀態 */
export function toggleTodo(md: string, index: number): string {
  const lines = md.split("\n");
  let n = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TODO_RE);
    if (!m) continue;
    n++;
    if (n === index) {
      const checked = m[2].toLowerCase() === "x";
      lines[i] = `${m[1]}[${checked ? " " : "x"}] ${m[3]}`;
      break;
    }
  }
  return lines.join("\n");
}

const CONTEXT_HEADING = "## 會議背景";
const TRANSCRIPT_HEADING = "## 逐字稿";

/** 取「## 會議背景」段內容（到下一個 ## 或 --- 為止），無則空字串 */
export function getContext(md: string): string {
  const i = md.indexOf(CONTEXT_HEADING);
  if (i === -1) return "";
  const after = md.slice(i + CONTEXT_HEADING.length);
  const stop = after.search(/\n##\s|\n---\s*(\n|$)/);
  const body = stop === -1 ? after : after.slice(0, stop);
  return body.replace(/^\s+/, "").trimEnd();
}

/** 設定（新增 / 取代 / 清空）「## 會議背景」段，置於逐字稿前 */
export function setContext(md: string, text: string): string {
  const body = text.trim();
  const i = md.indexOf(CONTEXT_HEADING);
  if (i !== -1) {
    const after = md.slice(i + CONTEXT_HEADING.length);
    const stop = after.search(/\n##\s|\n---\s*(\n|$)/);
    const tail = stop === -1 ? "" : after.slice(stop).replace(/^\n+/, "");
    if (!body) {
      const before = md.slice(0, i).replace(/\s+$/, "");
      return `${before}\n\n${tail}`.replace(/\n{3,}/g, "\n\n");
    }
    return `${md.slice(0, i)}${CONTEXT_HEADING}\n\n${body}\n\n${tail}`;
  }
  if (!body) return md;
  const t = md.indexOf(TRANSCRIPT_HEADING);
  if (t !== -1) {
    return `${md.slice(0, t)}${CONTEXT_HEADING}\n\n${body}\n\n${md.slice(t)}`;
  }
  const base = md.replace(/\s+$/, "");
  return `${base}\n\n${CONTEXT_HEADING}\n\n${body}\n`;
}

/** 取 YAML frontmatter 任一 `key:` 值，無則空字串 */
export function getMeta(md: string, key: string): string {
  if (!md.startsWith("---\n")) return "";
  const end = md.indexOf("\n---", 4);
  if (end === -1) return "";
  const m = md.slice(4, end).match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

/** 設定（新增 / 取代 / 清空）frontmatter 的 `key:` 行 */
export function setMeta(md: string, key: string, text: string): string {
  const val = text.trim();
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---", 4);
  if (end === -1) return md;
  const re = new RegExp(`^${key}:`);
  const lines = md.slice(4, end).split("\n");
  const has = lines.some((l) => re.test(l));
  if (!val) {
    if (!has) return md;
    return `---\n${lines.filter((l) => !re.test(l)).join("\n")}${md.slice(end)}`;
  }
  if (has) return `---\n${lines.map((l) => (re.test(l) ? `${key}: ${val}` : l)).join("\n")}${md.slice(end)}`;
  return `---\n${key}: ${val}\n${lines.join("\n")}${md.slice(end)}`;
}

export const getTopic = (md: string) => getMeta(md, "topic");
export const setTopic = (md: string, text: string) => setMeta(md, "topic", cleanTopic(text));

/** 主題清洗：去換行、檔名非法字元與 HTML 危險字元，限 30 字 */
export function cleanTopic(t: string): string {
  return t
    .replace(/[\r\n]+/g, " ")
    .replace(/[\/\\:*?"<>|'`#&「」『』“”‘’《》]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。．.，,、；;！!]+$/, "")
    .slice(0, 30);
}

/** 毫秒 → 45m / 1h05m（至少 1m） */
export function fmtDuration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** 會議時長：優先 frontmatter `duration:`，否則由逐字稿首末時間戳推算（跨午夜補 24h） */
export function getDuration(md: string): string {
  const d = getMeta(md, "duration");
  if (d) return d;
  const ts = [...md.matchAll(/^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/gm)].map(
    (m) => +m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0)
  );
  if (ts.length < 2) return "";
  let s = ts[ts.length - 1] - ts[0];
  if (s < 0) s += 86400;
  return fmtDuration(s * 1000);
}

/** 檔名 stem：開頭 YYYY-MM-DD-HHmm（舊檔無則取第一個 _ 前） */
export function nameStem(name: string): string {
  const base = name.replace(/\.md$/, "");
  return base.match(/^\d{4}-\d{2}-\d{2}-\d{4}/)?.[0] ?? base.split("_")[0];
}

/** 標籤檔名：<stem>_<主題>_<時長>.md（空的部分略過） */
export function taggedName(name: string, topic: string, duration: string): string {
  return [nameStem(name), cleanTopic(topic).replace(/ /g, "-"), duration].filter(Boolean).join("_") + ".md";
}
