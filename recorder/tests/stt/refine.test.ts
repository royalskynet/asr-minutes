import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  REFINE_MODEL_DIR,
  stripSpecialTags,
  missingModelFiles,
  refineWav,
} from "../../src/stt/refine.ts";

describe("stripSpecialTags", () => {
  test("移除 SenseVoice 語言/情感/事件標籤", () => {
    expect(stripSpecialTags("<|zh|><|NEUTRAL|><|Speech|>開飯時間到了。")).toBe("開飯時間到了。");
    expect(stripSpecialTags("I have  <|en|> a plan.")).toBe("I have a plan.");
  });

  test("空字串與純標籤", () => {
    expect(stripSpecialTags("<|zh|><|Speech|>")).toBe("");
    expect(stripSpecialTags("")).toBe("");
  });
});

test("缺模型時回報缺檔清單（非炸例外）", () => {
  // 預設 models/ 不存在即應列出 3 個缺檔
  const missing = missingModelFiles();
  if (!existsSync(REFINE_MODEL_DIR)) {
    expect(missing.length).toBeGreaterThan(0);
  }
});

// ── model-gated 整合測試 ──
// 需先跑 scripts/setup.sh 下載 SenseVoice + silero VAD 才會執行；缺模型則略過。
const MODEL_READY =
  existsSync(join(REFINE_MODEL_DIR, "model.int8.onnx")) &&
  existsSync(join(REFINE_MODEL_DIR, "tokens.txt"));
const TEST_WAV_EN = join(REFINE_MODEL_DIR, "test_wavs", "en.wav");
const TEST_WAV_ZH = join(REFINE_MODEL_DIR, "test_wavs", "zh.wav");

test.skipIf(!(MODEL_READY && existsSync(TEST_WAV_EN)))(
  "model: 精修英文測試音檔，輸出非空且含標點",
  () => {
    const segments = refineWav(TEST_WAV_EN);
    expect(segments.length).toBeGreaterThan(0);
    const full = segments.map((s) => s.text).join(" ");
    expect(full.length).toBeGreaterThan(10);
    // SenseVoice 開啟 use_itn 後輸出應含標點
    expect(full).toMatch(/[。！？,.!?，]/);
    // 每段時間戳合理遞增
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].startSec).toBeGreaterThanOrEqual(segments[i - 1].startSec);
    }
  }
);

test.skipIf(!(MODEL_READY && existsSync(TEST_WAV_ZH)))(
  "model: 精修中文測試音檔",
  () => {
    const segments = refineWav(TEST_WAV_ZH);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.some((s) => /[\u4e00-\u9fff]/.test(s.text))).toBe(true);
  }
);
