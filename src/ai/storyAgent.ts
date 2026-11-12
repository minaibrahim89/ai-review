import * as vscode from 'vscode';
import { DiffFile } from '../diff/types';
import { AIProvider, Chapter, StoryNarrative } from './types';
import { HeuristicProvider } from './providers/heuristicProvider';
import { GeminiProvider } from './providers/geminiProvider';
import { VSCodeLMProvider } from './providers/vscodeLmProvider';
import { OpenAIProvider } from './providers/openaiProvider';

export class StoryAgent {
  private heuristicProvider: HeuristicProvider;
  private geminiProvider: GeminiProvider;
  private vscodeLmProvider: VSCodeLMProvider;
  private openaiProvider: OpenAIProvider;
  private ollamaProvider: OpenAIProvider;

  private activeProvider: AIProvider;

  constructor(private context: vscode.ExtensionContext) {
    this.heuristicProvider = new HeuristicProvider();
    this.geminiProvider = new GeminiProvider(context);
    this.vscodeLmProvider = new VSCodeLMProvider();
    this.openaiProvider = new OpenAIProvider(context, false);
    this.ollamaProvider = new OpenAIProvider(context, true);
    this.activeProvider = this.heuristicProvider;
  }

  public async getProvider(): Promise<AIProvider> {
    const config = vscode.workspace.getConfiguration('gitStory');
    const pref = config.get<string>('aiProvider') || 'auto';

    if (pref === 'vscode-lm' && (await this.vscodeLmProvider.isAvailable())) {
      return this.vscodeLmProvider;
    }
    if (pref === 'gemini' && (await this.geminiProvider.isAvailable())) {
      return this.geminiProvider;
    }
    if (pref === 'openai' && (await this.openaiProvider.isAvailable())) {
      return this.openaiProvider;
    }
    if (pref === 'ollama' && (await this.ollamaProvider.isAvailable())) {
      return this.ollamaProvider;
    }
    if (pref === 'heuristic-only') {
      return this.heuristicProvider;
    }

    // Auto strategy:
    // 1. Check Gemini
    if (await this.geminiProvider.isAvailable()) {
      return this.geminiProvider;
    }
    // 2. Check VS Code LM
    if (await this.vscodeLmProvider.isAvailable()) {
      return this.vscodeLmProvider;
    }
    // 3. Check OpenAI
    if (await this.openaiProvider.isAvailable()) {
      return this.openaiProvider;
    }
    // 4. Default to Heuristic
    return this.heuristicProvider;
  }

  public async generateStory(files: DiffFile[], ctx: { repoName: string; branch?: string }): Promise<{ story: StoryNarrative; providerName: string }> {
    const provider = await this.getProvider();
    this.activeProvider = provider;

    try {
      const story = await provider.generateStory(files, ctx);
      return { story, providerName: provider.displayName };
    } catch (err: any) {
      console.warn(`Provider ${provider.displayName} failed: ${err.message}. Falling back to Heuristic Engine.`);
      vscode.window.showInformationMessage(`Git Story: ${provider.displayName} unavailable (${err.message}). Using Heuristic Engine.`);
      this.activeProvider = this.heuristicProvider;
      const story = await this.heuristicProvider.generateStory(files, ctx);
      return { story, providerName: this.heuristicProvider.displayName };
    }
  }

  public async askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string> {
    try {
      return await this.activeProvider.askQuestion(question, chapter, diffSnippet);
    } catch (err: any) {
      return `Failed to query ${this.activeProvider.displayName}: ${err.message}`;
    }
  }
}
