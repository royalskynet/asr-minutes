import { expect, test } from "bun:test";
import { parsePromptResult } from "../../src/auto-record/prompt.ts";

test("accepts only an explicit non-timeout start response", () => {
  expect(parsePromptResult("button returned:開始錄音, gave up:false")).toBe(true);
  expect(parsePromptResult("button returned:略過, gave up:false")).toBe(false);
  expect(parsePromptResult("button returned:開始錄音, gave up:true")).toBe(false);
  expect(parsePromptResult("button returned:開始錄音")).toBe(false);
  expect(parsePromptResult("")).toBe(false);
});
