// capture/types.ts — 共享介面（避免循環依賴）

export interface CaptureOptions {
  sampleRate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;
  /** 只截這些 PID（空 = 全系統） */
  includeProcesses?: number[];
  excludeProcesses?: number[];
  /** 200ms 預設 */
  chunkDuration?: number;
}

export interface AudioMetadata {
  encoding: string; // "pcm_s16le"
  sample_rate: number;
  bits_per_channel: number;
  channels_per_frame: number;
  is_float: boolean;
}

export interface CaptureHandle {
  /** 每來一塊 PCM 觸發（Buffer，s16le） */
  onAudio(cb: (pcm: Buffer) => void): void;
  /** 拿到音訊格式 metadata 時觸發 */
  onMetadata(cb: (meta: AudioMetadata) => void): void;
  /** audiotee 結束時觸發 */
  onClose(cb: (code: number | null) => void): void;
  /** 停止截音 */
  stop(): void;
}
