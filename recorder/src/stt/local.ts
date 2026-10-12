// local.ts — 本地離線 STT，sherpa-onnx 串流 zipformer 雙語 zh-en (int8)
//
// 免費、離線、零憑證、會議內容不外流。RAM ~300–500MB。
// 吃 s16le PCM（來自 audiotee），轉 Float32 餵 sherpa-onnx OnlineRecognizer。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// sherpa-onnx-node 為 CJS，bun 可直接 require
import sherpa from "sherpa-onnx-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
// 排序建議 #1（部分）：模型目錄可用 STT_MODEL_DIR 覆寫，便於日後換更強模型。
const MODEL_DIR =
  process.env.STT_MODEL_DIR ??
  join(ROOT, "models", "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20");

// 排序建議 #3：熱詞檔（一行一詞）。存在且非空才啟用偏置解碼，否則維持預設 greedy。
const HOTWORDS_FILE = process.env.STT_HOTWORDS ?? join(ROOT, "config", "hotwords.txt");
function hotwordsActive(): boolean {
  try {
    return (
      existsSync(HOTWORDS_FILE) &&
      readFileSync(HOTWORDS_FILE, "utf8").replace(/^\s*#.*$/gm, "").trim().length > 0
    );
  } catch {
    return false;
  }
}

// int8 量化檔名（2023-02-20 模型）
const ENCODER = join(MODEL_DIR, "encoder-epoch-99-avg-1.int8.onnx");
const DECODER = join(MODEL_DIR, "decoder-epoch-99-avg-1.onnx");
const JOINER = join(MODEL_DIR, "joiner-epoch-99-avg-1.int8.onnx");
const TOKENS = join(MODEL_DIR, "tokens.txt");

export interface LocalSTTEvents {
  /** 部分結果（同一句持續更新） */
  onPartial?: (text: string) => void;
  /** 一句結束（endpoint），text 為最終句子 */
  onFinal?: (text: string) => void;
}

export interface LocalSTT {
  /** 餵 s16le PCM（mono, 16kHz） */
  feed(pcm: Buffer): void;
  /** 結束，flush 最後一句 */
  close(): void;
}

function assertModel() {
  for (const f of [ENCODER, DECODER, JOINER, TOKENS]) {
    if (!existsSync(f)) {
      throw new Error(`缺模型檔: ${f}\n請先下載 sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20 到 models/`);
    }
  }
}

/** s16le Buffer → Float32Array（-1..1） */
function s16leToFloat32(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

export function createLocalSTT(events: LocalSTTEvents = {}, sampleRate = 16000): LocalSTT {
  assertModel();

  function buildRecognizer(useHotwords: boolean) {
    return new sherpa.OnlineRecognizer({
      featConfig: { sampleRate, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: ENCODER, decoder: DECODER, joiner: JOINER },
        tokens: TOKENS,
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      // 熱詞需 modified_beam_search；無熱詞維持 greedy（原行為不變）
      decodingMethod: useHotwords ? "modified_beam_search" : "greedy_search",
      ...(useHotwords
        ? { hotwordsFile: HOTWORDS_FILE, hotwordsScore: Number(process.env.STT_HOTWORDS_SCORE ?? 2.0) }
        : {}),
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    });
  }

  const wantHotwords = hotwordsActive();
  let recognizer;
  try {
    recognizer = buildRecognizer(wantHotwords);
    if (wantHotwords) console.error(`  [STT] 熱詞啟用：${HOTWORDS_FILE}`);
  } catch (e) {
    if (wantHotwords) {
      console.error(`  [STT] 熱詞載入失敗，回退 greedy：${(e as Error).message}`);
      recognizer = buildRecognizer(false);
    } else {
      throw e;
    }
  }

  const stream = recognizer.createStream();
  let lastPartial = "";

  function drain() {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = recognizer.getResult(stream).text.trim();

    if (recognizer.isEndpoint(stream)) {
      if (text) events.onFinal?.(text);
      recognizer.reset(stream);
      lastPartial = "";
    } else if (text && text !== lastPartial) {
      lastPartial = text;
      events.onPartial?.(text);
    }
  }

  return {
    feed(pcm: Buffer) {
      const samples = s16leToFloat32(pcm);
      stream.acceptWaveform({ samples, sampleRate });
      drain();
    },
    close() {
      stream.inputFinished();
      // flush 殘餘解碼，強制吐出最後一句（即使 endpoint 未觸發、即使等於 lastPartial）
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const text = recognizer.getResult(stream).text.trim();
      if (text) events.onFinal?.(text);
    },
  };
}
