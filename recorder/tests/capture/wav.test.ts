import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sherpa from "sherpa-onnx-node";
import { WavWriter } from "../../src/capture/wav.ts";

const dirs: string[] = [];
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "amn-wav-"));
  dirs.push(dir);
  return join(dir, "t.wav");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

test("WavWriter 寫入 PCM 並回填 header，readWave 可讀回相同樣本", async () => {
  const path = tempPath();
  const wav = new WavWriter(path, { sampleRate: 16000 });

  // 寫 3 塊：2 + 3 + 5 = 10 個樣本
  const chunk = (n: number) => {
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(i * 100, i * 2);
    return b;
  };
  wav.write(chunk(2));
  wav.write(chunk(3));
  wav.write(chunk(5));
  await wav.end();

  // 檔案 header size 欄位已回填
  const raw = readFileSync(path);
  expect(raw.toString("ascii", 0, 4)).toBe("RIFF");
  expect(raw.toString("ascii", 8, 12)).toBe("WAVE");
  expect(raw.readUInt32LE(4)).toBe(36 + 10 * 2); // RIFF chunk = 36 + data
  expect(raw.readUInt32LE(40)).toBe(10 * 2); // data chunk = 20 bytes

  // 下游（精修）用 readWave 讀回；最後塊 i=4 → 值 400
  const wave = sherpa.readWave(path);
  expect(wave.sampleRate).toBe(16000);
  expect(wave.samples.length).toBe(10);
  expect(wave.samples[9]).toBeCloseTo(4 * 100 / 32768, 5); // s16 → Float32
});

test("WavWriter 空寫入（0 樣本）也能正常結束", async () => {
  const path = tempPath();
  const wav = new WavWriter(path);
  await wav.end();
  const raw = readFileSync(path);
  expect(raw.readUInt32LE(40)).toBe(0);
  const wave = sherpa.readWave(path);
  expect(wave.samples.length).toBe(0);
});
