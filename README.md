# Git Story: AI-Driven Logical Code Review for VS Code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-^1.90.0-blue.svg)](https://marketplace.visualstudio.com/)

**Git Story** turns reviewing your uncommitted Git changes into an intuitive, logically sequenced walkthrough.

Instead of an overwhelming, alphabetical doom-scroll of diffs, Git Story acts as an architectural code review guide:
- **Logical Cognitive Sequencing**: Automatically determines the optimal order to review changes (Foundations & Schema &rarr; Core Business Logic &rarr; API & Handlers &rarr; UI Components &rarr; Tests & Verification), similar to how logical narratives progress from premise to implementation to verification.
- **Dual-Pane Review Reader**:
  - **Left Pane**: Distraction-free, syntax-highlighted diff with line numbers and word-level diffing.
  - **Right Pane**: An AI-guided technical walkthrough explaining *why* each file changed, how it builds on preceding changes in the sequence, and highlighting potential issues (bugs, regressions, unhandled edge cases, missing null checks, security flags).
- **Interactive Issue Jump Links**: Clicking any issue or watch-out badge smoothly scrolls the diff directly to that line with a soft highlight.
- **Interactive AI Questioning**: Ask follow-up questions about any file directly in the reader (*"Is this backward-compatible?", "Can this cause a memory leak?"*).
- **One-Click Conventional Commit**: Generates an intelligent conventional commit message summarizing the full review progression.

---

## 📖 The Dual-Pane Review Reader

```
+----------------------------------------------------------------------------------------------------+
|  [TOC]  Step 2 of 5: User Session Cache                 [All Changes v]  [Split Diff]  [Stage File] |
+--------------------------------------------------+-------------------------------------------------+
|  LEFT PANE: Clean Diff                           |  RIGHT PANE: Review Walkthrough & Insights      |
|                                                  |                                                 |
|  src/services/session.service.ts                 |  Walkthrough & Context                          |
|  @@ -14,6 +14,15 @@                             |  Building on the UserSession model introduced   |
|   import { CacheClient } from './cache';         |  in step 1, this implements a resilient redis   |
|  +export class SessionService {                  |  fallback so that auth tokens survive cluster   |
|  +  async getSession(id: string) {               |  restarts.                                      |
|  +    const hit = await redis.get(id);           |                                                 |
|  +    if (!hit) return db.fetch(id);    [!] L19  |  Potential Issues & Considerations              |
|  +    return JSON.parse(hit);                    |  * [Warning] L19: JSON.parse on malformed cache |
|  +  }                                            |    could throw UnhandledException. Wrap in      |
|  +}                                              |    try/catch.                                   |
|                                                  |                                                 |
|                                                  |  [Ask AI about this file...]                    |
+--------------------------------------------------+-------------------------------------------------+
|  [< Previous File]                 [Mark as Reviewed [x]]                       [Next File >]      |
+----------------------------------------------------------------------------------------------------+
```

---

## ⚡ Key Features

1. **Cognitive Sequencing**:
   In Git, files are usually sorted alphabetically (`a/...`, `b/...`), forcing you to read random tests or UI components before you even know what the underlying data models changed to. Git Story uses topological sorting and dependency analysis to order files by semantic layers.

2. **AI Provider Flexibility**:
   - **Auto Mode** (Default): Tries VS Code Language Models (`vscode.lm` with GitHub Copilot), then Google Gemini, then local Heuristic.
   - **Google Gemini**: Direct native API integration with `gemini-3.8-flash` or `gemini-3.8-pro`. Fast, ultra-long context, generous free tier.
   - **VS Code Language Model API**: Zero configuration if you already have Copilot or other VS Code LM extensions.
   - **OpenAI / Ollama / Local LLM**: Connect to OpenAI (`gpt-6-luna`), LM Studio, or local Ollama (`localhost:11434`) for offline privacy.
   - **Heuristic Offline Engine**: High-performance static code analysis, topological ordering, and pattern detection that works 100% offline without any API key or network access.

3. **Distraction-Free Editorial Aesthetics**:
   - Matches VS Code's active theme natively using VS Code CSS variables.
   - Soft tint diff highlighting (no harsh neon blocks).
   - Word-level intra-line highlights.
   - Review sequence progress bar (`Step 3 of 6`).
   - Slide-out Review Sequence (TOC) drawer.

4. **Keyboard-First Workflow**:
   - `[` or `J`: Previous file
   - `]` or `K`: Next file
   - `T`: Toggle Review Sequence drawer
   - `M`: Toggle "Mark as Reviewed"
   - `R`: Refresh working tree changes

---

## 🚀 Getting Started

1. Click the **`$(book) Review Changes`** item in the VS Code status bar (or open the Command Palette `Ctrl+Shift+P` / `Cmd+Shift+P` and type `Git Story: Review Changes in Logical Sequence`).
2. Git Story scans your active Git repository's working tree (staged & unstaged changes).
3. Walk through the changes in logical sequence in the review reader.
4. When finished, click **Finish & Commit** to create your commit with an AI-synthesized conventional commit message!

---

## Building a Local VSIX

Requires Node.js 22 or later. Run `npm install` once, then choose **Terminal > Run Task > Build VSIX** in VS Code, or run `npm run package`.

The task compiles the extension and creates `git-story-<version>.vsix` in the project root. Install it using **Extensions > ... > Install from VSIX...**.

Packaging skips the missing license-file check and excludes runtime dependency folders because esbuild bundles the extension.

---

## ⚙️ Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `gitStory.aiProvider` | string | `"auto"` | `"auto"`, `"vscode-lm"`, `"gemini"`, `"openai"`, `"ollama"`, or `"heuristic-only"` |
| `gitStory.geminiModel` | string | `"gemini-3.8-flash"` | Gemini model identifier |
| `gitStory.openaiModel` | string | `"gpt-6-luna"` | OpenAI model identifier |
| `gitStory.openaiBaseUrl` | string | `"https://api.openai.com/v1"` | OpenAI-compatible endpoint |
| `gitStory.ollamaEndpoint` | string | `"http://localhost:11434"` | Local Ollama base URL |
| `gitStory.ollamaModel` | string | `"llama3.2"` | Model to prompt in Ollama |
| `gitStory.diffViewMode` | string | `"split"` | Default diff view (`"split"` or `"unified"`) |
| `gitStory.themeStyle` | string | `"zen"` | Aesthetic style (`"zen"`, `"editorial"`, `"compact"`) |

---

## 🔒 Security & Privacy

- All API keys configured via `Git Story: Configure AI Provider & API Key` are securely encrypted using VS Code's native `SecretStorage`.
- In **Heuristic Only** or **Ollama** mode, no code or diff data ever leaves your computer.
