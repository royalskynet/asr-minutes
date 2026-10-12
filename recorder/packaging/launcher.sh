#!/bin/bash
# launcher — CFBundleExecutable for AudioMeetingNotes.app
# 解析 bundle 根，設定環境，啟動 bun server，自動開瀏覽器。
set -euo pipefail

# ── 解析 bundle 路徑 ──
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
MACOS_DIR="$(dirname "$SCRIPT_PATH")"
BUNDLE_ROOT="$(dirname "$MACOS_DIR")"         # .app/Contents
RESOURCES_APP="$BUNDLE_ROOT/Resources/app"
BUN="$MACOS_DIR/bun"

# ── 擴張 PATH（讓 router.ts 能找到 codex / claude CLI）──
# nvm 目前版本的 bin 也要納入：claude / codex 都裝在那裡，GUI 啟動時不會有。
NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:${NVM_BIN:+$NVM_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/local/sbin:$PATH"

# ── 載入憑證庫（LLM fallback 用；缺檔就略過）──
for _c in cheaperinference omniroute openrouter nvidia; do
  for _f in "$HOME/.creds/$_c/.env" "$HOME/.creds/$_c/env"; do  # cheaperinference 用 env（無點）
    if [ -f "$_f" ]; then set -a; . "$_f"; set +a; fi
  done
done

# ── 可寫資料夾（~/Library/Application Support/AudioMeetingNotes）──
APP_SUPPORT="$HOME/Library/Application Support/AudioMeetingNotes"
export OUT_DIR="$APP_SUPPORT/out"
export CONFIG_DIR="$APP_SUPPORT/config"
export STT_MODEL_DIR="$APP_SUPPORT/models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
export STT_REFINE_MODEL_DIR="$APP_SUPPORT/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
export STT_SILERO_VAD="$APP_SUPPORT/models/silero_vad.int8.onnx"

mkdir -p "$OUT_DIR" "$CONFIG_DIR" "$STT_MODEL_DIR" "$STT_REFINE_MODEL_DIR"

# 首次啟動下載精修模型（SenseVoice int8 ~228MB + silero VAD ~208KB），
# 與 scripts/setup.sh 7/8 同步；已存在則略過，不中斷啟動。
if [ ! -f "$STT_REFINE_MODEL_DIR/model.int8.onnx" ]; then
  (curl -fL --retry 3 -o "$APP_SUPPORT/models/refine.tar.bz2" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2" \
    && tar xjf "$APP_SUPPORT/models/refine.tar.bz2" -C "$APP_SUPPORT/models" \
    && rm "$APP_SUPPORT/models/refine.tar.bz2") 2>/dev/null || \
  echo "⚠ SenseVoice 下載失敗，會後精修將停用（下次啟動會重試）"
fi
if [ ! -f "$STT_SILERO_VAD" ]; then
  curl -fL --retry 3 -o "$STT_SILERO_VAD" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.int8.onnx" 2>/dev/null || true
fi

# 若 Application Support config 尚無助理提示詞範本，從 bundle 複製
EXAMPLE_SRC="$RESOURCES_APP/config/assistant-prompt.example.txt"
EXAMPLE_DST="$CONFIG_DIR/assistant-prompt.example.txt"
if [ -f "$EXAMPLE_SRC" ] && [ ! -f "$EXAMPLE_DST" ]; then
  cp "$EXAMPLE_SRC" "$EXAMPLE_DST"
fi

# ── 確認 PORT（預設 7321）──
PORT="${PORT:-7321}"
export PORT

# ── 啟動 bun server（背景）──
cd "$RESOURCES_APP"
"$BUN" run src/server.ts 2>/tmp/audiomeetingnotes.log &
SERVER_PID=$!

# ── 等候 /status 就緒，最多 30 秒 ──
URL="http://127.0.0.1:$PORT"
for i in $(seq 1 60); do
  if curl -sf "$URL/status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# ── 開瀏覽器 ──
open "$URL/"

# ── 等候 server 結束（讓 .app 保持前景，關閉視窗不 kill server）──
wait $SERVER_PID
