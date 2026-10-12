// refine.ts — 會後離線精修：silero VAD 切段 + SenseVoice (sherpa-onnx OfflineRecognizer)
//
// 結束錄音後把整場 16kHz mono s16le .wav 讀入，silero VAD 切成語音段，
// 每段送 SenseVoice 離線辨識（int8，含標點、保住英文術語），回傳帶時間戳的分段稿。
// 模型路徑可用 STT_REFINE_MODEL_DIR / STT_SILERO_VAD 覆寫，預設在 models/（由 setup.sh 下載）。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import sherpa from "sherpa-onnx-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

export const REFINE_MODEL_DIR =
  process.env.STT_REFINE_MODEL_DIR ??
  join(ROOT, "models", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17");
export const SILERO_VAD =
  process.env.STT_SILERO_VAD ?? join(ROOT, "models", "silero_vad.int8.onnx");

export interface RefineSegment {
  /** 相對於音檔起點的秒數 */
  startSec: number;
  endSec: number;
  text: string;
}

/** 檢查精修所需模型檔是否齊備；缺檔回傳缺檔清單（空 = 就緒） */
export function missingModelFiles(): string[] {
  const files = [
    join(REFINE_MODEL_DIR, "model.int8.onnx"),
    join(REFINE_MODEL_DIR, "tokens.txt"),
    SILERO_VAD,
  ];
  return files.filter((f) => !existsSync(f));
}

/** 去掉 SenseVoice 可能夾帶的 `<|...|>` 語言/情感/事件標籤 */
export function stripSpecialTags(text: string): string {
  return text.replace(/<\|[^|]*\|>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * 對單支 .wav 做離線精修。
 * @param wavPath 16kHz mono s16le 的 .wav（WavWriter 產出格式）
 * @returns 帶時間戳的語音分段稿；若完全無語音則回傳空陣列
 */
export function refineWav(wavPath: string): RefineSegment[] {
  const missing = missingModelFiles();
  if (missing.length) {
    throw new Error(
      `缺精修模型檔：${missing.join(", ")}\n請執行 scripts/setup.sh 下載 SenseVoice + silero VAD 模型`
    );
  }

  const wave = sherpa.readWave(wavPath);
  if (!wave) throw new Error("無法讀取音檔（readWave 回傳空）");
  if (wave.sampleRate !== 16000) {
    throw new Error(`精修僅支援 16kHz 音檔，取得 ${wave.sampleRate}Hz`);
  }

  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: join(REFINE_MODEL_DIR, "model.int8.onnx"),
        language: "auto",
        useInverseTextNormalization: 1, // 啟用標點
      },
      tokens: join(REFINE_MODEL_DIR, "tokens.txt"),
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
  });

  // 官方 vad-sense-voice-c-api 同款參數（30 秒內建緩衝）
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: SILERO_VAD,
        threshold: 0.25,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.5,
        maxSpeechDuration: 10,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    30
  );

  // 官方 vad-with-non-streaming-asr 同款：逐 window 餵入並交錯 drain（勿一次整段餵入）
  const segments: RefineSegment[] = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      let text = "";
      try {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples: seg.samples, sampleRate: 16000 });
        recognizer.decode(stream);
        text = stripSpecialTags(recognizer.getResult(stream).text);
      } catch {
        // 單段失敗不中斷整場，跳過該段
      }
      if (text) {
        segments.push({
          startSec: seg.start / 16000,
          endSec: (seg.start + seg.samples.length) / 16000,
          text,
        });
      }
      vad.pop();
    }
  };

  const windowSize = 512; // silero 慣用窗口（與 vad config 一致）
  for (let i = 0; i < wave.samples.length; i += windowSize) {
    vad.acceptWaveform(wave.samples.subarray(i, i + windowSize));
    drain();
  }
  vad.flush();
  drain();

  return segments;
}
