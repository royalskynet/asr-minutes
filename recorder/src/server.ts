#!/usr/bin/env bun
// server.ts — 本地 Web UI：錄製控制 + 逐字稿/摘要檢視、搜尋、就地修正、摘要再加工
//
// 用法：bun run src/server.ts  → 開 http://localhost:7321
// 純本地、無外部 CDN（內網／離線環境可用）。不存音檔（隱私）。
// 設計：廣播控制台 × 社論手稿（深墨 + ember 橘，macOS 在地字型）。

import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { openPath } from "./platform.ts";
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { genTopic, summarize, translateSummary, type Lang } from "./notes/summarize.ts";
import { retagFile } from "./notes/transcript.ts";
import { readGlossary } from "./notes/clean.ts";
import { complete, type ProviderEntry } from "./llm/router.ts";
import { extractTranscript, getSummary, replaceSummary, editUtterance, toggleTodo, getContext, setContext, getTopic, setTopic, getDuration, nameStem } from "./notes/mdfile.ts";
import { loadSettings, saveSettings } from "./auto-record/settings.ts";
import { createDetectionState, observeSample, suppressCurrentActivity, type RecorderOrigin } from "./auto-record/state.ts";
import { startMeetingAudioWatcher, type WatcherHandle } from "./auto-record/watcher.ts";
import { askToStartRecording } from "./auto-record/prompt.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = process.env.OUT_DIR ?? join(ROOT, "out");
const INDEX_TS = join(__dirname, "index.ts");
const PORT = Number(process.env.PORT ?? 7321);
// 檔名可含中文主題（見 mdfile.taggedName）；禁路徑分隔與 NUL 即不會跳出 OUT_DIR
const NAME_RE = /^[^\/\\\0]+\.md$/;
const CONFIG_DIR = process.env.CONFIG_DIR ?? join(ROOT, "config");
const ASSISTANT_FILE = join(CONFIG_DIR, "assistant-prompt.txt");
const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");
const MEETING_WATCHER_BIN = join(ROOT, "bin", "meeting-audio-watch");
let settings = loadSettings(SETTINGS_FILE);

// ── 首次下載模型 ──
const MODEL_NAME = "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20";
const MODEL_TAR_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`;
const STT_MODEL_DIR = process.env.STT_MODEL_DIR ?? join(ROOT, "models", MODEL_NAME);
const MODEL_FILES = [
  "encoder-epoch-99-avg-1.int8.onnx",
  "decoder-epoch-99-avg-1.onnx",
  "joiner-epoch-99-avg-1.int8.onnx",
  "tokens.txt",
];
function modelReady(): boolean {
  try { return MODEL_FILES.every((f) => { statSync(join(STT_MODEL_DIR, f)); return true; }); } catch { return false; }
}
let downloadState: { downloading: boolean; progress: number; error?: string } = { downloading: false, progress: 0 };

function readAssistant(): string {
  try { return readFileSync(ASSISTANT_FILE, "utf8"); } catch { return ""; }
}
function writeAssistant(text: string) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(ASSISTANT_FILE, text);
}

let recorder: ChildProcess | null = null;
let recordingOrigin: RecorderOrigin = null;
let recordingFile: string | null = null;
let startedAt = 0;
let phase: "idle" | "recording" = "idle";
// 每場結束後的摘要子程序：child → 該場檔名（poll 尚未抓到檔名時為 null）。
// 與 recorder 解耦，讓摘要生成中仍可立即開始下一場錄音。
const summarizers = new Map<ChildProcess, string | null>();
let recPoll: ReturnType<typeof setInterval> | null = null;

function fileTitle(md: string): string {
  const c = getContext(md);
  if (!c) return "";
  const first = c.split("\n").map((x) => x.trim()).find(Boolean) || "";
  return first.replace(/^#+\s*/, "").replace(/[#*`>]/g, "").slice(0, 24);
}

function listMd() {
  let files: string[] = [];
  try {
    files = readdirSync(OUT_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return files
    .map((name) => {
      const st = statSync(join(OUT_DIR, name));
      let md = "";
      try { md = readFileSync(join(OUT_DIR, name), "utf8"); } catch {}
      return { name, size: st.size, mtime: st.mtimeMs, title: fileTitle(md), topic: getTopic(md), duration: getDuration(md) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function newestMd(): string | null {
  const l = listMd();
  return l.length ? l[0].name : null;
}

function safePath(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  const fp = join(OUT_DIR, name);
  if (existsSync(fp)) return fp;
  // 檔案已被加標籤改名（前端仍持舊名）→ 以日期時間 stem 找回
  const stem = nameStem(name);
  const hit = listMd().find((f) => nameStem(f.name) === stem);
  return hit ? join(OUT_DIR, hit.name) : fp;
}

/** 依 topic/時長改檔名；錄製中或會後摘要中的檔（子程序會自行改名）不動 */
function retag(fp: string): string {
  const name = basename(fp);
  if (name === recordingFile || [...summarizers.values()].includes(name)) return name;
  return basename(retagFile(fp));
}

function startRecording(origin: Exclude<RecorderOrigin, null> = "manual") {
  if (recorder) return;
  if (!modelReady()) { console.error("⚠ 模型未就緒，請先下載模型"); return; }
  const before = new Set(listMd().map((f) => f.name));
  recorder = spawn(process.execPath, ["run", INDEX_TS], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
  recordingOrigin = origin;
  phase = "recording";
  startedAt = Date.now();
  recordingFile = null;
  recPoll = setInterval(() => {
    const fresh = listMd().map((f) => f.name).find((f) => !before.has(f));
    if (fresh) { recordingFile = fresh; if (recPoll) { clearInterval(recPoll); recPoll = null; } }
  }, 500);
  recorder.on("exit", () => {
    recorder = null;
    recordingOrigin = null;
    phase = "idle";
    startedAt = 0;
    if (recPoll) { clearInterval(recPoll); recPoll = null; }
  });
}

function stopRecording(suppressMeeting = false) {
  if (!recorder) return;
  if (suppressMeeting) suppressCurrentActivity(detectionState);
  const child = recorder;
  const file = recordingFile;
  if (recPoll) { clearInterval(recPoll); recPoll = null; }  // 舊場檔名 poll 必停，防事後寫入污染下一場 recordingFile
  recorder = null;
  recordingOrigin = null;
  recordingFile = null;
  startedAt = 0;
  phase = "idle";
  summarizers.set(child, file);
  child.removeAllListeners("exit");
  child.on("exit", () => { summarizers.delete(child); });
  child.kill("SIGINT");
}

const detectionState = createDetectionState();
let watcher: WatcherHandle | null = null;
let watcherError = "";
let meetingActive = false;
let activityGeneration = 0;

async function handleMeetingSample(active: boolean) {
  watcherError = "";
  if (active !== meetingActive) { meetingActive = active; activityGeneration++; }
  const { action } = observeSample(detectionState, {
    active,
    now: Date.now(),
    enabled: settings.autoDetectMeeting,
    mode: settings.meetingDetectionMode,
    recordingOrigin,
  });
  if (action === "start") startRecording("meeting");
  if (action === "stop" && recordingOrigin === "meeting") stopRecording(false);
  if (action === "prompt") {
    const generation = activityGeneration;
    const accepted = await askToStartRecording();
    if (accepted && generation === activityGeneration && detectionState.rawActive &&
        settings.autoDetectMeeting && settings.meetingDetectionMode === "prompt" && !recorder) {
      startRecording("meeting");
    }
  }
}

if (process.platform === "darwin" && existsSync(MEETING_WATCHER_BIN)) {
  watcher = startMeetingAudioWatcher({
    binary: MEETING_WATCHER_BIN,
    onSample: (active) => { void handleMeetingSample(active); },
    onError: (message) => { watcherError = message; },
  });
} else {
  watcherError = process.platform === "darwin" ? "缺少會議偵測程式，請重新執行 setup" : "僅支援 macOS";
}

// markdown → HTML（frontmatter / 逐字稿行帶索引 / 摘要小節 / 可勾選待辦）
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  let meta = "";
  if (md.startsWith("---\n")) {
    const end = md.indexOf("\n---", 4);
    if (end !== -1) {
      meta = md.slice(4, end).split("\n").filter(Boolean)
        .map((l) => {
          const i = l.indexOf(":");
          const k = i > 0 ? l.slice(0, i) : "";
          const v = i > 0 ? l.slice(i + 1).trim() : l;
          return `<div class="meta"><span class="mk">${esc(k)}</span><span class="mv">${esc(v)}</span></div>`;
        }).join("");
      md = md.slice(end + 4);
    }
  }

  const lines = md.split("\n");
  let html = "";
  let inList = false;
  let inTbl = false;
  let uttN = -1;
  let todoN = -1;
  const closeList = () => {
    if (inList) { html += "</ul>"; inList = false; }
    if (inTbl) { html += "</table>"; inTbl = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^：:]{1,16})[：:]\s*(.*)$/))) {
      closeList();
      uttN++;
      html += `<div class="utt" data-i="${uttN}"><time>${esc(m[1])}</time>` +
        `<div class="body"><span class="who">${esc(m[2])}</span><p>${inline(m[3])}</p></div>` +
        `<div class="acts"><button class="mini" data-act="edit" title="編輯">✎</button>` +
        `<button class="mini" data-act="copy" title="複製此句">⧉</button></div></div>`;
    } else if (/^\|.*\|$/.test(line)) {
      // 紀要方法論的行動計劃／問答表格；分隔列 |---| 略過
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      const cells = line.slice(1, -1).split("|").map((c) => `<td>${inline(c.trim())}</td>`).join("");
      if (!inTbl) { closeList(); html += "<table class='mdt'>"; inTbl = true; }
      html += `<tr>${cells}</tr>`;
    } else if (/^---\s*$/.test(line)) {
      closeList(); html += "<hr>";
    } else if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      closeList();
      const lvl = m[1].length;
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
    } else if ((m = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)/))) {
      if (!inList) { html += "<ul class='todo'>"; inList = true; }
      todoN++;
      const done = m[1].toLowerCase() === "x";
      html += `<li class="${done ? "done" : ""}" data-todo="${todoN}">${inline(m[2])}</li>`;
    } else if ((m = line.match(/^[-*]\s+(.*)/))) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^([一二三四五六七八九十]+、|\d+\.\d+\s)(.{1,40})$/))) {
      // 紀要章節「一、…」／子節「4.1 …」→ 標題
      closeList();
      const lvl = m[1].includes("、") ? 3 : 4;
      html += `<h${lvl}>${inline(m[1] + m[2])}</h${lvl}>`;
    } else if (line === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return (meta ? `<div class="metabox">${meta}</div>` : "") + html;
}

const BUILD = new Date().toLocaleString('sv').slice(5,16);  // 月-日 時:分，辨識新舊頁
const PAGE = /* html */ `<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>會議記錄 · 控制台</title>
<style>
:root{
  --ink:#0c0b0a; --ink2:#16130f; --ink3:#1f1b15; --line:#2c2820;
  --fg:#ece6da; --mut:#8c8270; --faint:#5e574a;
  --ember:#ff7a18; --ember-dim:#7a3a0e; --brass:#c9a24b; --signal:#7fb27a;
  --serif:"Hoefler Text","Iowan Old Style",Palatino,Georgia,serif;
  --sans:"PingFang TC",-apple-system,"Helvetica Neue",sans-serif;
  --mono:"SF Mono",Menlo,ui-monospace,monospace;
}
*{box-sizing:border-box}
.mdt{border-collapse:collapse;margin:.6em 0}.mdt td{border:1px solid var(--line);padding:4px 8px;vertical-align:top}.mdt tr:first-child td{color:var(--brass)}
html,body{height:100%}
body{margin:0;color:var(--fg);font-family:var(--sans);font-size:15px;line-height:1.65;
  background:var(--ink);
  background-image:radial-gradient(120% 90% at 18% 0%,#1a1611 0%,transparent 55%),radial-gradient(140% 120% at 100% 100%,#13110d 0%,transparent 60%);
  display:flex;overflow:hidden}
body::after{content:"";position:fixed;inset:0;pointer-events:none;opacity:.05;mix-blend-mode:overlay;z-index:99;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")}

/* ── 左：控制台 ── */
#console{width:var(--sidew,324px);flex-shrink:0;height:100%;display:flex;flex-direction:column;
  background:linear-gradient(180deg,var(--ink2),#100d0a);border-right:1px solid var(--line);
  box-shadow:1px 0 0 #000 inset,24px 0 60px -40px #000;animation:slidein .6s cubic-bezier(.2,.8,.2,1) both}
@keyframes slidein{from{transform:translateX(-12px);opacity:0}to{transform:none;opacity:1}}
.brand{padding:24px 26px 18px;border-bottom:1px solid var(--line)}
.mark{font-family:var(--mono);font-size:11px;letter-spacing:.32em;color:var(--ember);text-transform:uppercase;display:flex;align-items:center;gap:7px}
.mark .lamp{width:7px;height:7px;border-radius:50%;background:var(--faint)}
body[data-phase=recording] .mark .lamp{background:var(--ember);box-shadow:0 0 10px 1px var(--ember);animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:.25}}
.brand h1{font-family:var(--serif);font-weight:600;font-size:38px;line-height:.98;margin:12px 0 6px}
.brand .sub{font-size:12px;color:var(--mut);letter-spacing:.06em}

.deck{padding:20px 26px;border-bottom:1px solid var(--line)}
#status{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--mut);font-family:var(--mono);letter-spacing:.06em;margin-bottom:14px;min-height:18px}
.eq{display:inline-flex;align-items:flex-end;gap:2px;height:14px}
.eq i{width:3px;height:4px;background:var(--ember-dim);border-radius:1px}
body[data-phase=recording] .eq i{background:var(--ember);animation:bounce .9s ease-in-out infinite}
body[data-phase=recording] .eq i:nth-child(2){animation-delay:.15s}
body[data-phase=recording] .eq i:nth-child(3){animation-delay:.3s}
body[data-phase=recording] .eq i:nth-child(4){animation-delay:.45s}
body[data-sum] .eq i{background:var(--brass);animation:bounce 1.4s ease-in-out infinite}
body[data-sum] .eq i:nth-child(2){animation-delay:.2s}
body[data-sum] .eq i:nth-child(3){animation-delay:.4s}
body[data-sum] .eq i:nth-child(4){animation-delay:.6s}
body[data-sum] #stxt{color:var(--brass);font-size:15px;font-weight:700;letter-spacing:.12em}
@keyframes bounce{0%,100%{height:4px}50%{height:14px}}
#timer{margin-left:auto;font-family:var(--mono);font-size:13px;color:var(--ember);font-variant-numeric:tabular-nums;display:none}
body[data-phase=recording] #timer{display:inline}

.ctrl{display:flex;gap:10px}
button{font-family:var(--sans);font-size:14px;border:0;cursor:pointer;color:var(--fg)}
.ctrl button{flex:1;padding:13px 10px;border-radius:11px;font-weight:600;letter-spacing:.04em;transition:transform .12s,box-shadow .2s,background .2s,opacity .2s}
#start{background:linear-gradient(180deg,#ff8a2e,#ed6207);color:#1a0d02;box-shadow:0 6px 18px -6px var(--ember),0 0 0 1px #ffae6e inset}
#start:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 9px 22px -6px var(--ember),0 0 0 1px #ffc596 inset}
#stop{background:#211c16;box-shadow:0 0 0 1px var(--line) inset}
#stop:hover:not(:disabled){background:#2a231b;box-shadow:0 0 0 1px var(--brass) inset}
button:disabled{opacity:.32;cursor:default}button:active:not(:disabled){transform:translateY(1px)}
:focus-visible{outline:2px solid var(--brass);outline-offset:2px}

.ffilter-wrap{padding:14px 22px 6px}
#ffilter{width:100%;background:#100d0a;border:1px solid var(--line);border-radius:9px;padding:9px 12px;color:var(--fg);font-family:var(--mono);font-size:12.5px}
#ffilter::placeholder{color:var(--faint)}#ffilter:focus{outline:none;border-color:var(--brass)}
.files-h{padding:10px 26px 8px;font-family:var(--mono);font-size:10.5px;letter-spacing:.28em;text-transform:uppercase;color:var(--faint);display:flex;justify-content:space-between}
.files-h #fcount{color:var(--brass)}
#files{overflow-y:auto;flex:1;padding:0 14px 16px}
.fday>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;padding:8px 4px 6px;font-size:12px;font-weight:600;color:var(--mut);position:sticky;top:0;background:var(--ink2);z-index:1}
.fday>summary::-webkit-details-marker{display:none}
.fday>summary::before{content:'▸';transition:transform .15s}.fday[open]>summary::before{transform:rotate(90deg)}
.fday>summary span{margin-left:auto;color:var(--faint);font-weight:400}
#files::-webkit-scrollbar{width:9px}#files::-webkit-scrollbar-thumb{background:#241f18;border-radius:5px;border:2px solid var(--ink2)}
.f{padding:11px 13px;border-radius:10px;cursor:pointer;border:1px solid transparent;position:relative;transition:background .15s,border-color .15s}
.f:hover{background:#1c1812}.f.sel{background:#1f1a13;border-color:var(--line)}
.f.sel::before{content:"";position:absolute;left:0;top:13px;bottom:13px;width:3px;border-radius:3px;background:var(--ember)}
.f.live .n::after{content:"● 錄製中";color:var(--ember);font-size:10px;margin-left:8px;letter-spacing:.1em}
.f.sum .n::after{content:"◌ 摘要中";color:var(--brass);font-size:10px;margin-left:8px;letter-spacing:.1em}
.f .n{font-family:var(--mono);font-size:13px;color:var(--fg)}
.f .m{font-size:11px;color:var(--mut);margin-top:2px;letter-spacing:.03em}
.f .tpb{background:none;border:none;color:var(--mut);cursor:pointer;padding:0 3px;font-size:11px;opacity:.55;line-height:1}
.f .tpb:hover{color:var(--ember);opacity:1}

/* ── 右：手稿台 ── */
#splitter{width:6px;margin:0 -3px;flex-shrink:0;cursor:col-resize;z-index:5;position:relative}
#splitter:hover,#splitter.drag{background:linear-gradient(90deg,transparent 2px,var(--brass) 2px,var(--brass) 4px,transparent 4px)}
#stage{flex:1;height:100%;display:flex;flex-direction:column;min-width:0;position:relative;animation:fadein .7s ease .15s both}
@keyframes fadein{from{opacity:0}to{opacity:1}}
#bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:13px 22px;border-bottom:1px solid var(--line);
  background:linear-gradient(180deg,rgba(22,19,15,.7),transparent);backdrop-filter:blur(6px)}
.find{display:flex;align-items:center;gap:6px;flex:1;min-width:180px}
#find{flex:1;background:#100d0a;border:1px solid var(--line);border-radius:8px;padding:7px 11px;color:var(--fg);font-size:13px}
#find::placeholder{color:var(--faint)}#find:focus{outline:none;border-color:var(--brass)}
#findcount{font-family:var(--mono);font-size:11px;color:var(--mut);min-width:34px;text-align:right}
.ghost{padding:7px 11px;border-radius:8px;font-size:12.5px;background:transparent;color:var(--mut);box-shadow:0 0 0 1px var(--line) inset;transition:color .15s,box-shadow .15s;white-space:nowrap}
.ghost:hover{color:var(--fg);box-shadow:0 0 0 1px var(--brass) inset}
.ghost.warm:hover{color:var(--ember);box-shadow:0 0 0 1px var(--ember) inset}
.sep{width:1px;height:20px;background:var(--line);margin:0 2px}
#bar .sp{width:100%;order:9;font-family:var(--mono);font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-top:2px}

#view{flex:1;overflow-y:auto;padding:42px 0;scroll-behavior:smooth}
#view::-webkit-scrollbar{width:11px}#view::-webkit-scrollbar-thumb{background:#221d16;border-radius:6px;border:2px solid var(--ink)}
.doc{max-width:760px;margin:0 auto;padding:0 56px}
mark{background:var(--brass);color:#1a0d02;border-radius:2px;padding:0 1px}
mark.cur{background:var(--ember);box-shadow:0 0 0 2px var(--ember)}

#jump{position:absolute;right:26px;bottom:24px;background:var(--ember);color:#1a0d02;font-weight:600;
  padding:10px 16px;border-radius:22px;box-shadow:0 8px 22px -6px var(--ember);display:none;z-index:5}
#jump.show{display:block;animation:pop .25s ease}
.modal-bg{position:fixed;inset:0;background:rgba(8,6,4,.62);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;z-index:200;padding:20px}
.modal-bg.show{display:flex}
.modal-box{width:min(580px,94vw);max-height:86vh;display:flex;flex-direction:column;background:linear-gradient(180deg,#1c1813,#15110d);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 30px 80px -20px #000}
.modal-box .mt{font-family:var(--serif);font-size:22px;margin-bottom:6px}
.modal-box .mh{font-size:12.5px;color:var(--mut);margin-bottom:14px;line-height:1.55}
.modal-box textarea{width:100%;flex:1;min-height:190px;resize:vertical;background:#100d0a;border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:var(--fg);font-family:inherit;font-size:14px;line-height:1.6}
.modal-box textarea:focus{outline:none;border-color:var(--ember)}
.modal-box .mbody{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}
.mtabs{display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid var(--line)}
.mtabs button{background:none;border:0;border-bottom:2px solid transparent;color:var(--mut);padding:6px 10px;font:inherit;font-size:13px;cursor:pointer}
.mtabs button.on{color:var(--fg);border-bottom-color:var(--ember)}
.meeting-settings{margin:0 0 14px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#100d0a}
.meeting-settings label{display:flex;align-items:center;gap:8px;margin:5px 0;color:var(--fg);font-size:13px}
.meeting-settings .modes{padding-left:24px;color:var(--mut)}
.meeting-settings input{accent-color:var(--ember)}
.prow{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:6px;background:#100d0a}
.prow-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px}
.prow-main .ptype{font-family:var(--mono);color:var(--ember);font-weight:600}
.prow-main .pmeta{color:var(--mut);font-family:var(--mono);font-size:11px}
.prow-main .pkey{color:var(--signal);font-size:11px}
.prow .pacts{display:flex;align-items:center;gap:5px;margin-top:6px}
.prow .pacts .mini{width:24px;height:24px;font-size:12px}
.prow .ptoggle{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--mut);margin-left:4px}
.prow .povr{display:flex;gap:6px;margin-top:6px}
.prow .povr input{flex:1;background:#0c0a08;border:1px solid var(--line);border-radius:6px;padding:5px 8px;color:var(--fg);font-family:var(--mono);font-size:11.5px}
.prow .povr input:focus{outline:none;border-color:var(--brass)}
.prow .povr .pdoc{align-self:center;font-size:11px;color:var(--brass);white-space:nowrap;text-decoration:none}
.prow .povrhint{font-size:11px;color:var(--faint);align-self:center}
.mbtns{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
.mbtns button{padding:9px 18px;border-radius:9px}
.langsel{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.langsel button{background:transparent;border:none;color:var(--mut);padding:4px 9px;font-size:12px;cursor:pointer;font-family:inherit}
.langsel button:hover{color:var(--fg)}
.langsel button.on{background:var(--ember);color:#1a0d02;font-weight:600}
.langsel.sm button{padding:3px 7px;font-size:11px}
.brand .topline{display:flex;align-items:center;justify-content:space-between;gap:8px}
#bar .lbl{font-size:12px;color:var(--mut);align-self:center;white-space:nowrap}
.ghost.primary{background:var(--ember);color:#1a0d02;border-color:transparent;font-weight:600}
.ghost.primary:hover{filter:brightness(1.08)}
.ghost.icon{padding:6px 11px;font-size:17px;line-height:1;letter-spacing:1px}
.menu-wrap{position:relative;display:inline-flex}
.menu{position:absolute;right:0;top:calc(100% + 8px);min-width:190px;background:#1b1712;border:1px solid var(--line);border-radius:12px;padding:6px;box-shadow:0 24px 60px -18px #000;display:none;z-index:120}
.menu.show{display:block;animation:pop .18s ease}
.menu button{display:block;width:100%;background:transparent;border:none;color:var(--fg);padding:8px 12px;border-radius:8px;font-size:13px;text-align:left;cursor:pointer;font-family:inherit;white-space:nowrap}
.menu button:hover{background:rgba(255,255,255,.06)}
.menu .mdiv{height:1px;background:var(--line);margin:5px 6px}
.menu .mrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 12px}
.menu .mrow .langsel button{display:inline-block;width:auto;padding:3px 8px}
@keyframes pop{from{transform:scale(.85);opacity:0}to{transform:none;opacity:1}}

.metabox{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:30px}
.metabox .meta{background:var(--ink2);padding:8px 14px;flex:1 1 auto;min-width:140px}
.metabox .mk{display:block;font-family:var(--mono);font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint)}
.metabox .mv{font-size:13px;color:var(--fg)}

#view h1{font-family:var(--serif);font-weight:600;font-size:36px;line-height:1.05;margin:0 0 8px}
#view h2{font-family:var(--serif);font-weight:600;font-size:13px;letter-spacing:.26em;text-transform:uppercase;color:var(--brass);margin:46px 0 20px;padding-bottom:9px;border-bottom:1px solid var(--line)}
#view h3{font-family:var(--sans);font-weight:700;font-size:15px;color:var(--ember);margin:26px 0 10px;display:flex;align-items:center;gap:9px}
#view h3::before{content:"";width:14px;height:2px;background:var(--ember)}
#view hr{border:0;height:1px;background:linear-gradient(90deg,var(--line),transparent);margin:28px 0}
#view p{margin:9px 0;color:#dcd5c7}#view b{color:#fff;font-weight:600}
#view ul{margin:10px 0;padding-left:22px}#view li{margin:6px 0;color:#dcd5c7}
#view ul.todo{list-style:none;padding-left:2px}
#view ul.todo li{position:relative;padding-left:30px;margin:9px 0;cursor:pointer}
#view ul.todo li::before{content:"○";position:absolute;left:4px;color:var(--brass);font-size:15px;line-height:1.4}
#view ul.todo li:hover::before{color:var(--ember)}
#view ul.todo li.done{color:var(--mut);text-decoration:line-through}
#view ul.todo li.done::before{content:"●";color:var(--signal)}

.utt{display:grid;grid-template-columns:64px 1fr auto;gap:14px;padding:9px 8px 9px 0;border-bottom:1px dashed #211d16;border-radius:6px}
.utt time{font-family:var(--mono);font-size:11px;color:var(--faint);padding-top:4px;letter-spacing:.02em}
.utt .who{display:inline-block;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ember);font-family:var(--mono);margin-bottom:1px}
.utt .body p{margin:1px 0 0;color:#e4ddcf;line-height:1.7}
.utt:hover{background:#16130f}
.utt .acts{display:flex;gap:4px;align-items:flex-start;opacity:0;transition:opacity .15s}
.utt:hover .acts{opacity:1}
.mini{width:26px;height:26px;border-radius:7px;background:#221d16;color:var(--mut);font-size:13px;box-shadow:0 0 0 1px var(--line) inset}
.mini:hover{color:var(--ember)}
.edit-row{display:grid;grid-template-columns:64px 1fr;gap:14px;padding:10px 0;border-bottom:1px dashed #211d16}
.edit-row .ef{display:flex;flex-direction:column;gap:8px}
.edit-row select,.edit-row input{background:#100d0a;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--fg);font-family:var(--sans);font-size:14px}
.edit-row select:focus,.edit-row input:focus{outline:none;border-color:var(--brass)}
.edit-row .eb{display:flex;gap:8px}

.empty{max-width:760px;margin:90px auto;padding:0 56px;text-align:center;color:var(--mut)}
.empty .big{font-family:var(--serif);font-size:26px;color:var(--faint);margin-bottom:8px}
#bar{position:relative}#prog{position:absolute;left:0;top:0;height:2px;width:30%;border-radius:2px;background:linear-gradient(90deg,transparent,var(--ember),transparent);opacity:0;pointer-events:none}body.busy #prog,body[data-sum] #prog{opacity:1;animation:prog 1.1s ease-in-out infinite}@keyframes prog{0%{left:-30%}100%{left:100%}}body.busy,body[data-sum]{cursor:progress}body.busy #resumbtn,body.busy #refinebtn,body.busy #ctxbtn{opacity:.5}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#211c16;color:var(--fg);
  padding:11px 20px;border-radius:10px;box-shadow:0 10px 30px -8px #000,0 0 0 1px var(--line) inset;z-index:100;
  opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;font-size:13.5px}
.toast.show{opacity:1;transform:translateX(-50%) translateY(-4px)}
@media(max-width:780px){#console{width:248px}.doc,.empty{padding:0 28px}}
</style></head><body data-phase="idle">
<aside id="console">
  <div class="brand">
    <div class="topline"><div class="mark"><span class="lamp"></span>REC · AUDIO</div><div class="langsel" id="uilang"><button data-l="tw">繁</button><button data-l="cn">简</button><button data-l="en">EN</button></div></div>
    <h1 data-t="會議記錄">會議記錄</h1>
    <div class="sub" data-t="系統音訊 · 即時繁中轉錄">系統音訊 · 即時繁中轉錄</div>
    <button class="ghost" style="margin-top:12px;width:100%" onclick="editAssistant()" data-t="⚙ 會議助理設定">⚙ 會議助理設定</button>
  </div>
  <div class="deck">
    <div id="status"><span class="eq"><i></i><i></i><i></i><i></i></span><span id="stxt">閒置</span><span id="timer">00:00</span></div>
    <div class="ctrl">
      <button id="start" onclick="start()" data-t="▶ 開始">▶ 開始</button>
      <button id="stop" onclick="stop()" disabled data-t="■ 結束">■ 結束</button>
    </div>
  </div>
  <div class="ffilter-wrap"><input id="ffilter" placeholder="搜尋記錄…" data-tph="搜尋記錄…" oninput="renderFiles()"></div>
  <div class="files-h"><span data-t="已錄記錄">已錄記錄</span><span id="fcount">0</span></div>
  <div id="files"></div>
</aside>
<div id="splitter" title="拖拉調整寬度，雙擊還原"></div>
<main id="stage">
  <header id="bar">
    <div id="prog"></div>
    <div class="find"><input id="find" placeholder="稿內搜尋  /  （Enter 下一個）" data-tph="稿內搜尋  /  （Enter 下一個）"><span id="findcount"></span></div>
    <button class="ghost" id="gotosumbtn" onclick="toSummary()" data-t="↧ 跳到摘要">↧ 跳到摘要</button>
    <button class="ghost" onclick="smartCopy()" data-t="智慧複製">智慧複製</button>
    <span class="sep"></span>
    <div class="menu-wrap">
      <button class="ghost icon" id="morebtn" onclick="toggleMenu(event)" title="更多" data-tt="更多">⋯</button>
      <div class="menu" id="moremenu">
        <button onclick="copySummary();closeMenu()" data-t="複製摘要">複製摘要</button>
        <button onclick="copyTranscript();closeMenu()" data-t="複製逐字稿">複製逐字稿</button>
        <button onclick="copyAll();closeMenu()" data-t="複製整份">複製整份</button>
        <div class="mdiv"></div>
        <button onclick="toTop();closeMenu()" data-t="▲ 回到頂端">▲ 回到頂端</button>
        <button id="refinebtn" onclick="refine();closeMenu()" data-t="再加工…">再加工…</button>
        <button id="resumbtn" onclick="resummarize();closeMenu()" data-t="重新摘要">重新摘要</button>
        <div class="mrow"><span class="lbl" data-t="摘要語言">摘要語言</span><div class="langsel sm" id="sumlang"><button data-l="tw">繁</button><button data-l="cn">简</button><button data-l="en">EN</button></div></div>
        <div class="mdiv"></div>
        <button onclick="openFile();closeMenu()" data-t="開啟檔案">開啟檔案</button>
        <button onclick="openDir();closeMenu()" data-t="開啟資料夾">開啟資料夾</button>
      </div>
    </div>
    <span class="sp" id="path">尚未選擇</span><span class="sp" style="opacity:.35;font-size:11px;margin-left:8px">b${BUILD}</span>
  </header>
  <div id="view"><div class="empty"><div class="big" data-t="選一份記錄">選一份記錄</div><span data-t="左欄點選會議記錄，或按「開始」錄製本場會議">左欄點選會議記錄，或按「開始」錄製本場會議</span></div></div>
  <button id="jump" onclick="toBottom()" data-t="↓ 回到即時">↓ 回到即時</button>
</main>
<div class="modal-bg" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal-box">
    <div class="mt" id="mtitle"></div>
    <div class="mtabs" id="mtabs" style="display:none">
      <button data-tab="asst" onclick="setModalTab('asst')" data-t="會議助理">會議助理</button>
      <button data-tab="rec" onclick="setModalTab('rec')" data-t="錄音">錄音</button>
      <button data-tab="llm" onclick="setModalTab('llm')" data-t="LLM 編排">LLM 編排</button>
    </div>
    <div class="mbody">
    <div class="mh" id="mhint"></div>
    <div class="meeting-settings" id="meeting-settings" hidden>
      <label><input type="checkbox" id="auto-meeting"> <span>偵測會議 App 語音</span></label>
      <div class="modes" id="meeting-modes">
        <label><input type="radio" name="meeting-mode" value="automatic"> 自動開始錄音</label>
        <label><input type="radio" name="meeting-mode" value="prompt"> 先詢問是否開始</label>
      </div>
      <hr style="border:0;border-top:1px solid var(--line);margin:10px 0">
      <label><input type="checkbox" id="refine-on"> <span data-t="會後 SenseVoice 精修">會後 SenseVoice 精修</span></label>
      <label><input type="checkbox" id="keep-audio"> <span data-t="保留音檔（預設精修後刪除）">保留音檔（預設精修後刪除）</span></label>
    </div>
    <div class="meeting-settings" id="providers-settings">
      <div style="font-size:13px;color:var(--fg);font-weight:600;margin-bottom:6px">LLM 模型編排（fallback 序）</div>
      <div style="font-size:11px;color:var(--mut);margin-bottom:8px">上→下優先；停用即跳過；key 存本機 ~/.creds，僅顯示是否已配。</div>
      <div id="provider-list"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <select id="provider-add-type" style="flex:1;background:#100d0a;border:1px solid var(--line);border-radius:8px;padding:6px 8px;color:var(--fg);font-family:var(--sans);font-size:12px">
          <option value="cheaperinference">cheaperinference</option>
          <option value="claude-cli">claude-cli</option>
          <option value="codex-cli">codex-cli</option>
          <option value="omniroute">omniroute</option>
          <option value="openrouter">openrouter</option>
          <option value="nvidia-nim">nvidia-nim</option>
        </select>
        <button class="ghost" onclick="addProviderRow()" data-t="新增實例">＋ 新增實例</button>
      </div>
    </div>
    <textarea id="mta" spellcheck="false"></textarea>
    </div>
    <div class="mbtns"><button class="ghost" onclick="closeModal()" data-t="取消">取消</button><button class="ghost warm" id="msave" data-t="儲存">儲存</button></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<div id="model-splash" style="display:none;position:fixed;inset:0;background:rgba(8,6,4,.88);backdrop-filter:blur(6px);align-items:center;justify-content:center;z-index:300;padding:20px">
  <div style="width:min(480px,94vw);background:linear-gradient(180deg,#1c1813,#15110d);border:1px solid #2c2820;border-radius:16px;padding:32px;box-shadow:0 30px 80px -20px #000">
    <div style="font-family:'Hoefler Text','Iowan Old Style',Palatino,Georgia,serif;font-size:24px;margin-bottom:8px;color:#ece6da">首次啟動：下載語音模型</div>
    <div style="font-size:13px;color:#8c8270;margin-bottom:20px;line-height:1.6">需下載約 100MB 的本地 STT 模型（sherpa-onnx 雙語 zh-en），僅需一次。下載完成前無法錄製。</div>
    <div style="background:#100d0a;border-radius:8px;height:8px;overflow:hidden;margin-bottom:12px">
      <div id="model-pbar" style="height:100%;width:0%;background:linear-gradient(90deg,#ff7a18,#ed6207);border-radius:8px;transition:width .4s"></div>
    </div>
    <div id="model-msg" style="font-size:12px;color:#5e574a;margin-bottom:20px;font-family:'SF Mono',Menlo,ui-monospace,monospace">尚未開始</div>
    <button id="model-dlbtn" onclick="startModelDownload()" style="font-family:inherit;font-size:14px;font-weight:600;border:0;cursor:pointer;padding:12px 24px;border-radius:10px;background:linear-gradient(180deg,#ff8a2e,#ed6207);color:#1a0d02;box-shadow:0 6px 18px -6px #ff7a18">▼ 開始下載模型</button>
  </div>
</div>
<script>
let sel=null, docHtml="", allFiles=[], stick=true, marks=[], markIdx=-1;
const $=id=>document.getElementById(id);
const fmtT=ms=>new Date(ms).toLocaleString('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const fmtS=b=>b<1024?b+' B':(b/1024).toFixed(0)+' KB';
const STXT={idle:'閒置 · 待命',recording:'錄製中',summarizing:'生成摘要中…'};
let L=localStorage.getItem('lmnUiLang')||'tw';
let sumLang=localStorage.getItem('lmnSumLang')||'cn';
const DICT={
'會議記錄':{cn:'会议记录',en:'Meeting Notes'},
'系統音訊 · 即時繁中轉錄':{cn:'系统音频 · 实时转录',en:'System audio · Live transcription'},
'⚙ 會議助理設定':{cn:'⚙ 会议助理设置',en:'⚙ Assistant Settings'},
'▶ 開始':{cn:'▶ 开始',en:'▶ Start'},
'■ 結束':{cn:'■ 结束',en:'■ Stop'},
'已錄記錄':{cn:'已录记录',en:'Recordings'},
'複製摘要':{cn:'复制摘要',en:'Copy Summary'},
'複製逐字稿':{cn:'复制逐字稿',en:'Copy Transcript'},
'整份':{cn:'整份',en:'Copy All'},
'▲ 頂端':{cn:'▲ 顶端',en:'▲ Top'},
'↧ 摘要':{cn:'↧ 摘要',en:'↧ Summary'},
'前情提要':{cn:'前情提要',en:'Context'},
'重新摘要':{cn:'重新摘要',en:'Re-summarize'},
'再加工…':{cn:'再加工…',en:'Refine…'},
'摘要語言':{cn:'摘要语言',en:'Summary lang'},
'開啟檔案':{cn:'打开文件',en:'Open File'},
'資料夾':{cn:'文件夹',en:'Folder'},
'選一份記錄':{cn:'选一份记录',en:'Select a note'},
'左欄點選會議記錄，或按「開始」錄製本場會議':{cn:'左栏点选会议记录，或按「开始」录制本场会议',en:'Pick a note on the left, or press Start to record.'},
'↓ 回到即時':{cn:'↓ 回到实时',en:'↓ Live'},
'取消':{cn:'取消',en:'Cancel'},
'儲存':{cn:'保存',en:'Save'},
'智慧複製':{cn:'智能复制',en:'Smart copy'},
'週日':{cn:'周日',en:'Sun'},'週一':{cn:'周一',en:'Mon'},'週二':{cn:'周二',en:'Tue'},'週三':{cn:'周三',en:'Wed'},'週四':{cn:'周四',en:'Thu'},'週五':{cn:'周五',en:'Fri'},'週六':{cn:'周六',en:'Sat'},
'其他':{cn:'其他',en:'Other'},
'會議助理':{cn:'会议助理',en:'Assistant'},
'錄音':{cn:'录音',en:'Recording'},
'LLM 編排':{cn:'LLM 编排',en:'LLM Routing'},
'搜尋記錄…':{cn:'搜索记录…',en:'Search notes…'},
'稿內搜尋  /  （Enter 下一個）':{cn:'稿内搜索  /  （Enter 下一个）',en:'Search transcript  /  (Enter = next)'},
'跳到內文頂端':{cn:'跳到内文顶端',en:'Jump to top'},
'跳到重點摘要':{cn:'跳到重点摘要',en:'Jump to summary'},
'尚未選擇':{cn:'尚未选择',en:'No file'},
'閒置 · 待命':{cn:'闲置 · 待命',en:'Idle'},
'錄製中':{cn:'录制中',en:'Recording'},
'生成摘要中…':{cn:'生成摘要中…',en:'Summarizing…'},
'精修中…':{cn:'精修中…',en:'Refining…'},
'會後 SenseVoice 精修':{cn:'会后 SenseVoice 精修',en:'SenseVoice refine after'},
'保留音檔（預設精修後刪除）':{cn:'保留音频（默认精修后删除）',en:'Keep audio (deleted after refine by default)'},
'已複製摘要':{cn:'已复制摘要',en:'Summary copied'},
'已複製逐字稿':{cn:'已复制逐字稿',en:'Transcript copied'},
'已複製整份 Markdown':{cn:'已复制整份 Markdown',en:'Full Markdown copied'},
'已複製此句':{cn:'已复制此句',en:'Line copied'},
'已存前情提要':{cn:'已存前情提要',en:'Context saved'},
'已存主題標籤':{cn:'已存主题标签',en:'Topic saved'},
'編輯主題標籤':{cn:'编辑主题标签',en:'Edit Topic'},
'本場會議的主題標籤（側邊欄顯示）。自動生成後可在此手動修改。（⌘/Ctrl+Enter 儲存）':{cn:'本场会议的主题标签（侧边栏显示）。自动生成后可在此手动修改。（⌘/Ctrl+Enter 保存）',en:'Meeting topic tag (shown in sidebar). Auto-generated; edit manually here. (Cmd/Ctrl+Enter to save)'},
'已存助理設定':{cn:'已存助理设置',en:'Assistant saved'},
'已更新':{cn:'已更新',en:'Updated'},
'未選檔':{cn:'未选档',en:'No file selected'},
'此檔尚無摘要':{cn:'此档尚无摘要',en:'No summary yet'},
'重新生成摘要中…':{cn:'重新生成摘要中…',en:'Regenerating summary…'},
'已加工（':{cn:'已加工（',en:'Refined ('},
'失敗：':{cn:'失败：',en:'Failed: '},
'摘要完成（':{cn:'摘要完成（',en:'Summary done ('},
'翻譯摘要中…':{cn:'翻译摘要中…',en:'Translating summary…'},
'已切換摘要語言':{cn:'已切换摘要语言',en:'Summary language switched'},
'摘要再加工':{cn:'摘要再加工',en:'Refine Summary'},
'本場前情提要':{cn:'本场前情提要',en:'Meeting Context'},
'會議助理設定（常駐）':{cn:'会议助理设置（常驻）',en:'Assistant Settings (persistent)'},
'無符合':{cn:'无符合',en:'No match'},
'複製整份':{cn:'复制整份',en:'Copy All'},
'▲ 回到頂端':{cn:'▲ 回到顶端',en:'▲ Back to top'},
'↧ 跳到摘要':{cn:'↧ 跳到摘要',en:'↧ Jump to summary'},
'開啟資料夾':{cn:'打开文件夹',en:'Open Folder'},
'更多':{cn:'更多',en:'More'},
'以自然語言指令重排「重點摘要」以下整段（重點／決議／待辦），逐字稿不動。例：變短 ／ 條列化 ／ 只留決議 ／ 補充風險點。（⌘/Ctrl+Enter 執行）':{cn:'用自然語言指令重排「重點摘要」以下整段（重点／决议／待办），逐字稿不动。例：变短 ／ 列点化 ／ 只留决议 ／ 补充风险点。（⌘/Ctrl+Enter 执行）',en:'Reorder the summary section (points / decisions / todos) with a natural-language instruction; transcript untouched. e.g. shorter / bullet list / decisions only / add risks. (Cmd/Ctrl+Enter to run)'},
'針對這份會議的補充情報：主題／需求／參與方／專有名詞。會注入校稿與摘要讓整理更貼合本場；首行也用來生成檔名標題。（⌘/Ctrl+Enter 儲存）':{cn:'针对这份会议的补充情报：主题／需求／参与方／专有名词。会注入校对与摘要让整理更贴合本场；首行也用来生成文件名标题。（⌘/Ctrl+Enter 保存）',en:'Extra context for this meeting: topic / needs / participants / jargon. Injected into cleanup and summary; first line also becomes the file title. (Cmd/Ctrl+Enter to save)'},
'跨會議通用的領域背景：角色、常見術語／專有名詞、關注重點，協助校正辨識並框定摘要方向。可在此指定固定輸出模板。（⌘/Ctrl+Enter 儲存）':{cn:'跨会议通用的领域背景：角色、常见术语／专有名词、关注重点，协助校正识别并框定摘要方向。可在此指定固定输出模板。（⌘/Ctrl+Enter 保存）',en:'Standing domain background shared across meetings: role, common terms / jargon, focus. Helps fix recognition and frame the summary. You can fix an output template here. (Cmd/Ctrl+Enter to save)'}
};
function tr(s){ if(L==='tw')return s; const d=DICT[s]; return (d&&d[L])||s; }
function applyLang(){
  document.documentElement.lang = L==='en'?'en':(L==='cn'?'zh-CN':'zh-TW');
  document.querySelectorAll('[data-t]').forEach(el=>{ el.textContent=tr(el.getAttribute('data-t')); });
  document.querySelectorAll('[data-tph]').forEach(el=>{ el.placeholder=tr(el.getAttribute('data-tph')); });
  document.querySelectorAll('[data-tt]').forEach(el=>{ el.title=tr(el.getAttribute('data-tt')); });
  if(!sel){ var pe=$('path'); if(pe)pe.textContent=tr('尚未選擇'); }
  document.querySelectorAll('#uilang button').forEach(b=>b.classList.toggle('on',b.dataset.l===L));
  document.querySelectorAll('#sumlang button').forEach(b=>b.classList.toggle('on',b.dataset.l===sumLang));
}
function setUiLang(l){ L=l; localStorage.setItem('lmnUiLang',l); applyLang(); }
function setSumLang(l){ sumLang=l; localStorage.setItem('lmnSumLang',l); applyLang(); translateSummaryNow(l); }
async function translateSummaryNow(l){ if(!sel)return toast('未選檔');
  var bs=document.querySelectorAll('#sumlang button'); bs.forEach(b=>b.disabled=true);
  document.body.classList.add('busy'); var e=$('toast'); clearTimeout(e._t); e.textContent=tr('翻譯摘要中…'); e.classList.add('show');
  try{ const r=await post('/translatesummary',{file:sel,lang:l}); toast(r.ok?'已切換摘要語言':(tr('失敗：')+(r.error||''))); view(sel,true); }
  finally{ document.body.classList.remove('busy'); bs.forEach(b=>b.disabled=false); } }
function initLang(){
  var u=$('uilang'); if(u)u.onclick=e=>{var b=e.target.closest('button[data-l]'); if(b)setUiLang(b.dataset.l);};
  var sg=$('sumlang'); if(sg)sg.onclick=e=>{var b=e.target.closest('button[data-l]'); if(b)setSumLang(b.dataset.l);};
  applyLang();
}
initLang();
console.log('%c[LMN] UI build ${BUILD} — 若功能異常請硬重整 ⌘⇧R','color:#e8853a;font-weight:bold');
function toast(t){t=tr(t);const e=$('toast');e.textContent=t;e.classList.add('show');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),1900);}
function busyOn(msg){ document.body.classList.add('busy'); ['resumbtn','refinebtn'].forEach(i=>{var b=$(i);if(b)b.disabled=true;}); var e=$('toast'); clearTimeout(e._t); e.textContent=tr(msg); e.classList.add('show'); }
function busyOff(){ document.body.classList.remove('busy'); ['resumbtn','refinebtn'].forEach(i=>{var b=$(i);if(b)b.disabled=false;}); }

/* ── 狀態 / 列表 ── */
async function refresh(){
  let s; try{ s=await(await fetch('/status')).json(); }catch{ return; }
  document.body.dataset.phase=s.phase;
  const sums=s.summarizing||[];
  if(sums.length) document.body.setAttribute('data-sum',''); else document.body.removeAttribute('data-sum');
  if(s.refining) $('stxt').textContent=tr('精修中…');
  else if(s.phase==='idle'&&sums.length) $('stxt').textContent=tr('生成摘要中…');
  else if(s.phase==='idle'&&s.autoDetectMeeting) $('stxt').textContent=s.watcherError?'會議偵測異常':(s.meetingDetectionMode==='prompt'?'會議偵測待命 · 先詢問':'會議偵測待命 · 自動錄音');
  else $('stxt').textContent=tr(STXT[s.phase]||s.phase);
  $('start').disabled=s.phase!=='idle'; $('stop').disabled=s.phase!=='recording';
  window._live=s.phase==='recording'?s.file:null; window._started=s.started||0;
  window._summarizing=sums;
  const fs=await(await fetch('/files')).json();
  allFiles=fs; $('fcount').textContent=fs.length; renderFiles();
  if(s.phase==='recording'&&!sel&&s.file){ view(s.file); }
  else if(s.phase!=='recording'&&!sel&&fs.length){ view(fs[0].name); }  // 閒置自動開最新檔並高亮，讓前情提要/語言/再加工立即可用
  if(s.phase==='recording'&&sel&&s.file===sel){ view(sel,true); }
  // 摘要完成偵測：上一輪 summarizing 有、本輪沒有 → 該檔摘要剛生成完
  const prevSums=window._sums instanceof Set?window._sums:new Set();
  const curSums=new Set(sums);
  let completed=null;
  prevSums.forEach(f=>{ if(!curSums.has(f)) completed=f; });
  if(completed){
    toast('摘要完成');
    if(completed===sel||sel===null) view(completed,true);
  } else if(prevSums.size>0&&curSums.size===0&&sel){
    view(sel,true);  // 邊界：完成的那場檔名未被 poll 抓到，退化為重抓當前檔
  }
  window._sums=curSums;
}
let dayOpen={}; try{ dayOpen=JSON.parse(localStorage.getItem('dayOpen')||'{}'); }catch{}
document.addEventListener('toggle',e=>{ const d=e.target.dataset?.d; if(!d||$('ffilter').value.trim()) return; dayOpen[d]=e.target.open; try{ localStorage.setItem('dayOpen',JSON.stringify(dayOpen)); }catch{} },true);
// 左右分隔線：拖拉調寬（200–720px），雙擊還原；寬度記在 localStorage
(()=>{ const sp=$('splitter'), root=document.documentElement;
  const set=w=>{ root.style.setProperty('--sidew',w+'px'); try{ localStorage.setItem('sidew',w); }catch{} };
  try{ const w=+localStorage.getItem('sidew'); if(w) root.style.setProperty('--sidew',w+'px'); }catch{}
  sp.addEventListener('pointerdown',e=>{ e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('drag'); document.body.style.userSelect='none'; });
  sp.addEventListener('pointermove',e=>{ if(sp.classList.contains('drag')) set(Math.min(720,Math.max(200,Math.round(e.clientX)))); });
  sp.addEventListener('pointerup',()=>{ sp.classList.remove('drag'); document.body.style.userSelect=''; });
  sp.addEventListener('dblclick',()=>{ root.style.removeProperty('--sidew'); try{ localStorage.removeItem('sidew'); }catch{} });
})();
function renderFiles(){
  const q=$('ffilter').value.trim().toLowerCase();
  const fs=q?allFiles.filter(f=>(f.name+' '+(f.topic||'')).toLowerCase().includes(q)):allFiles;
  const sums=window._summarizing||[];
  // 依檔名日期（YYYY-MM-DD）分組；展開狀態記在 localStorage，輪詢重繪不重置
  const groups=[]; fs.forEach(f=>{ const d=/^\\d{4}-\\d{2}-\\d{2}/.test(f.name)?f.name.slice(0,10):'其他'; const g=groups[groups.length-1]; if(g&&g.d===d) g.fs.push(f); else groups.push({d,fs:[f]}); });
  const item=f=>\`<div class="f \${f.name===sel?'sel':''} \${f.name===window._live?'live':''} \${sums.includes(f.name)?'sum':''}" onclick="view('\${f.name}')">
    <div class="n">\${f.topic?'🏷 '+f.topic:f.name.replace(/\\.md$/,'')}\${f.title?' · '+f.title:''}</div><div class="m">\${f.topic&&/^\\d{4}-\\d{2}-\\d{2}-\\d{4}/.test(f.name)?f.name.slice(11,13)+':'+f.name.slice(13,15)+' · ':''}\${f.duration?'⏱ '+f.duration+' · ':''}\${fmtT(f.mtime)} · \${fmtS(f.size)} <button class="tpb" data-tt="編輯主題標籤" onclick="event.stopPropagation();editTopic('\${f.name}')">✎</button></div></div>\`;
  const wk=d=>{ const t=new Date(d+'T00:00'); return isNaN(t)?'':' '+tr('週'+'日一二三四五六'[t.getDay()]); };
  $('files').innerHTML=groups.map((g,i)=>{ const open=q||(dayOpen[g.d]??(i===0||g.fs.some(f=>f.name===sel)));
    return \`<details class="fday" data-d="\${g.d}" \${open?'open':''}><summary>\${g.d.replace(/-/g,'/')}\${wk(g.d)}<span>\${g.fs.length}</span></summary>\${g.fs.map(item).join('')}</details>\`; }).join('')
    ||'<div class="empty" style="margin:24px 0;padding:0 12px"><div class="big" style="font-size:18px">'+tr('無符合')+'</div></div>';
}
setInterval(()=>{ if(document.body.dataset.phase==='recording'&&window._started){
  const s=Math.floor((Date.now()-window._started)/1000);
  $('timer').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}},1000);

/* ── 檢視 ── */
async function view(name,quiet){
  if(quiet && $('view').querySelector('.edit-row')) return;
  const wasBottom=stick;
  sel=name;
  const res=await fetch('/file?name='+encodeURIComponent(name));
  const xn=res.headers.get('x-name'); if(xn&&sel===name){ name=decodeURIComponent(xn); sel=name; }  // 檔案已加標籤改名 → 跟上新檔名
  const h=await res.text();
  docHtml='<div class="doc">'+h+'</div>';
  $('view').innerHTML=docHtml;
  $('path').textContent='out/'+name;
  if($('find').value) runFind(true);
  if(!quiet){ renderFiles(); stick=true; }
  if(quiet&&wasBottom) toBottom();
}
const view_el=()=>$('view');
$('view').addEventListener('scroll',()=>{
  const v=$('view'); const atBottom=v.scrollHeight-v.scrollTop-v.clientHeight<60;
  stick=atBottom; $('jump').classList.toggle('show',!atBottom&&document.body.dataset.phase==='recording');
});
function toBottom(){const v=$('view');v.scrollTop=v.scrollHeight;stick=true;$('jump').classList.remove('show');}
function toTop(){ if(!sel)return toast('未選檔'); $('view').scrollTo({top:0,behavior:'smooth'}); }
function toSummary(){ if(!sel)return toast('未選檔');
  const h=[...$('view').querySelectorAll('h2')].find(x=>x.textContent.includes('重點摘要'));
  if(h){ h.scrollIntoView({behavior:'smooth',block:'start'}); } else { toast('此檔尚無摘要'); } }
function openModal(title,hint,value,showMeetingSettings=false){ return new Promise(res=>{
  $('mtitle').textContent=title; $('mhint').textContent=hint||''; $('mta').value=value||'';
  $('mtabs').style.display=showMeetingSettings?'flex':'none';
  if(showMeetingSettings){ renderProviders(); setModalTab('asst'); }
  else { $('meeting-settings').hidden=true; $('providers-settings').hidden=true; $('mhint').hidden=false; $('mta').hidden=false; }
  $('modal').classList.add('show'); setTimeout(()=>{$('mta').focus();},40);
  function fin(v){ $('modal').classList.remove('show'); $('msave').onclick=null; document.removeEventListener('keydown',key,true); $('modal')._c=null; res(v); }
  function key(e){ if(e.key==='Escape'){e.stopImmediatePropagation();e.preventDefault();fin(null);} else if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();fin($('mta').value);} }
  $('msave').onclick=()=>fin($('mta').value); $('modal')._c=()=>fin(null);
  document.addEventListener('keydown',key,true); }); }
// 設定視窗分頁：會議助理（提示詞）／錄音／LLM 編排
function setModalTab(t){
  document.querySelectorAll('#mtabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
  $('mhint').hidden=t!=='asst'; $('mta').hidden=t!=='asst';
  $('meeting-settings').hidden=t!=='rec'; $('providers-settings').hidden=t!=='llm';
  if(t==='asst') $('mta').focus();
}
function closeModal(){ if($('modal')._c)$('modal')._c(); else $('modal').classList.remove('show'); }
function toggleMenu(e){ if(e)e.stopPropagation(); var m=$('moremenu'); if(m)m.classList.toggle('show'); }
function closeMenu(){ var m=$('moremenu'); if(m)m.classList.remove('show'); }
document.addEventListener('click',e=>{ if(!e.target.closest('.menu-wrap')) closeMenu(); });

/* ── 逐字稿就地修正 / 複製 / 待辦 ── */
$('view').addEventListener('click',async e=>{
  const todo=e.target.closest('li[data-todo]');
  if(todo){ await post('/toggle',{file:sel,index:+todo.dataset.todo}); view(sel,true); return; }
  const btn=e.target.closest('.mini'); if(!btn) return;
  const utt=btn.closest('.utt'); const i=+utt.dataset.i;
  const text=utt.querySelector('.body p').textContent;
  const who=utt.querySelector('.who').textContent;
  if(btn.dataset.act==='copy'){ navigator.clipboard.writeText(who+'：'+text); toast('已複製此句'); return; }
  if(btn.dataset.act==='edit'){ openEditor(utt,i,who,text); }
});
function openEditor(utt,i,who,text){
  const row=document.createElement('div'); row.className='edit-row';
  const known=['對方','本人','主持人'];
  const opts=known.map(o=>\`<option \${o===who?'selected':''}>\${o}</option>\`).join('')+
    \`<option value="__custom"\${known.includes(who)?'':' selected'}>自訂…</option>\`;
  row.innerHTML=\`<div></div><div class="ef">
    <select>\${opts}</select>
    <input value="\${text.replace(/"/g,'&quot;')}">
    <div class="eb"><button class="ghost warm" data-s>儲存</button><button class="ghost" data-c>取消</button></div></div>\`;
  const sl=row.querySelector('select'), inp=row.querySelector('input');
  if(!known.includes(who)){ sl.value='__custom'; }
  sl.onchange=()=>{ if(sl.value==='__custom'){ const v=prompt('發言人名稱',who)||who; if(![...sl.options].some(o=>o.value===v||o.text===v)){const o=new Option(v,v,true,true);sl.add(o,0);} sl.value=v; } };
  utt.replaceWith(row); inp.focus();
  row.querySelector('[data-c]').onclick=()=>view(sel,true);
  row.querySelector('[data-s]').onclick=async()=>{
    const spk=sl.value==='__custom'?who:(sl.selectedOptions[0].value||sl.selectedOptions[0].text);
    await post('/edit',{file:sel,index:i,speaker:spk,text:inp.value}); toast('已更新'); view(sel,true);
  };
}

/* ── 稿內搜尋 ── */
$('find').addEventListener('input',()=>runFind(true));
$('find').addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();stepMark(e.shiftKey?-1:1);} if(e.key==='Escape'){clearFind();} });
function clearMarks(){ if(docHtml){$('view').innerHTML=docHtml;} marks=[];markIdx=-1;$('findcount').textContent=''; }
function runFind(reset){
  const q=$('find').value.trim();
  $('view').innerHTML=docHtml; marks=[]; markIdx=-1;
  if(!q){ $('findcount').textContent=''; return; }
  const rx=new RegExp(q.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&'),'gi');
  const walk=document.createTreeWalker($('view'),NodeFilter.SHOW_TEXT,{acceptNode:n=>n.nodeValue.trim()&&n.parentElement.tagName!=='SCRIPT'?1:2});
  const todo=[]; let n; while(n=walk.nextNode()) if(rx.test(n.nodeValue)){rx.lastIndex=0;todo.push(n);}
  for(const node of todo){
    const frag=document.createDocumentFragment(); let last=0; const s=node.nodeValue; rx.lastIndex=0; let mm;
    while(mm=rx.exec(s)){ frag.append(s.slice(last,mm.index)); const mk=document.createElement('mark'); mk.textContent=mm[0]; frag.append(mk); marks.push(mk); last=mm.index+mm[0].length; if(mm.index===rx.lastIndex)rx.lastIndex++; }
    frag.append(s.slice(last)); node.replaceWith(frag);
  }
  $('findcount').textContent=marks.length?('1/'+marks.length):'0';
  if(marks.length){markIdx=0;hl();}
}
function stepMark(d){ if(!marks.length)return; markIdx=(markIdx+d+marks.length)%marks.length; hl(); }
function hl(){ marks.forEach(m=>m.classList.remove('cur')); const m=marks[markIdx]; if(!m)return; m.classList.add('cur'); m.scrollIntoView({block:'center'}); $('findcount').textContent=(markIdx+1)+'/'+marks.length; }
function clearFind(){ $('find').value=''; clearMarks(); $('find').blur(); }

/* ── 複製 / 摘要 ── */
async function raw(){ return sel?await(await fetch('/raw?name='+encodeURIComponent(sel))).text():''; }
async function copyAll(){ if(!sel)return toast('未選檔'); navigator.clipboard.writeText(await raw()); toast('已複製整份 Markdown'); }
async function copyTranscript(){ if(!sel)return toast('未選檔'); const r=await raw();
  const t=r.split('\\n').map(l=>{const m=l.match(/^\\[[\\d:]+\\]\\s*(.+)$/);return m?m[1]:null;}).filter(Boolean).join('\\n');
  navigator.clipboard.writeText(t); toast('已複製逐字稿'); }
// 智慧複製：摘要已完成且正常 → 整份；摘要中／失敗／尚無摘要 → 只複製逐字稿內容
async function smartCopy(){ if(!sel)return toast('未選檔'); const r=await raw(); const i=r.indexOf('## 重點摘要');
  const ok=i>=0&&!(window._summarizing||[]).includes(sel)&&!r.slice(i).includes('摘要失敗');
  return ok?copyAll():copyTranscript(); }
async function copySummary(){ if(!sel)return toast('未選檔'); const r=await raw(); const i=r.indexOf('## 重點摘要');
  if(i<0)return toast('此檔尚無摘要'); navigator.clipboard.writeText(r.slice(i)); toast('已複製摘要'); }
async function resummarize(){ if(!sel)return toast('未選檔'); busyOn('重新生成摘要中…');
  try{ const r=await post('/resummarize',{file:sel}); if(r.name) sel=r.name; toast(r.ok?(tr('摘要完成（')+r.provider+'）'):(tr('失敗：')+r.error)); view(sel,true); refresh(); }
  finally{ busyOff(); } }
async function refine(){ if(!sel)return toast('未選檔');
  const ins=await openModal(tr('摘要再加工'),tr('以自然語言指令重排「重點摘要」以下整段（重點／決議／待辦），逐字稿不動。例：變短 ／ 條列化 ／ 只留決議 ／ 補充風險點。（⌘/Ctrl+Enter 執行）'),'');
  if(ins===null||!ins.trim())return;
  busyOn('加工中…');
  try{ const r=await post('/refine',{file:sel,instruction:ins}); toast(r.ok?(tr('已加工（')+r.provider+'）'):(tr('失敗：')+r.error)); view(sel,true); }
  finally{ busyOff(); } }
async function editContext(){ if(!sel)return toast('未選檔');
  let cur=''; try{ cur=(await(await fetch('/context?name='+encodeURIComponent(sel))).json()).text||''; }catch{}
  const t=await openModal(tr('本場前情提要'),tr('針對這份會議的補充情報：主題／需求／參與方／專有名詞。會注入校稿與摘要讓整理更貼合本場；首行也用來生成檔名標題。（⌘/Ctrl+Enter 儲存）'),cur);
  if(t===null)return; await post('/context',{file:sel,text:t}); toast('已存前情提要'); view(sel,true); }
async function editTopic(n){ if(n&&n!==sel) await view(n); if(!sel)return toast('未選檔');  // 側欄 ✎ 帶檔名：先切到該檔
  let cur=''; try{ cur=(await(await fetch('/topic?name='+encodeURIComponent(sel))).json()).text||''; }catch{}
  const t=await openModal(tr('編輯主題標籤'),tr('本場會議的主題標籤（側邊欄顯示）。自動生成後可在此手動修改。（⌘/Ctrl+Enter 儲存）'),cur);
  if(t===null)return; const r=await post('/topic',{file:sel,topic:t.trim()}); if(r.name) sel=r.name; toast('已存主題標籤'); view(sel,true); refresh(); }
const PROVIDER_TYPES=['cheaperinference','claude-cli','codex-cli','omniroute','openrouter','nvidia-nim'];
const DEFAULT_MODEL={'cheaperinference':'deepseek-v4-flash-0731','claude-cli':'CLI 設定檔，如 sonnet','codex-cli':'CLI 設定檔','omniroute':'free-tools','openrouter':'openrouter/free，僅限 *:free','nvidia-nim':'deepseek-ai/deepseek-v4.1-flash'};
// ponytail: 常見選項是 2026/09/24 快照（免費模型常變），可直接手打任意字串；清單網址看最新
const MODEL_OPTS={'cheaperinference':['deepseek-v4-flash-0731'],'claude-cli':['sonnet','opus','haiku','fable','claude-sonnet-5','claude-opus-5-5','claude-haiku-4-5-20251001'],'codex-cli':['gpt-5.6-sol'],'omniroute':['free-tools','Deepseek cheap'],'openrouter':['openrouter/free','nvidia/nemotron-3-ultra-550b-a55b:free','nvidia/nemotron-3-super-120b-a12b:free','qwen/qwen3.8-27b:free','google/gemma-4-31b-it:free','z-ai/glm-5.2:free','thinkingmachines/inkling:free'],'nvidia-nim':['deepseek-ai/deepseek-v4.1-flash','moonshotai/kimi-k3','moonshotai/kimi-k2.6','z-ai/glm-5.3','z-ai/glm-5.3-flash','openai/gpt-oss-20b']};
const MODEL_DOCS={'cheaperinference':'https://cheaperinference.com','claude-cli':'https://docs.claude.com/en/docs/about-claude/models/overview','codex-cli':'https://developers.openai.com/codex/models','omniroute':'http://localhost:20128/dashboard','openrouter':'https://openrouter.ai/models?max_price=0','nvidia-nim':'https://build.nvidia.com/models'};
const KEY_TYPES={'cheaperinference':1,'omniroute':1,'openrouter':1,'nvidia-nim':1}; // 哪些類型需要 key
let providerList=[], providerKeys={};

function renderProviders(){
  const el=$('provider-list'); if(!el) return;
  const row=(p,i)=>\`<div class="prow" data-i="\${i}">
    <div class="prow-main">
      <span class="ptype">\${p.type}</span>
      \${p.baseUrl?\`<span class="pmeta">base:\${p.baseUrl}</span>\`:''}
      \${p.model?\`<span class="pmeta">model:\${p.model}</span>\`:''}
      <span class="pkey">\${KEY_TYPES[p.type]?(providerKeys[p.type]?'已配 key ✓':'未配 key'):'無需 key'}</span>
    </div>
    <div class="pacts">
      <button class="mini" title="上移" onclick="moveProvider(\${i},-1)">↑</button>
      <button class="mini" title="下移" onclick="moveProvider(\${i},1)">↓</button>
      \${KEY_TYPES[p.type]?\`<button class="mini" title="設 key" onclick="promptKey(\${i})">🔑</button>\`:''}
      <button class="mini" title="移除" onclick="removeProvider(\${i})">✕</button>
      <label class="ptoggle"><input type="checkbox" data-enable="\${i}" \${p.enabled===false?'':'checked'}> 啟用</label>
    </div>
    <div class="povr">
      \${KEY_TYPES[p.type]?\`<input class="pbase" placeholder="baseUrl（可選）" value="\${p.baseUrl||''}">\`:'<span class="povrhint">本機 CLI 訂閱</span>'}
      <input class="pmodel" list="ml-\${i}" placeholder="model（預設 \${DEFAULT_MODEL[p.type]||''}）" value="\${p.model||''}">
      <datalist id="ml-\${i}">\${(MODEL_OPTS[p.type]||[]).map(m=>\`<option value="\${m}">\`).join('')}</datalist>
      \${MODEL_DOCS[p.type]?\`<a class="pdoc" href="\${MODEL_DOCS[p.type]}" target="_blank" rel="noopener">模型清單↗</a>\`:''}
    </div>
  </div>\`;
  providerList.forEach((p,i)=>{ const r=row(p,i); el.insertAdjacentHTML('beforeend', r); const l=el.lastElementChild; l.querySelector('[data-enable]')?.addEventListener('change',e=>p.enabled=e.target.checked); l.querySelectorAll('.pbase,.pmodel').forEach(inp=>inp.addEventListener('input',e=>{ if(e.target.classList.contains('pbase'))p.baseUrl=e.target.value.trim()||undefined; else p.model=e.target.value.trim()||undefined; })); });
  $('provider-add-type').value='claude-cli';
}
function moveProvider(i,d){
  const j=i+d; if(j<0||j>=providerList.length)return;
  [providerList[i],providerList[j]]=[providerList[j],providerList[i]];
  $('provider-list').innerHTML=''; renderProviders();
}
function removeProvider(i){ providerList.splice(i,1); $('provider-list').innerHTML=''; renderProviders(); }
function addProviderRow(){ providerList.push({type:$('provider-add-type').value,enabled:true}); $('provider-list').innerHTML=''; renderProviders(); }
async function promptKey(i){
  const p=providerList[i]; const key=prompt('輸入 API KEY（'+p.type+'）','');
  if(key===null||!key.trim())return;
  const r=await post('/providers/key',{type:p.type,apiKey:key.trim()});
  if(r.ok){ providerKeys[p.type]=true; toast('已存 key'); renderProviders(); } else toast(tr('失敗：')+(r.error||''));
}

async function editAssistant(){
  let cur='', cfg={autoDetectMeeting:true,meetingDetectionMode:'automatic',refineOn:true,keepAudio:false};
  try{ const rs=await Promise.all([fetch('/assistant'),fetch('/settings')]); cur=(await rs[0].json()).text||''; cfg=await rs[1].json(); }catch{}
  providerList=Array.isArray(cfg.providers)?cfg.providers.map(p=>({type:p.type,enabled:p.enabled!==false,baseUrl:p.baseUrl,model:p.model})):PROVIDER_TYPES.map(type=>({type,enabled:true}));
  try{ providerKeys=await(await fetch('/providers/keys')).json(); }catch{}
  $('provider-list').innerHTML='';
  $('auto-meeting').checked=cfg.autoDetectMeeting!==false;
  $('refine-on').checked=cfg.refineOn!==false;
  $('keep-audio').checked=!!cfg.keepAudio;
  const mode=cfg.meetingDetectionMode==='prompt'?'prompt':'automatic';
  document.querySelector('input[name="meeting-mode"][value="'+mode+'"]').checked=true;
  const syncModes=()=>{const enabled=$('auto-meeting').checked;$('meeting-modes').style.opacity=enabled?'1':'.45';document.querySelectorAll('input[name="meeting-mode"]').forEach(x=>x.disabled=!enabled);}; $('auto-meeting').onchange=syncModes; syncModes();
  const t=await openModal(tr('會議助理設定（常駐）'),tr('跨會議通用的領域背景：角色、常見術語／專有名詞、關注重點，協助校正辨識並框定摘要方向。可在此指定固定輸出模板。（⌘/Ctrl+Enter 儲存）'),cur,true);
  if(t===null)return;
  const picked=document.querySelector('input[name="meeting-mode"]:checked');
  await Promise.all([
    post('/assistant',{text:t}),
    post('/settings',{autoDetectMeeting:$('auto-meeting').checked,meetingDetectionMode:picked?picked.value:'automatic',refineOn:$('refine-on').checked,keepAudio:$('keep-audio').checked,providers:providerList.map(p=>({type:p.type,enabled:p.enabled!==false,baseUrl:p.baseUrl,model:p.model}))}),
  ]);
  toast('已存助理設定'); refresh(); }

async function start(){
  const ms=await(await fetch('/model/status')).json();
  if(!ms.ready){showModelSplash();return;}
  await fetch('/start',{method:'POST'});setTimeout(refresh,1800);
}
async function stop(){await fetch('/stop',{method:'POST'});refresh();}

/* ── 模型下載 splash ── */
let _modelPollTimer=null;
function showModelSplash(){
  var bg=document.getElementById('model-splash');
  if(bg)bg.style.display='flex';
}
function hideModelSplash(){
  var bg=document.getElementById('model-splash');
  if(bg)bg.style.display='none';
}
async function checkModelAndMaybeHide(){
  try{
    const ms=await(await fetch('/model/status')).json();
    var prog=document.getElementById('model-prog');
    var pbar=document.getElementById('model-pbar');
    var msg=document.getElementById('model-msg');
    var dlbtn=document.getElementById('model-dlbtn');
    if(ms.error){
      if(msg)msg.textContent='下載失敗：'+ms.error;
      if(dlbtn){dlbtn.disabled=false;dlbtn.textContent='重試下載';}
      clearInterval(_modelPollTimer);_modelPollTimer=null;
    } else if(ms.ready){
      if(pbar)pbar.style.width='100%';
      if(msg)msg.textContent='模型就緒！';
      clearInterval(_modelPollTimer);_modelPollTimer=null;
      setTimeout(hideModelSplash,800);
    } else if(ms.downloading){
      if(pbar)pbar.style.width=ms.progress+'%';
      if(msg)msg.textContent='下載中… '+ms.progress+'%';
    }
  }catch{}
}
async function startModelDownload(){
  var dlbtn=document.getElementById('model-dlbtn');
  var msg=document.getElementById('model-msg');
  if(dlbtn){dlbtn.disabled=true;dlbtn.textContent='下載中…';}
  if(msg)msg.textContent='連線中…';
  try{
    await fetch('/model/download',{method:'POST'});
    if(!_modelPollTimer)_modelPollTimer=setInterval(checkModelAndMaybeHide,1200);
  }catch(e){
    if(dlbtn){dlbtn.disabled=false;dlbtn.textContent='重試下載';}
    if(msg)msg.textContent='啟動失敗：'+e;
  }
}
async function initModelCheck(){
  try{
    const ms=await(await fetch('/model/status')).json();
    if(!ms.ready)showModelSplash();
  }catch{}
}
initModelCheck();
async function openFile(){if(sel)fetch('/open?name='+encodeURIComponent(sel),{method:'POST'});}
async function openDir(){fetch('/open?dir=1',{method:'POST'});}
async function post(p,b){try{return await(await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})).json();}catch(e){return{ok:false,error:''+e};}}

/* ── 鍵盤 ── */
document.addEventListener('keydown',e=>{
  const typing=/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if(e.key==='/'&&!typing){e.preventDefault();$('find').focus();}
  if(e.code==='Space'&&!typing){e.preventDefault(); document.body.dataset.phase==='recording'?stop():(document.body.dataset.phase==='idle'&&start());}
});
refresh();setInterval(refresh,3000);
</script></body></html>`;

async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (p === "/status")
      return Response.json({
        phase, file: recordingFile, started: startedAt,
        summarizing: [...summarizers.values()].filter(Boolean), modelReady: modelReady(),
        recordingOrigin, meetingActive, watcherError,
        refining: existsSync(join(OUT_DIR, ".refining")),
        autoDetectMeeting: settings.autoDetectMeeting,
        meetingDetectionMode: settings.meetingDetectionMode,
      });
    if (p === "/settings" && req.method === "GET") return Response.json(settings);
    if (p === "/settings" && req.method === "POST") {
      const b = await readBody(req);
      const wasEnabled = settings.autoDetectMeeting;
      settings = {
        autoDetectMeeting: b.autoDetectMeeting !== false,
        meetingDetectionMode: b.meetingDetectionMode === "prompt" ? "prompt" : "automatic",
        refineOn: typeof b.refineOn === "boolean" ? b.refineOn : settings.refineOn,
        keepAudio: typeof b.keepAudio === "boolean" ? b.keepAudio : settings.keepAudio,
        ...(Array.isArray(b.providers) ? { providers: b.providers } : {}),
      };
      saveSettings(SETTINGS_FILE, settings);
      if (wasEnabled && !settings.autoDetectMeeting) {
        activityGeneration++;
        suppressCurrentActivity(detectionState);
        if (recordingOrigin === "meeting") stopRecording(false);
      }
      return Response.json({ ok: true, ...settings });
    }
    // ── provider key 管理（key 永不回傳明文）──
    if (p === "/providers/keys" && req.method === "GET") {
      return Response.json({
        "cheaperinference": !!process.env.CHEAPERINFERENCE_API_KEY,
        "omniroute": !!process.env.OMNIROUTE_API_KEY,
        "openrouter": !!process.env.OPENROUTER_API_KEY,
        "nvidia-nim": !!process.env.NVIDIA_API_KEY,
      });
    }
    if (p === "/providers/key" && req.method === "POST") {
      const b = await readBody(req);
      const KEY_VAR: Record<string, string> = {
        cheaperinference: "CHEAPERINFERENCE_API_KEY",
        omniroute: "OMNIROUTE_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        "nvidia-nim": "NVIDIA_API_KEY",
      };
      const varName = KEY_VAR[String(b.type ?? "")];
      if (!varName) return Response.json({ ok: false, error: "未知類型" }, { status: 400 });
      const key = String(b.apiKey ?? "").trim();
      if (!key) return Response.json({ ok: false, error: "缺少 key" }, { status: 400 });
      if (!/^[A-Za-z0-9._\-]+$/.test(key)) return Response.json({ ok: false, error: "非法 key 字元" }, { status: 400 });
      const envFile = join(homedir(), ".creds", String(b.type), ".env");
      let lines: string[] = [];
      try { lines = readFileSync(envFile, "utf8").split("\n"); } catch { /* 檔不存在 → 從空建 */ }
      const idx = lines.findIndex((l) => l.startsWith(`${varName}=`));
      const line = `${varName}=${key}`;
      if (idx >= 0) lines[idx] = line; else lines.push(line);
      mkdirSync(dirname(envFile), { recursive: true });
      writeFileSync(envFile, lines.join("\n") + "\n");
      process.env[varName] = key; // 即時生效，免重啟
      return Response.json({ ok: true });
    }
    if (p === "/model/status")
      return Response.json({ ready: modelReady(), downloading: downloadState.downloading, progress: downloadState.progress, error: downloadState.error });
    if (p === "/model/download" && req.method === "POST") {
      if (downloadState.downloading) return Response.json({ ok: false, error: "already downloading" });
      if (modelReady()) return Response.json({ ok: true, already: true });
      downloadState = { downloading: true, progress: 0 };
      (async () => {
        const tarPath = join(ROOT, "models", `${MODEL_NAME}.tar.bz2`);
        try {
          mkdirSync(join(ROOT, "models"), { recursive: true });
          const resp = await fetch(MODEL_TAR_URL);
          if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
          const total = Number(resp.headers.get("content-length") ?? 0);
          let received = 0;
          const out = Bun.file(tarPath).writer();
          for await (const chunk of resp.body) {
            out.write(chunk);
            received += chunk.byteLength;
            if (total > 0) downloadState.progress = Math.round((received / total) * 90);
          }
          await out.end();
          downloadState.progress = 92;
          const r = spawnSync("tar", ["xjf", tarPath, "-C", join(ROOT, "models")], { stdio: "ignore" });
          if (r.status !== 0) throw new Error("tar 解壓失敗");
          try { require("fs").unlinkSync(tarPath); } catch {}
          downloadState = { downloading: false, progress: 100 };
        } catch (e) {
          downloadState = { downloading: false, progress: 0, error: (e as Error).message };
        }
      })();
      return Response.json({ ok: true });
    }
    if (p === "/files") return Response.json(listMd());
    if (p === "/assistant" && req.method === "GET") return Response.json({ text: readAssistant() });
    if (p === "/assistant" && req.method === "POST") {
      const b = await readBody(req);
      writeAssistant(String(b.text ?? ""));
      return Response.json({ ok: true });
    }
    if (p === "/context" && req.method === "GET") {
      const fp = safePath(url.searchParams.get("name") ?? "");
      if (!fp) return Response.json({ text: "" });
      try { return Response.json({ text: getContext(readFileSync(fp, "utf8")) }); } catch { return Response.json({ text: "" }); }
    }
    if (p === "/topic" && req.method === "GET") {
      const fp = safePath(url.searchParams.get("name") ?? "");
      if (!fp) return Response.json({ text: "" });
      try { return Response.json({ text: getTopic(readFileSync(fp, "utf8")) }); } catch { return Response.json({ text: "" }); }
    }

    if (p === "/file" || p === "/raw") {
      const fp = safePath(url.searchParams.get("name") ?? "");
      if (!fp) return new Response("bad name", { status: 400 });
      try {
        const md = readFileSync(fp, "utf8");
        const xn = { "x-name": encodeURIComponent(basename(fp)) }; // 實際檔名（可能已改名）
        if (p === "/raw") return new Response(md, { headers: { "content-type": "text/plain; charset=utf-8", ...xn } });
        return new Response(mdToHtml(md), { headers: { "content-type": "text/html; charset=utf-8", ...xn } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    if (p === "/start" && req.method === "POST") { startRecording("manual"); return Response.json({ ok: true }); }
    if (p === "/stop" && req.method === "POST") { stopRecording(true); return Response.json({ ok: true }); }

    if (p === "/open" && req.method === "POST") {
      if (url.searchParams.get("dir")) openPath(OUT_DIR);
      else { const fp = safePath(url.searchParams.get("name") ?? ""); if (fp) openPath(fp); }
      return Response.json({ ok: true });
    }

    // ── 寫入端點（read-modify-write） ──
    if (req.method === "POST" && (p === "/edit" || p === "/toggle" || p === "/resummarize" || p === "/refine" || p === "/context" || p === "/translatesummary" || p === "/topic")) {
      const b = await readBody(req);
      const fp = safePath(b.file ?? "");
      if (!fp) return Response.json({ ok: false, error: "bad name" }, { status: 400 });
      let md: string;
      try { md = readFileSync(fp, "utf8"); } catch { return Response.json({ ok: false, error: "not found" }, { status: 404 }); }

      try {
        if (p === "/edit") {
          md = editUtterance(md, Number(b.index), String(b.speaker ?? "對方"), String(b.text ?? ""));
          writeFileSync(fp, md);
          return Response.json({ ok: true });
        }
        if (p === "/toggle") {
          md = toggleTodo(md, Number(b.index));
          writeFileSync(fp, md);
          return Response.json({ ok: true });
        }
        if (p === "/context") {
          writeFileSync(fp, setContext(md, String(b.text ?? "")));
          return Response.json({ ok: true });
        }
        if (p === "/topic") {
          writeFileSync(fp, setTopic(md, String(b.topic ?? "")));
          return Response.json({ ok: true, name: retag(fp) });
        }
        if (p === "/resummarize") {
          const assistant = readAssistant();
          const context = getContext(md);
          const raw = extractTranscript(md);
          const lang = (["tw", "cn", "en"].includes(b.lang) ? b.lang : "cn") as Lang;
          const dm = String(b.file).match(/(\d{4})-(\d{2})-(\d{2})/);
          const dateHint = dm ? dm[1] + dm[2] + dm[3] : "";
          const { provider, markdown } = await summarize(raw, { assistant, context, lang, dateHint, glossary: readGlossary(), providers: settings.providers });
          md = replaceSummary(md, markdown);
          // 仿 Scriberr：只在無主題時自動生成，不蓋掉手動改過的標籤
          if (!getTopic(md)) {
            try { md = setTopic(md, await genTopic(markdown, settings.providers)); } catch {}
          }
          writeFileSync(fp, md);
          return Response.json({ ok: true, provider, name: retag(fp) });
        }
        if (p === "/translatesummary") {
          const lang = (["tw", "cn", "en"].includes(b.lang) ? b.lang : "cn") as Lang;
          const cur = getSummary(md);
          if (!cur.trim()) return Response.json({ ok: false, error: "無摘要" });
          const { provider, markdown } = await translateSummary(cur, lang, settings.providers);
          writeFileSync(fp, replaceSummary(md, markdown));
          return Response.json({ ok: true, provider });
        }
        if (p === "/refine") {
          const assistant = readAssistant();
          const context = getContext(md);
          const cur = getSummary(md) || "（尚無摘要，請依逐字稿生成）";
          const glossary = readGlossary();
          const bg =
            (assistant.trim() ? `【領域背景】\n"""\n${assistant.trim()}\n"""\n\n` : "") +
            (context.trim() ? `【本場會議前情提要】\n"""\n${context.trim()}\n"""\n\n` : "") +
            (glossary.trim() ? `【術語對照表 · ASR 誤聽還原】\n"""\n${glossary.trim()}\n"""\n\n` : "");
          const prompt =
            `你是會議記錄助理。${bg ? "\n\n" + bg : ""}以下是現有的繁體中文會議摘要。請依指令調整，只輸出調整後的摘要本體（不要客套話、不要解釋）。輸出寫成連貫的敘述性段落（不要條列）；全文不得出現任何 Markdown 符號（#、*、-、•、[ ]），整份須能直接複製成乾淨純文字。除非指令明確要求改成清單，否則維持散文段落。\n\n` +
            `指令：${String(b.instruction ?? "")}\n\n現有摘要：\n"""\n${cur}\n"""`;
          const { provider, text } = await complete(prompt, settings.providers);
          writeFileSync(fp, replaceSummary(md, text));
          return Response.json({ ok: true, provider });
        }
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message });
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.error(`▶ 會議記錄 UI： http://localhost:${PORT}`);
