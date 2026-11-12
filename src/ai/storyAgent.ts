import * as vscode from 'vscode';
import * as path from 'path';
import { DiffFile } from '../diff/types';
import { AIProvider, Chapter, ReviewContext, StoryNarrative, resolveSeverityLevel } from './types';
import { HeuristicProvider } from './providers/heuristicProvider';
import { GeminiProvider } from './providers/geminiProvider';
import { VSCodeLMProvider } from './providers/vscodeLmProvider';
import { OpenAIProvider } from './providers/openaiProvider';
import { computeChangesetHash, computeFileDiffHash, StoryCache } from './storyCache';
import { OrderingEngine } from './orderingEngine';
import { IntentionDetector } from './intentionContext';
import { RepoCrossChecker } from './repoCrossCheck';

export class StoryAgent {
  private heuristicProvider: HeuristicProvider;
  private geminiProvider: GeminiProvider;
  private vscodeLmProvider: VSCodeLMProvider;
  private openaiProvider: OpenAIProvider;
  private ollamaProvider: OpenAIProvider;
  private cache: StoryCache;

  private activeProvider: AIProvider;

  constructor(private context: vscode.ExtensionContext) {
    this.cache = new StoryCache(context);
    this.heuristicProvider = new HeuristicProvider();
    this.geminiProvider = new GeminiProvider(context);
    this.vscodeLmProvider = new VSCodeLMProvider();
    this.openaiProvider = new OpenAIProvider(context, false);
    this.ollamaProvider = new OpenAIProvider(context, true);
    this.activeProvider = this.heuristicProvider;
  }

  public getCache(): StoryCache {
    return this.cache;
  }

  public clearCache(): void {
    this.cache.clear();
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

  private getModelName(provider: AIProvider): string {
    const config = vscode.workspace.getConfiguration('gitStory');
    if (provider.id === 'gemini') {
      return config.get<string>('geminiModel') || 'gemini-3.8-flash';
    }
    if (provider.id === 'openai') {
      return config.get<string>('openaiModel') || 'gpt-6-luna';
    }
    if (provider.id === 'ollama') {
      return config.get<string>('ollamaModel') || 'llama3.2';
    }
    return provider.id;
  }

  public async generateStory(
    files: DiffFile[],
    ctx: ReviewContext,
    forceRefresh = false
  ): Promise<{ story: StoryNarrative; providerName: string; fromCache?: boolean }> {
    if (files.length === 0) {
      return {
        story: {
          title: 'Working Tree Clean',
          synopsis: 'No uncommitted changes found.',
          chapters: [],
          suggestedCommitMessage: '',
        },
        providerName: 'Git Story',
      };
    }

    // Discover intention context from docs, Copilot Chat, open editors, and Git
    if (!ctx.intention && ctx.repoRoot) {
      try {
        ctx.intention = await IntentionDetector.detectIntention(ctx.repoRoot, files, undefined, this.context);
      } catch (err) {
        console.warn('[StoryAgent] Error detecting intention:', err);
      }
    }

    // Gather repository defenses and surrounding code context for cross-checking
    if (!ctx.repoDefenses && ctx.repoRoot) {
      try {
        ctx.repoDefenses = RepoCrossChecker.gatherRepoDefenses(ctx.repoRoot, files);
      } catch (err) {
        console.warn('[StoryAgent] Error gathering repo defenses:', err);
      }
    }

    const provider = await this.getProvider();
    this.activeProvider = provider;
    const modelName = this.getModelName(provider);

    // Compute diff hashes for all files
    const fileHashes: { file: DiffFile; filePath: string; fileHash: string }[] = files.map(f => {
      const p = f.newPath || f.oldPath;
      return {
        file: f,
        filePath: p,
        fileHash: computeFileDiffHash(p, f.hunks),
      };
    });

    const changesetHash = computeChangesetHash(
      fileHashes,
      provider.displayName,
      modelName,
      ctx.intention?.summary || ''
    );

    // 1. Check Full Changeset Cache
    if (!forceRefresh) {
      const cachedStory = this.cache.getChangeset(changesetHash);
      if (cachedStory) {
        console.log(`[StoryAgent] Changeset cache hit (${changesetHash.slice(0, 8)}). Reusing AI review.`);
        const restoredStory: StoryNarrative = {
          title: cachedStory.title,
          synopsis: cachedStory.synopsis,
          suggestedCommitMessage: cachedStory.suggestedCommitMessage,
          intentionContext: cachedStory.intentionContext || (ctx.intention && ctx.intention.sources.length > 0 ? {
            summary: ctx.intention.summary,
            sources: ctx.intention.sources.map(s => s.title),
          } : undefined),
          chapters: cachedStory.chapters.map((c, idx) => {
            const matching = files.find(f => (f.newPath || f.oldPath) === c.filePath);
            return {
              index: idx + 1,
              filePath: c.filePath,
              title: c.title,
              role: c.role,
              summary: c.summary,
              narrative: c.narrative,
              keyPoints: c.keyPoints || [],
              issues: (c.issues || []).map(iss => ({
                ...iss,
                severityLevel: resolveSeverityLevel(iss),
              })),
              isReviewed: false,
              diffFile: matching,
            };
          }),
        };
        return { story: restoredStory, providerName: `${cachedStory.providerName} (Cached)`, fromCache: true };
      }

      // 2. Check File-Level Cache (e.g. when scope is switched to staged/unstaged subset)
      const allFilesCached = fileHashes.every(fh => !!this.cache.getFileChapter(fh.fileHash));
      if (allFilesCached && fileHashes.length > 0) {
        console.log(`[StoryAgent] All ${fileHashes.length} files hit individual chapter cache. Reusing AI review.`);
        const orderedNodes = OrderingEngine.orderFiles(files);
        const chapters: Chapter[] = orderedNodes.map((n, idx) => {
          const p = n.file.newPath || n.file.oldPath;
          const fh = fileHashes.find(item => item.filePath === p)!;
          const cachedCh = this.cache.getFileChapter(fh.fileHash)!;
          return {
            index: idx + 1,
            filePath: p,
            title: cachedCh.title,
            role: cachedCh.role,
            summary: cachedCh.summary,
            narrative: cachedCh.narrative,
            keyPoints: cachedCh.keyPoints || [],
            issues: (cachedCh.issues || []).map(iss => ({
              ...iss,
              severityLevel: resolveSeverityLevel(iss),
            })),
            isReviewed: false,
            diffFile: n.file,
          };
        });

        const story: StoryNarrative = {
          title: chapters.length === 1 ? `Review: ${chapters[0].title}` : `Review of ${chapters.length} Changed Files`,
          synopsis: `Structured review sequence covering ${chapters.length} file(s) with cached AI technical analysis.`,
          suggestedCommitMessage: `refactor: update ${chapters.map(c => path.basename(c.filePath)).join(', ')}`,
          chapters,
          intentionContext: ctx.intention && ctx.intention.sources.length > 0 ? {
            summary: ctx.intention.summary,
            sources: ctx.intention.sources.map(s => s.title),
          } : undefined,
        };

        // Also record this subset as a valid changeset cache
        this.cache.setChangeset(changesetHash, story, provider.displayName, fileHashes);

        return { story, providerName: `${provider.displayName} (Cached)`, fromCache: true };
      }
    }

    // 3. Cache Miss: Query the active AI Provider
    try {
      const story = await provider.generateStory(files, ctx);
      if (!story.intentionContext && ctx.intention && ctx.intention.sources.length > 0) {
        story.intentionContext = {
          summary: ctx.intention.summary,
          sources: ctx.intention.sources.map(s => s.title),
        };
      }

      // Cross-check and prune any issues already addressed in the repository
      RepoCrossChecker.verifyStoryIssues(story, files, ctx.repoRoot);

      // Ensure all issues have severityLevel normalized
      for (const ch of story.chapters) {
        ch.issues = (ch.issues || []).map(iss => ({
          ...iss,
          severityLevel: resolveSeverityLevel(iss),
        }));
      }

      // Save to cache
      this.cache.setChangeset(changesetHash, story, provider.displayName, fileHashes);

      return { story, providerName: provider.displayName, fromCache: false };
    } catch (err: any) {
      console.warn(`Provider ${provider.displayName} failed: ${err.message}. Falling back to Heuristic Engine.`);
      vscode.window.showInformationMessage(`Git Story: ${provider.displayName} unavailable (${err.message}). Using Heuristic Engine.`);
      this.activeProvider = this.heuristicProvider;
      const story = await this.heuristicProvider.generateStory(files, ctx);
      if (!story.intentionContext && ctx.intention && ctx.intention.sources.length > 0) {
        story.intentionContext = {
          summary: ctx.intention.summary,
          sources: ctx.intention.sources.map(s => s.title),
        };
      }

      // Cross-check and prune any issues already addressed in the repository
      RepoCrossChecker.verifyStoryIssues(story, files, ctx.repoRoot);

      // Ensure all issues have severityLevel normalized
      for (const ch of story.chapters) {
        ch.issues = (ch.issues || []).map(iss => ({
          ...iss,
          severityLevel: resolveSeverityLevel(iss),
        }));
      }

      // Save heuristic result to cache as well
      this.cache.setChangeset(changesetHash, story, this.heuristicProvider.displayName, fileHashes);

      return { story, providerName: this.heuristicProvider.displayName, fromCache: false };
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
