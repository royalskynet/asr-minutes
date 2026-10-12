#!/usr/bin/env bun
// index.ts — 主編排：截系統音訊 → 本地 STT → 即時逐字稿 → 結束摘要 →（可選）SenseVoice 離線精修
//
// 用法：
//   bun run src/index.ts                 # 開始錄，Ctrl-C 結束
//   bun run src/index.ts --minutes 30    # 錄 30 分鐘自動結束
//
// 結束流程（shutdown）：
//   cap.stop() → stt.close() → 若開精修：
//     釋放串流 STT → silero VAD 切段 → SenseVoice 離線辨識 →
//     replaceLines 覆寫逐字稿 → 成功回退即時稿 → 隱私守約刪音檔（除非 keepAudio）
//
// v1：系統輸出單軌（= 遠端與會者，標記「對方」）。本人麥克風軌列 v2。

import { startCapture } from "./capture/index.ts";
import { createLocalSTT } from "./stt/local.ts";
import { Transcript, retagFile } from "./notes/transcript.ts";
import { genTopic, summarize } from "./notes/summarize.ts";
import { readGlossary } from "./notes/clean.ts";
import { fmtDuration, setMeta, setTopic } from "./notes/mdfile.ts";
import { WavWriter } from "./capture/wav.ts";
import { refineWav } from "./stt/refine.ts";
import { loadSettings } from "./auto-record/settings.ts";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = process.env.OUT_DIR ?? join(ROOT, "out");
const SETTINGS_FILE = join(ROOT, "config", "settings.json");

function parseArgs() {
  const a = process.argv.slice(2);
  let minutes = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--minutes") minutes = Number(a[++i]);
  }
  return { minutes };
}

function nowStrings() {
  // 北京時間（Asia/Shanghai, UTC+8）
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((x) => x.type === t)!.value;
  return {
    dateStr: `${g("year")}-${g("month")}-${g("day")}`,
    timeStr: `${g("hour")}${g("minute")}`,
  };
}

/** refining 哨兵檔：server 靠它顯示「精修中…」 */
function markerRefining(on: boolean) {
  try {
    const f = join(OUT_DIR, ".refining");
    if (on) writeFileSync(f, new Date().toISOString());
    else unlinkSync(f);
  } catch {
    /* 哨兵失敗不影響主流程 */
  }
}

async function main() {
  const { minutes } = parseArgs();
  const startMs = Date.now();
  const { dateStr, timeStr } = nowStrings();
  const settings = loadSettings(SETTINGS_FILE);
  const refineOn = settings.refineOn;
  const keepAudio = settings.keepAudio;

  const transcript = new Transcript({
    source: "Audio / 系統音訊",
    engine: "sherpa-onnx-streaming-zipformer-zh-en-int8",
    startMs,
    dateStr,
    timeStr,
  });

  console.error(`▶ 開始錄音轉錄 → ${transcript.path}`);
  console.error(
    `  (Ctrl-C 結束並生成摘要${minutes ? `，或 ${minutes} 分鐘後自動結束` : ""})${
      refineOn ? "\n  · 會後將以 SenseVoice 離線精修逐字稿" : ""
    }\n`
  );

  let stt = createLocalSTT({
    onPartial: (text) => {
      process.stderr.write(`\r  … ${text.slice(-60)}        `);
    },
    onFinal: (text) => {
      process.stderr.write(`\r`);
      console.error(`  對方：${text}`);
      transcript.append("對方", text, Date.now());
    },
  });

  // 簡易 RMS 能量門檻：靜音不餵 STT（避免底噪被解成幻覺文字）。
  // hangover：偵測到聲音後續餵數塊靜音，讓模型 endpoint 規則能觸發斷句。
  const GATE_RMS = Number(process.env.GATE_RMS ?? 350); // s16 振幅門檻
  const HANGOVER_CHUNKS = 8; // ~1.6s（200ms/塊）
  let hangover = 0;
  function rms(pcm: Buffer): number {
    const n = Math.floor(pcm.length / 2);
    if (!n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const s = pcm.readInt16LE(i * 2);
      sum += s * s;
    }
    return Math.sqrt(sum / n);
  }

  // pipeline tee：同一份 PCM 同時餵 streaming STT（即時）與 wav writer（離線精修用）
  const wavPath = transcript.path.replace(/\.md$/, ".wav");
  const wav = refineOn ? new WavWriter(wavPath, { sampleRate: 16000 }) : null;

  const cap = startCapture({ sampleRate: 16000 });
  cap.onAudio((pcm) => {
    if (wav) wav.write(pcm); // 全量寫入，不受能量門檻影響
    if (rms(pcm) >= GATE_RMS) hangover = HANGOVER_CHUNKS;
    if (hangover > 0) {
      stt.feed(pcm);
      hangover--;
    }
  });
  cap.onMetadata((m) => console.error(`  [截音] ${m.encoding} ${m.sample_rate}Hz mono\n`));

  let finishing = false;
  async function shutdown() {
    if (finishing) return;
    finishing = true;
    const durMs = Date.now() - startMs; // 會議時長以按下結束為準（不含精修/摘要耗時）
    console.error("\n■ 結束中，生成摘要…");
    cap.stop();
    stt.close();
    stt = null as never; // 釋放串流 detect 模型（避免與離線 SenseVoice 同時佔 RAM）

    // 會後離線精修
    if (refineOn && wav) {
      markerRefining(true);
      try {
        await wav.end();
        console.error("  [精修] SenseVoice 離線精修中…（長音檔需數分鐘）");
        const segments = refineWav(wavPath);
        if (segments.length) {
          const lines = segments.map((s) => ({
            t: startMs + Math.round(s.startSec * 1000),
            speaker: "對方",
            text: s.text,
          }));
          await transcript.replaceLines(lines);
          console.error(`  [精修] ✓ 完成 ${segments.length} 段，逐字稿已覆寫`);
        } else {
          console.error("  [精修] 未偵測到語音段，沿用即時稿");
        }
      } catch (e) {
        console.error(`  [精修] ✗ 失敗，回退即時稿：${(e as Error).message}`);
      } finally {
        markerRefining(false);
      }
    }

    // 隱私守約：精修完成後預設刪音檔，僅設 keepAudio 時保留
    if (wav && !keepAudio) {
      try {
        unlinkSync(wavPath);
        console.error("  [隱私] 已刪音檔" + (refineOn ? "" : "（未開精修）"));
      } catch {
        /* 不存在即忽略 */
      }
    }

    let topicSrc = transcript.plainText();
    try {
      const { provider, markdown } = await summarize(topicSrc, { glossary: readGlossary(), providers: settings.providers });
      await transcript.finish(markdown);
      topicSrc = markdown;
      console.error(`✓ 摘要完成（${provider}）`);
    } catch (e) {
      await transcript.finish(`_（摘要失敗：${(e as Error).message}）_`);
      console.error(`✗ 摘要失敗，逐字稿已保留`);
    }

    // 標籤：時長 + 自動主題寫 frontmatter，檔名改為 <日期時間>_<主題>_<時長>.md
    let finalPath = transcript.path;
    try {
      let md = setMeta(readFileSync(finalPath, "utf8"), "duration", fmtDuration(durMs));
      try {
        md = setTopic(md, await genTopic(topicSrc, settings.providers));
      } catch (e) {
        console.error(`  [主題] ✗ 生成失敗：${(e as Error).message}`);
      }
      writeFileSync(finalPath, md);
      finalPath = retagFile(finalPath);
    } catch (e) {
      console.error(`  [標籤] ✗ 失敗，保留原檔名：${(e as Error).message}`);
    }
    console.error(`✓ 會議記錄：${finalPath}`);
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (minutes > 0) setTimeout(shutdown, minutes * 60 * 1000);
  cap.onClose(() => shutdown());
}

main();
