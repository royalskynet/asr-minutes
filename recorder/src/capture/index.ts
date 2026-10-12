// capture/index.ts — 平台分派層（Windows 接縫預留）
//
// 目前支援 macOS（darwin），Windows（win32）已預留接口，實作中。

export type { CaptureOptions, CaptureHandle, AudioMetadata } from "./types.ts";
import type { CaptureOptions, CaptureHandle } from "./types.ts";

// darwin 實作直接靜態引入，win32 留介面供未來實作
import { startCapture as darwinStartCapture } from "./darwin.ts";

export function startCapture(opts: CaptureOptions = {}): CaptureHandle {
  if (process.platform === "darwin") {
    return darwinStartCapture(opts);
  }
  if (process.platform === "win32") {
    throw new Error("Windows capture: coming soon（WASAPI loopback 版本開發中）");
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}
