# Git Story: AI-Driven Narrative Code Review for VS Code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-^1.90.0-blue.svg)](https://marketplace.visualstudio.com/)

**Git Story** turns reviewing your uncommitted Git changes before commit into an aesthetically pleasing, calm, distraction-free story.

Instead of an overwhelming, alphabetical doom-scroll of diffs, Git Story acts as an editorial AI review assistant:
- **Intelligent Narrative Sequencing**: Automatically figures out the optimal cognitive order to read the changes (Foundations & Schema &rarr; Core Business Logic &rarr; API & Handlers &rarr; UI Components &rarr; Tests & Verification).
- **Two-Page Book Reader**:
  - **Left Page**: Distraction-free, syntax-highlighted diff with line numbers and word-level diffing.
  - **Right Page**: An AI-narrated story chapter explaining *why* the file changed in the context of the overall mission, connecting it with previous chapters, and highlighting potential issues (bugs, regressions, unhandled edge cases, missing null checks, security flags).
- **Interactive Issue Jump Links**: Clicking any issue or watch-out badge smoothly scrolls the left page directly to that line with a soft, pulsing golden highlight.
- **Interactive AI Questioning**: Ask follow-up questions about any file directly in the reader (*"Is this backward-compatible?", "Can this cause a memory leak?"*).
- **One-Click Conventional Commit**: Generates an intelligent conventional commit message summarizing the full review arc.

---

## 📖 The Two-Page Zen Reader

```
+----------------------------------------------------------------------------------------------------+
|  [TOC]  Chapter 2 of 5: User Session Cache              [All Changes v]  [Split Diff]  [Stage File] |
+--------------------------------------------------+-------------------------------------------------+
|  LEFT PAGE: Clean Diff                           |  RIGHT PAGE: The AI Story & Insights            |
|                                                  |                                                 |
|  src/services/session.service.ts                 |  The Narrative Arc                              |
|  @@ -14,6 +14,15 @@                             |  In Chapter 1, we introduced the UserSession    |
|   import { CacheClient } from './cache';         |  interface. Here, we implement a resilient      |
|  +export class SessionService {                  |  redis fallback so that auth tokens survive     |
|  +  async getSession(id: string) {               |  cluster restarts.                              |
|  +    const hit = await redis.get(id);           |                                                 |
|  +    if (!hit) return db.fetch(id);    [!] L19  |  Potential Issues & Considerations              |
|  +    return JSON.parse(hit);                    |  * [Warning] L19: JSON.parse on malformed cache |
|  +  }                                            |    could throw UnhandledException. Wrap in      |
|  +}                                              |    try/catch.                                   |
|                                                  |                                                 |
|                                                  |  [Ask AI about this file...]                    |
+--------------------------------------------------+-------------------------------------------------+
|  [< Previous Chapter]              [Mark as Reviewed [x]]                    [Next Chapter >]      |
+----------------------------------------------------------------------------------------------------+
```

---

## ⚡ Key Features

1. **Cognitive Narrative Order**:
   In Git, files are usually sorted alphabetically (`a/...`, `b/...`), forcing you to read random tests or UI components before you even know what the underlying data models changed to. Git Story uses topological sorting and dependency analysis to order files by semantic layers.

2. **AI Provider Flexibility**:
   - **Auto Mode** (Default): Tries VS Code Language Models (`vscode.lm` with GitHub Copilot), then Google Gemini, then local Heuristic.
   - **Google Gemini**: Direct native API integration with `gemini-2.5-flash` or `gemini-2.5-pro`. Fast, ultra-long context, generous free tier.
   - **VS Code Language Model API**: Zero configuration if you already have Copilot or other VS Code LM extensions.
   - **OpenAI / Ollama / Local LLM**: Connect to OpenAI, LM Studio, or local Ollama (`localhost:11434`) for offline privacy.
   - **Heuristic Offline Engine**: High-performance static code analysis, topological ordering, and pattern detection that works 100% offline without any API key or network access.

3. **Distraction-Free Editorial Aesthetics**:
   - Matches VS Code's active theme natively using VS Code CSS variables.
   - Soft tint diff highlighting (no harsh neon blocks).
   - Word-level intra-line highlights.
   - Chapter reading progress bar (`Chapter 3 of 6`).
   - Slide-out Table of Contents (TOC) drawer.

4. **Keyboard-First Workflow**:
   - `[` or `J`: Previous chapter
   - `]` or `K`: Next chapter
   - `T`: Toggle Table of Contents
   - `M`: Toggle "Mark as Reviewed"
   - `R`: Refresh working tree changes

---

## 🚀 Getting Started

1. Click the **`$(book) Review Story`** item in the VS Code status bar (or open the Command Palette `Ctrl+Shift+P` / `Cmd+Shift+P` and type `Git Story: Review Changes with AI Story`).
2. Git Story scans your active Git repository's working tree (staged & unstaged changes).
3. Read through the changes in the two-page book reader.
4. When finished, click **Finish & Commit** to create your commit with an AI-synthesized conventional commit message!

---

## ⚙️ Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `gitStory.aiProvider` | string | `"auto"` | `"auto"`, `"vscode-lm"`, `"gemini"`, `"openai"`, `"ollama"`, or `"heuristic-only"` |
| `gitStory.geminiModel` | string | `"gemini-2.5-flash"` | Gemini model identifier |
| `gitStory.openaiModel` | string | `"gpt-4o-mini"` | OpenAI model identifier |
| `gitStory.openaiBaseUrl` | string | `"https://api.openai.com/v1"` | OpenAI-compatible endpoint |
| `gitStory.ollamaEndpoint` | string | `"http://localhost:11434"` | Local Ollama base URL |
| `gitStory.ollamaModel` | string | `"llama3.2"` | Model to prompt in Ollama |
| `gitStory.diffViewMode` | string | `"split"` | Default diff view (`"split"` or `"unified"`) |
| `gitStory.themeStyle` | string | `"zen"` | Aesthetic style (`"zen"`, `"editorial"`, `"compact"`) |

---

## 🔒 Security & Privacy

- All API keys configured via `Git Story: Configure AI Provider & API Key` are securely encrypted using VS Code's native `SecretStorage`.
- In **Heuristic Only** or **Ollama** mode, no code or diff data ever leaves your computer.
