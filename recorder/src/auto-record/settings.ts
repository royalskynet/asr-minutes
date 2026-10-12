import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ProviderEntry, type ProviderType } from "../llm/router.ts";

export type MeetingDetectionMode = "automatic" | "prompt";
const PROVIDER_TYPES: ProviderType[] = ["cheaperinference", "claude-cli", "codex-cli", "omniroute", "openrouter", "nvidia-nim"];
export interface AutoRecordSettings {
  autoDetectMeeting: boolean;
  meetingDetectionMode: MeetingDetectionMode;
  /** 會後以 SenseVoice 離線精修逐字稿 */
  refineOn: boolean;
  /** 精修後保留音檔（預設 false：完成即刪，隱私守約） */
  keepAudio: boolean;
  /** LLM provider 編排順序（fallback 序）；空/缺省 = 走預設 */
  providers?: ProviderEntry[];
}

export const DEFAULT_SETTINGS: AutoRecordSettings = {
  autoDetectMeeting: true,
  meetingDetectionMode: "automatic",
  refineOn: true,
  keepAudio: false,
};

function sanitizeProvider(p: unknown): ProviderEntry | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (!PROVIDER_TYPES.includes(o.type as ProviderType)) return null;
  const e: ProviderEntry = { type: o.type as ProviderType };
  if (typeof o.baseUrl === "string" && o.baseUrl.trim()) e.baseUrl = o.baseUrl.trim();
  if (typeof o.model === "string" && o.model.trim()) e.model = o.model.trim();
  if (typeof o.enabled === "boolean") e.enabled = o.enabled;
  return e;
}

export function loadSettings(path: string): AutoRecordSettings {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const providers = Array.isArray(value.providers)
      ? value.providers.map(sanitizeProvider).filter((p): p is ProviderEntry => p !== null)
      : undefined;
    return {
      autoDetectMeeting: typeof value.autoDetectMeeting === "boolean" ? value.autoDetectMeeting : true,
      meetingDetectionMode: value.meetingDetectionMode === "prompt" ? "prompt" : "automatic",
      refineOn: typeof value.refineOn === "boolean" ? value.refineOn : true,
      keepAudio: typeof value.keepAudio === "boolean" ? value.keepAudio : false,
      ...(providers ? { providers } : {}),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(path: string, value: AutoRecordSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
