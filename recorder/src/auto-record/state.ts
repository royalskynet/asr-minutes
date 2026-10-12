import type { MeetingDetectionMode } from "./settings.ts";

export type RecorderOrigin = "manual" | "meeting" | null;
export type DetectionAction = "start" | "prompt" | "stop" | null;
export interface DetectionState {
  activeSince: number | null;
  inactiveSince: number | null;
  activityMode: MeetingDetectionMode | null;
  handled: boolean;
  rawActive: boolean;
}
export interface DetectionInput {
  active: boolean;
  now: number;
  enabled: boolean;
  mode: MeetingDetectionMode;
  recordingOrigin: RecorderOrigin;
}

export const ACTIVATE_MS = 2000;
export const DEACTIVATE_MS = 5000;

export function createDetectionState(): DetectionState {
  return { activeSince: null, inactiveSince: null, activityMode: null, handled: false, rawActive: false };
}

export function suppressCurrentActivity(state: DetectionState): void {
  if (state.rawActive) state.handled = true;
}

export function observeSample(state: DetectionState, input: DetectionInput): { action: DetectionAction } {
  state.rawActive = input.active;
  if (input.active) {
    state.inactiveSince = null;
    if (state.activeSince === null) {
      state.activeSince = input.now;
      state.activityMode = input.mode;
    }
    if (!input.enabled || state.handled || input.recordingOrigin !== null) return { action: null };
    if (input.now - state.activeSince >= ACTIVATE_MS) {
      state.handled = true;
      return { action: state.activityMode === "prompt" ? "prompt" : "start" };
    }
    return { action: null };
  }

  state.activeSince = null;
  state.activityMode = null;
  if (state.inactiveSince === null) state.inactiveSince = input.now;
  if (input.now - state.inactiveSince < DEACTIVATE_MS) return { action: null };
  const shouldStop = state.handled && input.recordingOrigin === "meeting";
  state.handled = false;
  return { action: shouldStop ? "stop" : null };
}
