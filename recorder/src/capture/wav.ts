// wav.ts — 純 Node 的 RIFF/WAVE writer（無新增依賴）
//
// 用於 pipeline tee：直播錄音時把 PCM 同時寫進 .wav，會議結束供離線精修。
// 寫 44-byte 標準 header（s16le/mono/16kHz 預設），end() 時回填 size 欄位。

import { createWriteStream, type WriteStream } from "node:fs";
import { openSync, closeSync, writeSync } from "node:fs";

const WAV_HEADER_SIZE = 44;

function makeWavHeader(
  sampleRate: number,
  channels: number,
  bits: number,
  dataBytes: number
): Buffer {
  const b = Buffer.alloc(WAV_HEADER_SIZE);
  const byteRate = sampleRate * channels * Math.floor(bits / 8);
  const blockAlign = channels * Math.floor(bits / 8);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataBytes, 4); // RIFF chunk 大小
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); // fmt chunk 大小（PCM)
  b.writeUInt16LE(1, 20); // audio format = PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bits, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

export interface WavWriterOptions {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
}

export class WavWriter {
  readonly path: string;
  private stream: WriteStream;
  private dataBytes = 0;
  private sampleRate: number;
  private channels: number;
  private bits: number;
  private ended = false;

  constructor(path: string, opts: WavWriterOptions = {}) {
    this.path = path;
    this.sampleRate = opts.sampleRate ?? 16000;
    this.channels = opts.channels ?? 1;
    this.bits = opts.bitsPerSample ?? 16;
    this.stream = createWriteStream(path, { flags: "w" });
    this.stream.write(
      makeWavHeader(this.sampleRate, this.channels, this.bits, 0)
    );
  }

  /** 依序 append PCM（s16le，strict mono） */
  write(pcm: Buffer): void {
    this.dataBytes += pcm.length;
    this.stream.write(pcm);
  }

  /** 結束：flush、關檔、回填 header 的 size 欄位 */
  end(): Promise<void> {
    if (this.ended) return Promise.resolve();
    this.ended = true;
    return new Promise((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    }).then(() => {
      const fd = openSync(this.path, "r+");
      try {
        const riffSize = Buffer.alloc(4);
        riffSize.writeUInt32LE(36 + this.dataBytes, 0);
        writeSync(fd, riffSize, 0, 4, 4);
        const dataSize = Buffer.alloc(4);
        dataSize.writeUInt32LE(this.dataBytes, 0);
        writeSync(fd, dataSize, 0, 4, 40);
      } finally {
        closeSync(fd);
      }
    });
  }
}
