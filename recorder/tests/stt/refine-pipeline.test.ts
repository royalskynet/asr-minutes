import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sherpa from "sherpa-onnx-node";
import { WavWriter } from "../../src/capture/wav.ts";
import { REFINE_MODEL_DIR, refineWav } from "../../src/stt/refine.ts";

// 模擬 index.ts 的 pipeline tee 路徑：capture 以 s16le PCM 塊送出 → WavWriter 全量寫入
// → 結束 end() 回填 header → refineWav 讀回離線精修。整條正是「精修」新程式碼的骨幹。

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true }); });

const MODEL_READY =
  existsSync(join(REFINE_MODEL_DIR, "model.int8.onnx")) &&
  existsSync(join(REFINE_MODEL_DIR, "tokens.txt"));
const TEST_WAV_EN = join(REFINE_MODEL_DIR, "test_wavs", "en.wav");

/** Float32 → s16le PCM Buffer（模擬 audiotee 輸出的 PCM 塊） */
function f32ToPcm(samples: Float32Array, chunkSamples = 512): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < samples.length; i += chunkSamples) {
    const n = Math.min(chunkSamples, samples.length - i);
    const b = Buffer.alloc(n * 2);
    for (let j = 0; j < n; j++) {
      let v = Math.round(samples[i + j] * 32768);
      v = Math.max(-32768, Math.min(32767, v));
      b.writeInt16LE(v, j * 2);
    }
    out.push(b);
  }
  return out;
}

test.skipIf(!(MODEL_READY && existsSync(TEST_WAV_EN)))(
  "tee→wav→refine 全路徑：餵 PCM 塊寫 wav，讀回精修出含標點英文稿",
  async () => {
    const modelDir = REFINE_MODEL_DIR;
    const dir = mkdtempSync(join(tmpdir(), "amn-tee-"));
    dirs.push(dir);
    const wavPath = join(dir, "meeting.wav");

    // 1) 像 capture 一樣把 PCM 塊寫進 WavWriter
    const src = sherpa.readWave(TEST_WAV_EN);
    const wav = new WavWriter(wavPath, { sampleRate: 16000 });
    for (const chunk of f32ToPcm(src.samples)) wav.write(chunk);
    await wav.end();

    // 2) 精修路徑取回分段稿
    const segments = refineWav(wavPath);
    expect(segments.length).toBeGreaterThan(0);
    const full = segments.map((s) => s.text).join(" ");
    expect(full).toContain("gold"); // 英文術語保留
    expect(full).toMatch(/[。,.!?！？]/); // 含標點
    expect(segments[0].startSec).toBeGreaterThanOrEqual(0); // 時間戳非負
  }
);
