// platform.ts — 平台相依的系統操作封裝
import { spawnSync } from "node:child_process";

/** 用系統預設應用程式開啟路徑（檔案或資料夾） */
export function openPath(p: string): void {
  if (process.platform === "darwin") {
    spawnSync("open", [p]);
  } else if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", p]);
  } else {
    spawnSync("xdg-open", [p]);
  }
}
