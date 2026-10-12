import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../src/auto-record/settings.ts";

const dirs: string[] = [];
function settingsPath() {
  const dir = mkdtempSync(join(tmpdir(), "amn-settings-"));
  dirs.push(dir);
  return join(dir, "settings.json");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

test("missing settings default to enabled automatic mode", () => {
  expect(loadSettings(settingsPath())).toEqual(DEFAULT_SETTINGS);
});

test("invalid settings safely fall back field by field", () => {
  const path = settingsPath();
  writeFileSync(path, JSON.stringify({ autoDetectMeeting: "yes", meetingDetectionMode: "other" }));
  expect(loadSettings(path)).toEqual(DEFAULT_SETTINGS);
});

test("settings round trip", () => {
  const path = settingsPath();
  saveSettings(path, { autoDetectMeeting: false, meetingDetectionMode: "prompt", refineOn: false, keepAudio: true });
  expect(loadSettings(path)).toEqual({ autoDetectMeeting: false, meetingDetectionMode: "prompt", refineOn: false, keepAudio: true });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ autoDetectMeeting: false, meetingDetectionMode: "prompt", refineOn: false, keepAudio: true });
});
