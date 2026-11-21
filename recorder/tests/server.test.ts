import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/auto-record/settings.ts";

let child: ReturnType<typeof Bun.spawn> | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (child) {
    child.kill();
    await child.exited;
    child = undefined;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function start(host?: string) {
  dir = mkdtempSync(join(tmpdir(), "amn-server-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const env = { ...process.env, PORT: String(port), HOME: dir, OUT_DIR: join(dir, "out"), CONFIG_DIR: join(dir, "config") };
  delete env.HOST;
  if (host !== undefined) env.HOST = host;
  child = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."), env, stdout: "ignore", stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
    try {
      if ((await fetch(base + "/status")).ok) return { base, port };
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error("server did not start");
}

async function post(base: string, path: string, body: unknown) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("server defaults to loopback and sanitizes provider settings", async () => {
  const { base, port } = await start();
  await expect(fetch(`http://127.0.0.2:${port}/status`)).rejects.toThrow();
  const providers = [null, {}, { type: "unknown" }, { type: "openrouter", model: " x:free ", baseUrl: " https://example.com ", enabled: false, extra: "ignored" }];
  const response = await post(base, "/settings", { providers });
  expect(response.status).toBe(200);
  const saved = loadSettings(join(dir!, "config", "settings.json"));
  expect((await response.json()).providers).toEqual(saved.providers);
  expect(saved.providers).toEqual([{ type: "openrouter", model: "x:free", baseUrl: "https://example.com", enabled: false }]);
  for (const providers of [[], [null, { type: "bad" }]]) {
    expect((await (await post(base, "/settings", { providers })).json()).providers).toEqual([]);
  }
  expect((await (await post(base, "/settings", { providers: "invalid" })).json()).providers).toBeUndefined();
}, 10000);

test("HOST permits an explicit wildcard bind", async () => {
  const { port } = await start("0.0.0.0");
  expect((await fetch(`http://127.0.0.2:${port}/status`)).status).toBe(200);
}, 10000);

test("credential files are private on creation and replacement; invalid keys do not write", async () => {
  const { base } = await start();
  const file = join(dir!, ".creds", "openrouter", ".env");
  for (const body of [{ type: "unknown", apiKey: "test" }, { type: "openrouter", apiKey: "" }, { type: "openrouter", apiKey: "bad\nkey" }]) {
    expect((await post(base, "/providers/key", body)).status).toBe(400);
    expect(existsSync(file)).toBe(false);
  }
  expect((await post(base, "/providers/key", { type: "openrouter", apiKey: "test-only" })).status).toBe(200);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir!, ".creds")).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir!, ".creds", "openrouter")).mode & 0o777).toBe(0o700);
  chmodSync(file, 0o644);
  expect((await post(base, "/providers/key", { type: "openrouter", apiKey: "replacement" })).status).toBe(200);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toContain("OPENROUTER_API_KEY=replacement");
}, 10000);
