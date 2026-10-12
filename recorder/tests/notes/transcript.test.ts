import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// OUT_DIR 在模組載入時綁定 → 必須先設 env 再動態 import，避免測到真實 out/
const dir = mkdtempSync(join(tmpdir(), "amn-trace-"));
process.env.OUT_DIR = dir;
const { Transcript } = await import("../../src/notes/transcript.ts");

afterEach(() => { rmSync(dir, { recursive: true }); });

// 每測試用唯一 dateStr，避免共用 OUT_DIR 下檔名相撞
function newTranscript(tag: string) {
  return new Transcript({
    source: "Audio / 系統音訊",
    engine: "test-engine",
    startMs: Date.now(),
    dateStr: "2026-08-13-" + tag,
    timeStr: "1200",
  });
}

test("replaceLines 覆寫逐字稿區並保留 frontmatter，finish 追加摘要", async () => {
  const t = newTranscript("a");
  t.append("對方", "這是即時稿第一句。", Date.now());
  t.append("對方", "這是即時稿第二句。", Date.now());

  const refined = [
    { t: Date.now(), speaker: "對方", text: "這是精修後的一整段，含標點。" },
    { t: Date.now() + 5000, speaker: "對方", text: "第二段也精修過了！" },
  ];
  await t.replaceLines(refined);

  // finish 前 plainText 已是精修稿（餵給 summarize/LLM 的輸入品質提升）
  expect(t.plainText()).toContain("這是精修後的一整段，含標點。");
  expect(t.plainText()).not.toContain("即時稿第一句");

  await t.finish("## 重點摘要\n\n会议重點。\n");

  const raw = readFileSync(t.path, "utf8");
  expect(raw).toContain("date: 2026-08-13-a");
  expect(raw).toContain("## 逐字稿");
  expect(raw).toContain("這是精修後的一整段，含標點。");
  expect(raw).not.toContain("即時稿第一句");
  expect(raw).toContain("## 重點摘要");
  expect(raw).toContain("会议重點。");
});

test("replaceLines 前（僅即時稿）plainText 反映即時逐字稿", () => {
  const t = newTranscript("b");
  t.append("對方", "A", Date.now());
  t.append("對方", "B", Date.now());
  expect(t.plainText()).toBe("對方：A\n對方：B");
});