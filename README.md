# asr-minutes

把會議錄音變成可存檔的會議紀要：本機錄音與離線語音轉寫（`recorder/`），再由 Claude skill 修正誤聽、整理成「先講決定」的紀要（`SKILL.md`）。

Turn meeting audio into minutes you can file: record and transcribe offline on your Mac (`recorder/`), then let a Claude skill fix ASR mishearings and write decision-first minutes (`SKILL.md`).

## 快速安裝／Quick install

只裝會議紀要 skill（Claude Code）／Skill only (Claude Code):

```bash
git clone https://github.com/royalskynet/asr-minutes ~/.claude/skills/asr-minutes
```

連錄音 App 一起裝（macOS 14.2+、Apple Silicon、需要 `bun` 與 Xcode Command Line Tools）／With the recorder app:

```bash
git clone https://github.com/royalskynet/asr-minutes && cd asr-minutes/recorder && ./scripts/setup.sh && bun run ui
```

`setup.sh` 會編譯截音工具、下載本機 STT 模型（約 300MB），之後開 http://localhost:7321。

## 中文說明

### 會議紀要 skill（`SKILL.md`）

把逐字稿丟給 Claude，skill 會先修復聲學誤聽，再整理紀要：

- **先修再整理**：依 `references/asr-glossary.md` 的誤聽對照表還原專名與術語；無法確認的保留原文並標「待確認」，不腦補。
- **重點優先**：能抽出決策的會議寫成章節式決策文件（範圍、流程、決議、待辦），不照講話順序流水帳。
- **已確認與未確認分開**：假設、舉例、反問不會被寫成結論。
- **詞彙表越用越準**：每次整理後輸出「詞彙表增量」，貼回詞彙表即可。附的詞彙表是虛構範本，換成你自己的公司、產品、人名。

### 錄音 App（`recorder/`）

- 用 Core Audio tap 截系統音訊，不需要管理員權限，視訊會議軟體或網頁會議都能錄。
- 即時轉寫：sherpa-onnx 串流 zipformer（中英雙語），全程在本機跑。
- 會後精修：Silero VAD 切段＋SenseVoice 離線重辨識（中英日韓粵）。
- 自動語音會議記錄：偵測指定會議 App 開始出聲就自動錄音（設環境變數 `MEETING_APP_BUNDLE_ID`，例 `us.zoom.xos`、`com.microsoft.teams2`）。
- 自動摘要：用內建的紀要方法論（`src/notes/minutes-methodology.md`）呼叫 LLM，依序嘗試本機 `codex`／`claude` CLI、OpenRouter 免費模型、NVIDIA NIM 免費額度。
- 預設不保留音檔。

**錄音前請先取得與會者同意，並遵守你所在地區與公司的規定。**

## English

### Minutes skill (`SKILL.md`)

Give Claude a transcript and the skill repairs mishearings first, then writes the minutes:

- **Repair before summarizing**: proper nouns and terms are restored from the mishearing table in `references/asr-glossary.md`. Anything it cannot confirm stays verbatim and is marked "to be confirmed".
- **Decisions first**: when a meeting has a decision skeleton (scope, process, resolutions, action items), the minutes follow it instead of the order people spoke in.
- **Confirmed vs. open kept apart**: hypotheticals, examples and rhetorical questions are never written up as conclusions.
- **A glossary that grows**: each run ends with a "glossary delta" you paste back. The bundled glossary is a fictional template; replace it with your own companies, products and names.

The skill writes minutes in Simplified Chinese by default and can produce matching Chinese and English versions for English-language meetings.

### Recorder app (`recorder/`)

- Captures system audio with a Core Audio tap, with no admin rights needed, so desktop and browser meeting apps both work.
- Live transcription with a streaming sherpa-onnx zipformer (Chinese and English), fully on-device.
- After the meeting, Silero VAD plus SenseVoice re-transcribes offline (Chinese, English, Japanese, Korean, Cantonese).
- Automatic voice meeting recording: starts when a chosen meeting app begins playing audio (set `MEETING_APP_BUNDLE_ID`, e.g. `us.zoom.xos` or `com.microsoft.teams2`).
- Auto-summary through the built-in minutes method (`src/notes/minutes-methodology.md`), trying the local `codex` / `claude` CLI, OpenRouter free models, then NVIDIA NIM free tier.
- Audio files are not kept by default.

**Get consent from everyone in the meeting before recording, and follow local law and your organization's rules.**
