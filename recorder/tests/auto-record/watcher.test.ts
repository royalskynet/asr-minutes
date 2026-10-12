import { expect, test } from "bun:test";
import { MeetingSampleParser } from "../../src/auto-record/watcher.ts";

test("parses split and multiple JSON lines", () => {
  const parser = new MeetingSampleParser();
  expect(parser.push('{"active":tr')).toEqual([]);
  expect(parser.push('ue}\n{"active":false}\n')).toEqual([true, false]);
});

test("ignores malformed and unrelated lines", () => {
  const parser = new MeetingSampleParser();
  expect(parser.push('log\n{"other":true}\n{"active":"yes"}\n')).toEqual([]);
});
