#!/usr/bin/env bun
// backfill-tags.ts — 既有記錄一次補齊：重跑失敗/缺漏摘要 → 補主題 + 時長 → 改檔名 <stem>_<主題>_<時長>.md
//
// 用法（App 資料夾）：
//   OUT_DIR=~/Library/Application\ Support/AudioMeetingNotes/out \
//   CONFIG_DIR=~/Library/Application\ Support/AudioMeetingNotes/config bun run scripts/backfill-tags.ts
// 可重跑：已有主題/摘要者跳過；手動改過的主題不覆蓋。

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractTranscript, getContext, getDuration, getMeta, getSummary, getTopic, replaceSummary, setMeta, setTopic } from "../src/notes/mdfile.ts";
import { genTopic, summarize } from "../src/notes/summarize.ts";
import { retagFile } from "../src/notes/transcript.ts";
import { readGlossary } from "../src/notes/clean.ts";
import { loadSettings } from "../src/auto-record/settings.ts";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = process.env.OUT_DIR ?? join(ROOT, "out");
const CONFIG_DIR = process.env.CONFIG_DIR ?? join(ROOT, "config");
const MIN_LINES = 5; // 太短的檔（誤觸錄音）不生主題/摘要，只補時長
const read = (f: string) => { try { return readFileSync(join(CONFIG_DIR, f), "utf8"); } catch { return ""; } };
const assistant = read("assistant-prompt.txt");
const glossary = readGlossary();
const { providers } = loadSettings(join(CONFIG_DIR, "settings.json"));

for (const name of readdirSync(OUT_DIR).filter((f) => f.endsWith(".md")).sort()) {
  const fp = join(OUT_DIR, name);
  let md = readFileSync(fp, "utf8");
  const raw = extractTranscript(md);
  const lines = raw ? raw.split("\n").length : 0;
  const log: string[] = [];
  try {
    const sum = getSummary(md);
    if (lines >= MIN_LINES && (!sum || sum.includes("摘要失敗"))) {
      const dm = name.match(/(\d{4})-(\d{2})-(\d{2})/);
      const r = await summarize(raw, { assistant, context: getContext(md), glossary, providers, dateHint: dm ? dm[1] + dm[2] + dm[3] : "" });
      md = replaceSummary(md, r.markdown);
      log.push(`摘要✓(${r.provider})`);
    }
    if (lines >= MIN_LINES && !getTopic(md)) {
      const s = getSummary(md);
      md = setTopic(md, await genTopic(s && !s.includes("摘要失敗") ? s : raw, providers));
      log.push(`主題=${getTopic(md)}`);
    }
    if (!getMeta(md, "duration") && getDuration(md)) md = setMeta(md, "duration", getDuration(md));
  } catch (e) {
    log.push(`✗ ${(e as Error).message.split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
  }
  writeFileSync(fp, md);
  const next = retagFile(fp);
  console.log(`${name} → ${next.slice(OUT_DIR.length + 1)}  ${log.join(" ")}`);
}
