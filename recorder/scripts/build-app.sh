#!/usr/bin/env bash
# build-app.sh — 將 audio-meeting-notes 打包為 macOS .app（arm64，ad-hoc 簽名）
#
# 用法：bash scripts/build-app.sh
# 產出：dist/AudioMeetingNotes.app
#
# 前提：macOS + Apple Silicon；bun 已安裝
# 不需要 Xcode（audiotee 應已由 setup.sh 編譯好）

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

APP_NAME="AudioMeetingNotes"
DIST="$ROOT/dist"
APP="$DIST/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources/app"

# ── 相依檢查 ──
echo "==> 1/6 檢查相依"
if [ ! -f "bin/audiotee" ] || [ ! -f "bin/meeting-audio-watch" ] || [ ! -d "node_modules/sherpa-onnx-darwin-arm64" ]; then
  echo "    缺少原生 binary 或 sherpa-onnx-darwin-arm64，執行 setup.sh…"
  # 只建相依，不下載模型（模型改由 app 首次啟動下載）
  bash scripts/setup.sh || true
fi
if [ ! -f "bin/audiotee" ] || [ ! -f "bin/meeting-audio-watch" ] || [ ! -d "node_modules/sherpa-onnx-darwin-arm64" ]; then
  echo "❌ App 打包所需的原生 binary 或 sherpa-onnx-darwin-arm64 仍不完整"
  exit 1
fi

BUN_SRC="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN_SRC" ]; then
  echo "❌ 找不到 bun，請先安裝：https://bun.sh"
  exit 1
fi

echo "    bun: $BUN_SRC"
echo "    audiotee: $ROOT/bin/audiotee"
echo "    meeting watcher: $ROOT/bin/meeting-audio-watch"

# ── 清空並建目錄結構 ──
echo "==> 2/6 建立 .app 目錄結構"
rm -rf "$APP"
mkdir -p "$MACOS" "$RESOURCES"

# ── 複製專案（排除 out/ models/ vendor/ .git/ config/*.txt 私檔）──
echo "==> 3/6 複製專案原始碼 + node_modules（含 sherpa dylib）"
mkdir -p "$RESOURCES"
rsync -a \
  --exclude ".git" \
  --exclude ".DS_Store" \
  --exclude "/out" \
  --exclude "/models" \
  --exclude "/vendor" \
  --exclude "/dist" \
  --exclude "/tests" \
  --exclude "/config/assistant-prompt.txt" \
  --exclude "/config/hotwords.txt" \
  --exclude "/config/settings.json" \
  "$ROOT"/ "$RESOURCES"/

# ── 複製 bun 二進位 ──
echo "==> 4/6 複製 bun 二進位"
cp "$BUN_SRC" "$MACOS/bun"
chmod +x "$MACOS/bun"

# ── 寫入 Info.plist ──
cp "$ROOT/packaging/Info.plist" "$CONTENTS/Info.plist"

# ── 圖示（Info.plist 的 CFBundleIconFile=AppIcon）──
if [ -f "$ROOT/packaging/AppIcon.icns" ]; then
  cp "$ROOT/packaging/AppIcon.icns" "$CONTENTS/Resources/AppIcon.icns"
fi

# ── 安裝 launcher ──
cp "$ROOT/packaging/launcher.sh" "$MACOS/launcher"
chmod +x "$MACOS/launcher"

# ── 簽名（先內後外，不靠 --deep）──
echo "==> 5/6 ad-hoc 簽名"

# 簽 audiotee（已有 linker adhoc，加 --force 強制重簽）
codesign --force -s - "$MACOS/bun" 2>/dev/null || true
codesign --force -s - "$RESOURCES/bin/audiotee" 2>/dev/null || true
codesign --force -s - "$RESOURCES/bin/meeting-audio-watch" 2>/dev/null || true

# 簽 sherpa dylib + .node
SHERPA_DIR="$RESOURCES/node_modules/sherpa-onnx-darwin-arm64"
if [ -d "$SHERPA_DIR" ]; then
  find "$SHERPA_DIR" -name "*.dylib" -o -name "*.node" | while read -r f; do
    codesign --force -s - "$f" 2>/dev/null || true
  done
fi

# 最後簽外層 bundle
codesign --force -s - "$APP"

# 驗證
echo "    驗證簽名…"
codesign --verify --deep --strict "$APP" && echo "    ✓ 簽名驗證通過" || echo "    ⚠ 簽名驗證警告（ad-hoc 可能不通過 --strict，正常）"

# ── 選擇性打 zip（分發用）──
echo "==> 6/6 打包 zip"
ZIP="$DIST/$APP_NAME.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "    ✓ $ZIP"

echo ""
echo "✓ 完成：$APP"
echo ""
echo "使用方式："
echo "  1. 將 $APP_NAME.app 拖入 ~/Applications"
echo "  2. 首次啟動：右鍵 → 打開（Gatekeeper 一次性放行）"
echo "  3. 授予「音訊錄製」TCC 權限（一次性）"
echo "  4. 首次啟動自動下載 STT 模型（~100MB）"
