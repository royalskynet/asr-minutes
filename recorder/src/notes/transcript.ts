// transcript.ts — 即時逐字稿 buffer + append 寫 Markdown
//
// 邊開會邊寫檔：每句 final 即 append 到 .md 的逐字稿區，會議結束再補摘要區。
// 會後精修（refine）可用 replaceLines() 整份覆寫逐字稿區，保留 frontmatter 與標頭。

import { createWriteStream, type WriteStream } from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { getDuration, getTopic, taggedName } from "./mdfile.ts";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR ?? join(__dirname, "..", "..", "out");

export interface TranscriptLine {
  /** 開始毫秒（絕對 epoch ms，供套用會議時區鐘戳） */
  t: number;
  speaker: string; // "對方" | "本人" | ...
  text: string;
}

export class Transcript {
  readonly path: string;
  private stream: WriteStream;
  private startMs: number;
  private lines: TranscriptLine[] = [];
  private engine: string;
  private source: string;
  private dateStr: string;
  private timeStr: string;

  constructor(opts: { source?: string; engine: string; startMs: number; dateStr: string; timeStr: string }) {
    mkdirSync(OUT_DIR, { recursive: true });
    this.path = join(OUT_DIR, `${opts.dateStr}-${opts.timeStr}.md`);
    this.startMs = opts.startMs;
    this.engine = opts.engine;
    this.source = opts.source ?? "系統音訊";
    this.dateStr = opts.dateStr;
    this.timeStr = opts.timeStr;
    this.stream = createWriteStream(this.path, { flags: "w" });
    this.writeHeader();
  }

  private writeHeader() {
    this.stream.write(
      `---\n` +
        `date: ${this.dateStr}\n` +
        `time: ${this.timeStr}\n` +
        `source: ${this.source}\n` +
        `stt: ${this.engine}\n` +
        `---\n\n` +
        `# 會議記錄 ${this.dateStr} ${this.timeStr}\n\n` +
        `## 逐字稿\n\n`
    );
  }

  // 北京時間（Asia/Shanghai, UTC+8）時鐘戳，HH:MM:SS
  private fmtTime(ms: number): string {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ms));
  }

  private lineText(line: TranscriptLine): string {
    return `[${this.fmtTime(line.t)}] ${line.speaker}：${line.text}\n\n`;
  }

  /** 一句 final 即時寫入 */
  append(speaker: string, text: string, atMs: number) {
    const line: TranscriptLine = { t: atMs, speaker, text };
    this.lines.push(line);
    this.stream.write(this.lineText(line));
  }

  /** 以精修稿整份覆寫逐字稿區：flush 舊串流 → 重寫 header + 新句（供 refine 用） */
  async replaceLines(lines: TranscriptLine[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    this.lines = lines;
    this.stream = createWriteStream(this.path, { flags: "w" });
    this.writeHeader();
    for (const l of lines) this.stream.write(this.lineText(l));
  }

  /** 純文字逐字稿（餵給 LLM 摘要用） */
  plainText(): string {
    return this.lines.map((l) => `${l.speaker}：${l.text}`).join("\n");
  }

  /** 會議結束，補摘要區，關檔 */
  finish(summaryMarkdown: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.write(`\n---\n\n## 重點摘要\n\n${summaryMarkdown}\n`);
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

/** 依 frontmatter topic + 時長把檔案改名為 <stem>_<主題>_<時長>.md；回傳新路徑（未變或撞名則原路徑） */
export function retagFile(fp: string): string {
  const md = readFileSync(fp, "utf8");
  const next = join(dirname(fp), taggedName(basename(fp), getTopic(md), getDuration(md)));
  if (next === fp || existsSync(next)) return fp;
  renameSync(fp, next);
  return next;
}
