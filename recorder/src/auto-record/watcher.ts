import { spawn, type ChildProcess } from "node:child_process";

export class MeetingSampleParser {
  private buffer = "";

  push(chunk: string): boolean[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const samples: boolean[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (typeof value.active === "boolean") samples.push(value.active);
      } catch { /* Ignore helper diagnostics and incomplete JSON. */ }
    }
    return samples;
  }
}

export interface WatcherHandle { stop(): void }
export function startMeetingAudioWatcher(options: {
  binary: string;
  onSample(active: boolean): void;
  onError(message: string): void;
}): WatcherHandle {
  const parser = new MeetingSampleParser();
  let stopped = false;
  let proc: ChildProcess | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const launch = () => {
    if (stopped) return;
    let stderr = "";
    proc = spawn(options.binary, [], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout?.on("data", (chunk) => {
      for (const active of parser.push(chunk.toString("utf8"))) options.onSample(active);
    });
    proc.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    proc.on("error", (error) => options.onError(error.message));
    proc.on("exit", (code) => {
      proc = null;
      if (stopped) return;
      options.onError(stderr.trim() || `Meeting watcher exited (${code ?? "unknown"})`);
      retry = setTimeout(launch, 5000);
    });
  };
  launch();
  return { stop() { stopped = true; if (retry) clearTimeout(retry); proc?.kill("SIGTERM"); } };
}
