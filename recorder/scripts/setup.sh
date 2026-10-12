#!/usr/bin/env bash
# setup.sh — 重建本地相依（截音 binary + 本地 STT 模型）
# 因 vendor/、bin/audiotee、models/ 不入庫，clone 後跑此腳本重建。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/8 檢查工具鏈"
command -v swift >/dev/null || { echo "缺 swift（Xcode Command Line Tools）"; exit 1; }
command -v bun   >/dev/null || { echo "缺 bun"; exit 1; }

echo "==> 2/8 安裝 node 相依"
bun install

echo "==> 3/8 編譯 audiotee 截音 binary（Core Audio tap，免 admin）"
if [ ! -d vendor/audiotee ]; then
  git clone --depth 1 https://github.com/makeusabrew/audiotee.git vendor/audiotee
fi
( cd vendor/audiotee && swift build -c release )
mkdir -p bin
cp vendor/audiotee/.build/release/audiotee bin/audiotee
chmod +x bin/audiotee
echo "    bin/audiotee 就緒"

echo "==> 4/8 編譯 Meeting 音訊狀態 watcher（Core Audio，免 admin）"
swiftc -target arm64-apple-macos14.2 native/meeting-audio-watch.swift -framework CoreAudio -framework AppKit -o bin/meeting-audio-watch
chmod +x bin/meeting-audio-watch
echo "    bin/meeting-audio-watch 就緒"

echo "==> 5/8 下載本地 STT 模型（sherpa-onnx 串流 zipformer 雙語 zh-en）"
MODEL=sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20
if [ ! -d "models/$MODEL" ]; then
  mkdir -p models
  curl -fL --retry 3 -o "models/$MODEL.tar.bz2" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$MODEL.tar.bz2"
  tar xjf "models/$MODEL.tar.bz2" -C models
  rm "models/$MODEL.tar.bz2"
fi
echo "    models/$MODEL 就緒"

echo "==> 6/8 設定檔範本（首次複製，不覆寫既有）"
mkdir -p config
[ -f config/assistant-prompt.txt ] || { [ -f config/assistant-prompt.example.txt ] && cp config/assistant-prompt.example.txt config/assistant-prompt.txt; }
echo "    config/assistant-prompt.txt 可編輯領域背景；config/hotwords.txt（選用）可加熱詞"

echo "==> 7/8 下載 SenseVoice 精修模型（會後離線辨識，中英日韓粵，int8 ~228MB）"
REFINE=sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17
if [ ! -f "models/$REFINE/model.int8.onnx" ]; then
  mkdir -p models
  curl -fL --retry 3 -o "models/$REFINE.tar.bz2" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$REFINE.tar.bz2"
  tar xjf "models/$REFINE.tar.bz2" -C models
  rm "models/$REFINE.tar.bz2"
fi
echo "    models/$REFINE 就緒"

echo "==> 8/8 下載 silero VAD 模型（精修切段用，int8 ~208KB）"
VAD=silero_vad.int8.onnx
if [ ! -f "models/$VAD" ]; then
  mkdir -p models
  curl -fL --retry 3 -o "models/$VAD" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$VAD"
fi
echo "    models/$VAD 就緒"

echo ""
echo "✓ 完成。首次跑 'bun run start' 會跳一次 macOS 音訊錄製同意框（非 admin）。"
