import { expect, test } from "bun:test";
import { createDetectionState, observeSample, suppressCurrentActivity } from "../../src/auto-record/state.ts";

const input = (active: boolean, now: number, origin: "manual" | "meeting" | null = null, mode: "automatic" | "prompt" = "automatic") =>
  ({ active, now, enabled: true, mode, recordingOrigin: origin });

test("starts once after two seconds of continuous Meeting audio", () => {
  const state = createDetectionState();
  expect(observeSample(state, input(true, 0)).action).toBe(null);
  expect(observeSample(state, input(true, 1999)).action).toBe(null);
  expect(observeSample(state, input(true, 2000)).action).toBe("start");
  expect(observeSample(state, input(true, 4000)).action).toBe(null);
});

test("short audio does not trigger and prompt mode prompts once", () => {
  const state = createDetectionState();
  observeSample(state, input(true, 0, null, "prompt"));
  expect(observeSample(state, input(false, 1000, null, "prompt")).action).toBe(null);
  observeSample(state, input(false, 6000, null, "prompt"));
  observeSample(state, input(true, 7000, null, "prompt"));
  expect(observeSample(state, input(true, 9000, null, "prompt")).action).toBe("prompt");
  expect(observeSample(state, input(true, 12000, null, "prompt")).action).toBe(null);
});

test("mode changes apply to the next Meeting activity", () => {
  const state = createDetectionState();
  observeSample(state, input(true, 0, null, "automatic"));
  expect(observeSample(state, input(true, 2000, null, "prompt")).action).toBe("start");
});

test("stops only Meeting-started recording after five inactive seconds", () => {
  const state = createDetectionState();
  observeSample(state, input(true, 0));
  observeSample(state, input(true, 2000));
  expect(observeSample(state, input(false, 3000, "meeting")).action).toBe(null);
  expect(observeSample(state, input(false, 8000, "meeting")).action).toBe("stop");
  expect(observeSample(state, input(false, 9000, "meeting")).action).toBe(null);
  const manual = createDetectionState();
  observeSample(manual, input(false, 0, "manual"));
  expect(observeSample(manual, input(false, 5000, "manual")).action).toBe(null);
});

test("manual stop suppresses current activity until inactive reset", () => {
  const state = createDetectionState();
  observeSample(state, input(true, 0));
  suppressCurrentActivity(state);
  expect(observeSample(state, input(true, 4000)).action).toBe(null);
  observeSample(state, input(false, 5000));
  observeSample(state, input(false, 10000));
  observeSample(state, input(true, 11000));
  expect(observeSample(state, input(true, 13000)).action).toBe("start");
});
