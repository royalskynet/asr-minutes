import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTopic, getDuration, getTopic, setMeta, setTopic, taggedName } from "../../src/notes/mdfile.ts";
import { retagFile } from "../../src/notes/transcript.ts";

const MD = `---\ndate: 2026-09-24\ntime: 1014\n---\n\n# 會議記錄\n\n## 逐字稿\n\n[23:50:00] 對方：開始\n\n[00:35:10] 對方：結束\n`;

test("LLM 輸出的引號/標點/路徑字元被清掉（檔名與 HTML 安全）", () => {
  expect(cleanTopic("「OTC 風控/規則評審」。")).toBe("OTC 風控規則評審");
  expect(cleanTopic('a<b>"c\'&d')).toBe("abcd");
});

test("時長：frontmatter 優先，否則由首末時間戳推算且跨午夜不為負", () => {
  expect(getDuration(MD)).toBe("45m");
  expect(getDuration(setMeta(MD, "duration", "1h05m"))).toBe("1h05m");
});

test("手動改名以日期時間 stem 重建檔名，不會疊加舊標籤", () => {
  expect(taggedName("2026-09-24-1014.md", "OTC 風控", "45m")).toBe("2026-09-24-1014_OTC-風控_45m.md");
  expect(taggedName("2026-09-24-1014_舊主題_45m.md", "新主題", "45m")).toBe("2026-09-24-1014_新主題_45m.md");
  expect(taggedName("2026-09-24-1014_舊主題_45m.md", "", "")).toBe("2026-09-24-1014.md");
});

test("retagFile 依 topic + 時長改名，已存在同名則不覆蓋", () => {
  const dir = mkdtempSync(join(tmpdir(), "amn-tag-"));
  try {
    const fp = join(dir, "2026-09-24-1014.md");
    writeFileSync(fp, setTopic(MD, "風控規則"));
    expect(getTopic(setTopic(MD, "風控規則"))).toBe("風控規則");
    const next = retagFile(fp);
    expect(readdirSync(dir)).toEqual(["2026-09-24-1014_風控規則_45m.md"]);
    expect(retagFile(next)).toBe(next); // 已是目標名 → 不動
  } finally {
    rmSync(dir, { recursive: true });
  }
});
