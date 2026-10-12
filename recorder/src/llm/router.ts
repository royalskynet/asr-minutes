// router.ts — 多供應商 LLM 路由（摘要用）
//
// 硬前提：不用付費/計量計費 API。優先序皆為「訂閱」或「免費」路線：
//   1. OpenAI Codex OAuth → 本機 `codex` CLI（codex exec，gpt-5.5）— 主力
//   2. Claude 訂閱       → 本機 `claude` CLI（claude -p）— 備援
//   3. OpenRouter free   → OPENROUTER_API_KEY + 模型 openrouter/free（pricing 0/0）
//   4. NVIDIA NIM free   → NVIDIA_API_KEY（免費額度）
//   0. CheaperInference  → CHEAPERINFERENCE_API_KEY，deepseek-v4-flash-0731（便宜計量；設了 key 就優先，省訂閱額度）
// 依可用憑證自動選第一個可用者。

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LLMProvider {
  name: string;
  /** 偵測憑證/CLI 是否就緒 */
  available(): boolean;
  /** 跑一次 prompt，回傳純文字 */
  complete(prompt: string): Promise<string>;
}

// 長逐字稿摘要常超過 90s；可用 LLM_CLI_TIMEOUT_MS 調整
const CLI_TIMEOUT_MS = Number(process.env.LLM_CLI_TIMEOUT_MS ?? 300_000);

/** CLI 失敗原因：被 timeout 砍（signal）或 exit≠0；錯誤常印在 stdout（如 "Not logged in"），兩者都帶 */
function cliFail(r: { status: number | null; signal: NodeJS.Signals | null; stdout?: string; stderr?: string }): string {
  if (r.signal) return `被 ${r.signal} 終止（逾時 ${CLI_TIMEOUT_MS / 1000}s?）`;
  return `exit ${r.status}: ${`${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim().slice(-400)}`;
}

function hasCmd(cmd: string): boolean {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

export type ProviderType = "cheaperinference" | "claude-cli" | "codex-cli" | "omniroute" | "openrouter" | "nvidia-nim";

/** 運行時編排項（GUI 設定存這個；key 不在此，走 ~/.creds/<type>/.env） */
export interface ProviderEntry {
  type: ProviderType;
  /** 可選覆蓋：baseUrl / model（僅 omniroute/openrouter/nvidia 有效） */
  baseUrl?: string;
  model?: string;
  /** false = 跳過該 provider */
  enabled?: boolean;
}

// 1. Claude 訂閱（claude CLI）
function buildClaudeCli(o?: ProviderEntry): LLMProvider {
  return {
    name: "claude-cli(訂閱)",
    available: () => hasCmd("claude"),
    complete: async (prompt) => {
      const r = spawnSync("claude", [...(o?.model ? ["--model", o.model] : []), "-p", prompt], {
            encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL",
            env: {
              ...process.env,
              // 必須 unset 而非指定 ~/.claude：顯式設定會改變 keychain 查找鍵 → "Not logged in"（stdout，exit 1）
              CLAUDE_CONFIG_DIR: undefined,
              ANTHROPIC_MODEL: undefined,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
              ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
              ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
              CLAUDE_CODE_SUBAGENT_MODEL: undefined,
            },
          });
      if (r.status !== 0 || !r.stdout?.trim()) throw new Error(`claude CLI 失敗: ${cliFail(r)}`);
      return r.stdout.trim();
    },
  };
}

// 2. OpenAI Codex OAuth（codex CLI）— gpt-5.5，吃 ~/.codex/auth.json 的 ChatGPT 訂閱 token。
//    用 -o 取乾淨最終訊息（stdout 含 banner/工具雜訊不可靠）；prompt 走 stdin 避免大逐字稿撞 ARG_MAX。
function buildCodexCli(o?: ProviderEntry): LLMProvider {
  return {
    name: "codex-cli(訂閱)",
    available: () => hasCmd("codex"),
    complete: async (prompt) => {
      const out = join(tmpdir(), `lmn-codex-${process.pid}-${Date.now()}.txt`);
      try {
        const r = spawnSync(
          "codex",
          ["exec", ...(o?.model ? ["-m", o.model] : []), "--skip-git-repo-check", "--color", "never", "-o", out, "-"],
          { input: prompt, encoding: "utf8", cwd: tmpdir(), maxBuffer: 32 * 1024 * 1024, timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL" }
        );
        if (r.status !== 0) throw new Error(`codex CLI 失敗: ${cliFail(r)}`);
        const text = existsSync(out) ? readFileSync(out, "utf8").trim() : "";
        if (!text) throw new Error(`codex CLI 無輸出: ${(r.stderr || "").slice(-300)}`);
        return text;
      } finally {
        try { if (existsSync(out)) unlinkSync(out); } catch {}
      }
    },
  };
}

// 3. OmniRoute free-tools combo（本機 gateway，內含 OpenRouter→NIM→AGNES 25 步容錯路由）
//    單一端點就有整條免費模型 fallback chain，優於本檔手寫的單模型分支。
function buildOmniroute(o?: ProviderEntry): LLMProvider {
  return {
    name: "omniroute" + (o?.model ? `/${o.model}` : ""),
    available: () => !!process.env.OMNIROUTE_API_KEY,
    complete: async (prompt) => {
      const base = o?.baseUrl ?? process.env.OMNIROUTE_BASE_URL ?? "http://localhost:20128";
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OMNIROUTE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: o?.model ?? process.env.OMNIROUTE_MODEL ?? "free-tools",
          stream: false,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`OmniRoute ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      return (j.choices?.[0]?.message?.content ?? "").trim();
    },
  };
}

// 4. OpenRouter free（免指定模型自動路由）
function buildOpenrouter(o?: ProviderEntry): LLMProvider {
  return {
    name: "openrouter" + (o?.model ? `/${o.model}` : ""),
    available: () => !!process.env.OPENROUTER_API_KEY,
    complete: async (prompt) => {
      const model = o?.model ?? "openrouter/free";
      // 僅限免費：openrouter/free 自動路由或 *:free；其他一律拒絕（轉下一個 provider），防誤設付費模型
      if (model !== "openrouter/free" && !model.endsWith(":free"))
        throw new Error(`OpenRouter 僅限免費模型（openrouter/free 或 *:free），拒絕 ${model}`);
      const base = o?.baseUrl ?? "https://openrouter.ai";
      const res = await fetch(`${base}/api/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
      const j = await res.json();
      return (j.choices?.[0]?.message?.content ?? "").trim();
    },
  };
}

// 0. CheaperInference（Anthropic 相容 /v1/messages；憑證 ~/.creds/cheaperinference/env）
function buildCheaperInference(o?: ProviderEntry): LLMProvider {
  const model = o?.model ?? process.env.LMN_CI_MODEL ?? "deepseek-v4-flash-0731";
  return {
    name: `cheaperinference/${model}`,
    available: () => !!process.env.CHEAPERINFERENCE_API_KEY,
    complete: async (prompt) => {
      const base = o?.baseUrl ?? process.env.CHEAPERINFERENCE_URL ?? "https://api.cheaperinference.com";
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": process.env.CHEAPERINFERENCE_API_KEY!,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(CLI_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`CheaperInference ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      return (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    },
  };
}

// 5. NVIDIA NIM free
function buildNvidia(o?: ProviderEntry): LLMProvider {
  return {
    name: "nvidia-nim" + (o?.model ? `/${o.model}` : ""),
    available: () => !!process.env.NVIDIA_API_KEY,
    complete: async (prompt) => {
      const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: o?.model ?? process.env.NVIDIA_MODEL ?? "deepseek-ai/deepseek-v4.1-flash",
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`NVIDIA ${res.status}: ${await res.text()}`);
      const j = await res.json();
      return (j.choices?.[0]?.message?.content ?? "").trim();
    },
  };
}

/** 依 entry 建 provider（key 仍從 process.env 讀，entry 只覆蓋 baseUrl/model）。 */
export function buildProvider(entry: ProviderEntry): LLMProvider {
  switch (entry.type) {
    case "cheaperinference": return buildCheaperInference(entry);
    case "claude-cli": return buildClaudeCli(entry);
    case "codex-cli": return buildCodexCli(entry);
    case "omniroute": return buildOmniroute(entry);
    case "openrouter": return buildOpenrouter(entry);
    case "nvidia-nim": return buildNvidia(entry);
  }
}

/** 預設 provider 清單（type 順序即預設 fallback 序）；type 名做 display 後綴 */
const DEFAULT_TYPES: ProviderType[] = ["cheaperinference", "claude-cli", "codex-cli", "omniroute", "openrouter", "nvidia-nim"];

// 相容層：既有 ORDER / chain / pickProvider 保持（LLM_PROVIDER env 過濾），供其他呼叫端使用。
const ORDER: LLMProvider[] = DEFAULT_TYPES.map((t) => buildProvider({ type: t, enabled: true }));
function chain(): LLMProvider[] {
  const only = process.env.LLM_PROVIDER?.trim();
  return only ? ORDER.filter((p) => p.name.includes(only)) : ORDER;
}

export function pickProvider(): LLMProvider | null {
  return chain().find((p) => p.available()) ?? null;
}

export async function complete(
  prompt: string,
  entries?: ProviderEntry[]
): Promise<{ provider: string; text: string }> {
  // 傳了 entries → 按序 build + 過濾 enabled !== false；沒傳 → 退回 env 預設（含 LLM_PROVIDER 過濾）
  const providers = entries && entries.length
    ? entries.filter((e) => e.enabled !== false).map((e) => buildProvider(e))
    : chain();
  const errors: string[] = [];
  for (const p of providers) {
    if (!p.available()) continue;
    try {
      const text = await p.complete(prompt);
      if (text) return { provider: p.name, text };
    } catch (e) {
      errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`所有 LLM 供應商皆失敗或無憑證:\n${errors.join("\n") || "（無任何可用供應商）"}`);
}
