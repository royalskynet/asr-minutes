import { spawn } from "node:child_process";

export function parsePromptResult(stdout: string): boolean {
  return stdout.includes("button returned:開始錄音") && stdout.includes("gave up:false");
}

export function askToStartRecording(): Promise<boolean> {
  const script = 'display dialog "偵測到 Meeting 語音，是否開始錄音？" buttons {"略過", "開始錄音"} default button "開始錄音" cancel button "略過" giving up after 30 with title "Audio Meeting Notes"';
  return new Promise((resolve) => {
    const proc = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    proc.on("error", () => resolve(false));
    proc.on("close", () => resolve(parsePromptResult(stdout)));
  });
}
