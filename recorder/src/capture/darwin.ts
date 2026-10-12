// capture/darwin.ts — spawn audiotee (Core Audio tap)，讀系統音訊 PCM 串流
//
// audiotee 行為（已實測）：
//   stdout → raw PCM (pcm_s16le, 16kHz, mono，當 --sample-rate 16000)
//   stderr → 每則一行 JSON 訊息（info/debug/metadata/stream_start/stream_stop）
// 免 admin，首次跑觸發一次性 TCC「音訊錄製」同意框。

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { CaptureOptions, CaptureHandle, AudioMetadata } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIOTEE_BIN = join(__dirname, "..", "..", "bin", "audiotee");

export function startCapture(opts: CaptureOptions = {}): CaptureHandle {
  const sampleRate = opts.sampleRate ?? 16000;
  const args: string[] = ["--sample-rate", String(sampleRate)];
  if (opts.includeProcesses?.length)
    args.push("--include-processes", ...opts.includeProcesses.map(String));
  if (opts.excludeProcesses?.length)
    args.push("--exclude-processes", ...opts.excludeProcesses.map(String));
  if (opts.chunkDuration) args.push("--chunk-duration", String(opts.chunkDuration));

  const proc = spawn(AUDIOTEE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

  const audioCbs: ((pcm: Buffer) => void)[] = [];
  const metaCbs: ((m: AudioMetadata) => void)[] = [];
  const closeCbs: ((code: number | null) => void)[] = [];

  // stdout = raw PCM
  proc.stdout.on("data", (chunk: Buffer) => {
    for (const cb of audioCbs) cb(chunk);
  });

  // stderr = 逐行 JSON
  let stderrBuf = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = stderrBuf.indexOf("\n")) >= 0) {
      const line = stderrBuf.slice(0, nl).trim();
      stderrBuf = stderrBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.message_type === "metadata") {
          const m = msg.data as AudioMetadata;
          for (const cb of metaCbs) cb(m);
        }
      } catch {
        // 非 JSON log，忽略
      }
    }
  });

  proc.on("close", (code) => {
    for (const cb of closeCbs) cb(code);
  });

  return {
    onAudio: (cb) => audioCbs.push(cb),
    onMetadata: (cb) => metaCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    stop: () => proc.kill("SIGTERM"),
  };
}

// 獨立測試：bun run src/capture/darwin.ts  → 截 5 秒，印 byte 統計
if (import.meta.main) {
  let total = 0;
  let chunks = 0;
  const h = startCapture({ sampleRate: 16000 });
  h.onMetadata((m) =>
    console.error(`[metadata] ${m.encoding} ${m.sample_rate}Hz ${m.bits_per_channel}bit ch=${m.channels_per_frame}`)
  );
  h.onAudio((pcm) => {
    total += pcm.length;
    chunks++;
  });
  h.onClose((code) =>
    console.error(`[close] code=${code} chunks=${chunks} bytes=${total} (~${(total / 32000).toFixed(1)}s)`)
  );
  console.error("截音 5 秒中…（播點聲音）");
  setTimeout(() => h.stop(), 5000);
}
