import * as vscode from 'vscode';
import * as path from 'path';
import { DiffFile } from '../diff/types';
import { AIProvider, Chapter, ReviewContext, StoryNarrative, resolveSeverityLevel } from './types';
import { HeuristicProvider } from './providers/heuristicProvider';
import { GeminiProvider } from './providers/geminiProvider';
import { VSCodeLMProvider } from './providers/vscodeLmProvider';
import { OpenAIProvider } from './providers/openaiProvider';
import { computeChangesetHash, computeFileDiffHash, computeFileReviewCacheHash, StoryCache } from './storyCache';
import { OrderedFileNode, OrderingEngine } from './orderingEngine';
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

    if (pref === 'vscode-lm') {
      return this.vscodeLmProvider;
    }
    if (pref === 'gemini') {
      return this.geminiProvider;
    }
    if (pref === 'openai') {
      return this.openaiProvider;
    }
    if (pref === 'ollama') {
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

  private async getCandidateProviders(primary: AIProvider): Promise<AIProvider[]> {
    const config = vscode.workspace.getConfiguration('gitStory');
    const pref = config.get<string>('aiProvider') || 'auto';
    if (pref !== 'auto' || this.getProvider !== StoryAgent.prototype.getProvider) {
      return [primary];
    }

    const candidates: AIProvider[] = [primary];
    for (const fallback of [this.geminiProvider, this.vscodeLmProvider, this.openaiProvider]) {
      if (fallback !== primary && await fallback.isAvailable()) {
        candidates.push(fallback);
      }
    }
    return candidates;
  }

  private async runProviderReview(
    targetProvider: AIProvider,
    filesToAnalyze: DiffFile[],
    ctx: ReviewContext,
    onBatchProgress?: (chaptersSoFar: Chapter[]) => void
  ): Promise<{ story: StoryNarrative; hadHeuristicFill: boolean }> {
    const BATCH_SIZE = 8;
    const orderedFiles = OrderingEngine.orderFiles(filesToAnalyze).map(n => n.file);

    let mergedTitle = '';
    let mergedSynopsis = '';
    let mergedCommitMessage = '';
    let intentionContext: StoryNarrative['intentionContext'];
    const collectedChapters: Chapter[] = [];

    if (orderedFiles.length <= BATCH_SIZE || targetProvider.id === 'heuristic-only') {
      const single = await targetProvider.generateStory(orderedFiles, ctx);
      mergedTitle = single.title;
      mergedSynopsis = single.synopsis;
      mergedCommitMessage = single.suggestedCommitMessage;
      intentionContext = single.intentionContext;
      collectedChapters.push(...(single.chapters || []));
    } else {
      for (let start = 0; start < orderedFiles.length; start += BATCH_SIZE) {
        const batch = orderedFiles.slice(start, start + BATCH_SIZE);
        const batchStory = await targetProvider.generateStory(batch, ctx);
        if (!mergedTitle && batchStory.title) mergedTitle = batchStory.title;
        if (!mergedSynopsis && batchStory.synopsis) mergedSynopsis = batchStory.synopsis;
        if (!mergedCommitMessage && batchStory.suggestedCommitMessage) mergedCommitMessage = batchStory.suggestedCommitMessage;
        if (!intentionContext && batchStory.intentionContext) intentionContext = batchStory.intentionContext;
        collectedChapters.push(...(batchStory.chapters || []));
        onBatchProgress?.(collectedChapters);
      }
    }

    if (collectedChapters.length === 0) {
      throw new Error('AI provider did not return any file reviews.');
    }

    const chapterByPath = new Map<string, Chapter>();
    for (const ch of collectedChapters) {
      if (ch.filePath && !chapterByPath.has(ch.filePath)) {
        chapterByPath.set(ch.filePath, ch);
      }
    }

    let omittedFiles = orderedFiles.filter(f => !chapterByPath.has(f.newPath || f.oldPath));
    if (omittedFiles.length > 0 && omittedFiles.length <= 4) {
      try {
        const retryStory = await targetProvider.generateStory(omittedFiles, ctx);
        for (const ch of retryStory.chapters || []) {
          if (ch.filePath && !chapterByPath.has(ch.filePath)) {
            chapterByPath.set(ch.filePath, ch);
          }
        }
      } catch {
        // Keep partial AI review chapters rather than discarding the entire review
      }
      omittedFiles = orderedFiles.filter(f => !chapterByPath.has(f.newPath || f.oldPath));
    }

    let hadHeuristicFill = false;
    if (omittedFiles.length > 0) {
      hadHeuristicFill = true;
      const fillStory = await this.heuristicProvider.generateStory(omittedFiles, ctx);
      for (const ch of fillStory.chapters) {
        if (!chapterByPath.has(ch.filePath)) {
          chapterByPath.set(ch.filePath, ch);
        }
      }
    }

    return {
      hadHeuristicFill,
      story: {
        title: mergedTitle || 'Review Walkthrough',
        synopsis: mergedSynopsis || '',
        suggestedCommitMessage: mergedCommitMessage || 'feat: update changes',
        chapters: Array.from(chapterByPath.values()),
        intentionContext: intentionContext || (ctx.intention && ctx.intention.sources.length > 0 ? {
          summary: ctx.intention.summary,
          sources: ctx.intention.sources.map(source => source.title),
        } : undefined),
      },
    };
  }

  public async generateStory(
    files: DiffFile[],
    ctx: ReviewContext,
    forceRefresh = false,
    onProgress?: (story: StoryNarrative) => void
  ): Promise<{ story: StoryNarrative; providerName: string; fromCache?: boolean }> {
    if (files.length === 0) {
      return {
        story: {
          title: ctx.comparison ? 'No Differences Between Commits' : 'Working Tree Clean',
          synopsis: ctx.comparison
            ? `No differences found between ${ctx.comparison.base.shortHash} and ${ctx.comparison.target.shortHash}.`
            : 'No uncommitted changes found.',
          chapters: [],
          suggestedCommitMessage: '',
        },
        providerName: 'Git Story',
      };
    }

    const orderedNodes = OrderingEngine.orderFiles(files);
    const createPendingChapter = (index: number, node: OrderedFileNode): Chapter => ({
      index,
      filePath: node.file.newPath || node.file.oldPath,
      title: node.suggestedTitle,
      role: node.role,
      summary: 'AI review in progress.',
      narrative: 'AI review for this file is in progress.',
      keyPoints: [],
      issues: [],
      isReviewed: false,
      isPending: true,
      diffFile: node.file,
    });

    onProgress?.({
      title: ctx.comparison
        ? `Comparing ${ctx.comparison.base.label || ctx.comparison.base.shortHash} ↔ ${ctx.comparison.target.label || ctx.comparison.target.shortHash} (${files.length} File${files.length === 1 ? '' : 's'})`
        : `Reviewing ${files.length} Changed File${files.length === 1 ? '' : 's'}`,
      synopsis: 'File order is ready. AI analysis is in progress.',
      suggestedCommitMessage: '',
      chapters: orderedNodes.map((node, idx) => createPendingChapter(idx + 1, node)),
    });

    // Discover intention context from docs, Copilot Chat, open editors, and Git
    if (!ctx.intention && ctx.repoRoot) {
      try {
        ctx.intention = await IntentionDetector.detectIntention(
          ctx.repoRoot,
          files,
          undefined,
          this.context,
          ctx.comparison,
          ctx.comparisonCommits
        );
      } catch (err) {
        console.warn('[StoryAgent] Error detecting intention:', err);
      }
    }

    // Gather repository defenses and surrounding code context for cross-checking
    if (!ctx.repoDefenses && ctx.repoRoot) {
      try {
        ctx.repoDefenses = RepoCrossChecker.gatherRepoDefenses(ctx.repoRoot, files, ctx.targetFileContents);
      } catch (err) {
        console.warn('[StoryAgent] Error gathering repo defenses:', err);
      }
    }

    const provider = await this.getProvider();
    this.activeProvider = provider;
    const modelName = this.getModelName(provider);
    const cacheScope = ctx.comparison
      ? `${ctx.comparison.base.hash}->${ctx.comparison.target.hash}:${ctx.intention?.summary || ''}`
      : (ctx.intention?.summary || '');

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
      cacheScope
    );
    const createFileCacheHashes = (providerName: string, cacheModelName: string) => fileHashes.map(fileHash => ({
      filePath: fileHash.filePath,
      fileHash: computeFileReviewCacheHash(
        fileHash.filePath,
        fileHash.fileHash,
        providerName,
        cacheModelName,
        cacheScope
      ),
    }));
    const fileCacheHashes = createFileCacheHashes(provider.displayName, modelName);

    // 1. Check Full Changeset Cache
    if (!forceRefresh) {
      const cachedStory = this.cache.getChangeset(changesetHash);
      if (cachedStory && cachedStory.providerName === provider.displayName) {
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
    }

    const cachedChapters = new Map<string, Chapter>();
    const filesToAnalyze: DiffFile[] = [];
    for (let idx = 0; idx < fileHashes.length; idx++) {
      const fileHash = fileHashes[idx];
      const cached = !forceRefresh ? this.cache.getFileChapter(fileCacheHashes[idx].fileHash) : undefined;
      if (!cached) {
        filesToAnalyze.push(fileHash.file);
        continue;
      }

      cachedChapters.set(fileHash.filePath, {
        index: 0,
        filePath: cached.filePath,
        title: cached.title,
        role: cached.role,
        summary: cached.summary,
        narrative: cached.narrative,
        keyPoints: cached.keyPoints || [],
        issues: (cached.issues || []).map(issue => ({
          ...issue,
          severityLevel: resolveSeverityLevel(issue),
        })),
        isReviewed: false,
        diffFile: fileHash.file,
      });
    }

    const buildStory = (generatedStory?: StoryNarrative): StoryNarrative => {
      const generatedChapters = new Map(
        (generatedStory?.chapters || []).map(chapter => [chapter.filePath, chapter])
      );
      const chapters = orderedNodes.map((node, idx) => {
        const filePath = node.file.newPath || node.file.oldPath;
        const cached = cachedChapters.get(filePath);
        if (cached) {
          return { ...cached, index: idx + 1, diffFile: node.file };
        }

        const generated = generatedChapters.get(filePath);
        if (generated) {
          return { ...generated, index: idx + 1, isPending: false, diffFile: node.file };
        }

        return createPendingChapter(idx + 1, node);
      });
      const cachedCount = cachedChapters.size;

      return {
        title: generatedStory?.title ||
          (chapters.length === 1 ? `Review: ${chapters[0].title}` : `Review of ${chapters.length} Changed Files`),
        synopsis: generatedStory
          ? cachedCount > 0
            ? `${generatedStory.synopsis}\n\nReused AI analysis for ${cachedCount} unchanged file(s).`
            : generatedStory.synopsis
          : `Structured review sequence covering ${chapters.length} file(s) with cached AI technical analysis.`,
        suggestedCommitMessage: generatedStory?.suggestedCommitMessage ||
          `refactor: update ${chapters.map(chapter => path.basename(chapter.filePath)).join(', ')}`,
        chapters,
        intentionContext: generatedStory?.intentionContext || (ctx.intention && ctx.intention.sources.length > 0 ? {
          summary: ctx.intention.summary,
          sources: ctx.intention.sources.map(source => source.title),
        } : undefined),
      };
    };

    if (filesToAnalyze.length === 0) {
      const story = buildStory();
      this.cache.setChangeset(changesetHash, story, provider.displayName, fileCacheHashes);
      console.log(`[StoryAgent] All ${fileHashes.length} files hit individual chapter cache. Reusing AI review.`);
      return { story, providerName: `${provider.displayName} (Cached)`, fromCache: true };
    }

    if (cachedChapters.size > 0) {
      onProgress?.(buildStory());
      console.log(`[StoryAgent] Reusing ${cachedChapters.size} cached file review(s); analyzing ${filesToAnalyze.length} changed file(s).`);
    }

    // Analyze only files without a reusable file-level result.
    const candidates = await this.getCandidateProviders(provider);
    let lastError: Error | undefined;

    for (const candidate of candidates) {
      try {
        this.activeProvider = candidate;
        const { story: generatedStory, hadHeuristicFill } = await this.runProviderReview(
          candidate,
          filesToAnalyze,
          ctx,
          partialChapters => {
            onProgress?.(buildStory({
              title: 'Review in Progress',
              synopsis: 'AI analysis is in progress.',
              suggestedCommitMessage: '',
              chapters: partialChapters,
            }));
          }
        );

        // Cross-check and prune any issues already addressed in the repository
        RepoCrossChecker.verifyStoryIssues(generatedStory, filesToAnalyze, ctx.repoRoot, ctx.targetFileContents);

        // Ensure all issues have severityLevel normalized
        for (const ch of generatedStory.chapters) {
          ch.issues = (ch.issues || []).map(iss => ({
            ...iss,
            severityLevel: resolveSeverityLevel(iss),
          }));
        }

        const story = buildStory(generatedStory);
        const candidateModel = this.getModelName(candidate);
        const candidateChangesetHash = candidate === provider
          ? changesetHash
          : computeChangesetHash(fileHashes, candidate.displayName, candidateModel, cacheScope);
        const candidateFileHashes = candidate === provider
          ? fileCacheHashes
          : createFileCacheHashes(candidate.displayName, candidateModel);

        if (!hadHeuristicFill) {
          this.cache.setChangeset(candidateChangesetHash, story, candidate.displayName, candidateFileHashes);
        }

        return { story, providerName: candidate.displayName, fromCache: false };
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`Provider ${candidate.displayName} failed: ${lastError.message}.`);
      }
    }

    const failMsg = lastError ? lastError.message : 'AI provider unavailable';
    console.warn(`All AI providers failed (${failMsg}). Falling back to Heuristic Engine.`);
    vscode.window.showInformationMessage(`Git Story: ${provider.displayName} unavailable (${failMsg}). Using Heuristic Engine.`);
    this.activeProvider = this.heuristicProvider;
    const generatedStory = await this.heuristicProvider.generateStory(filesToAnalyze, ctx);
    if (!generatedStory.intentionContext && ctx.intention && ctx.intention.sources.length > 0) {
      generatedStory.intentionContext = {
        summary: ctx.intention.summary,
        sources: ctx.intention.sources.map(source => source.title),
      };
    }

    // Cross-check and prune any issues already addressed in the repository
    RepoCrossChecker.verifyStoryIssues(generatedStory, filesToAnalyze, ctx.repoRoot, ctx.targetFileContents);

    // Ensure all issues have severityLevel normalized
    for (const ch of generatedStory.chapters) {
      ch.issues = (ch.issues || []).map(iss => ({
        ...iss,
        severityLevel: resolveSeverityLevel(iss),
      }));
    }

    const story = buildStory(generatedStory);
    // Keep fallback results temporary so the selected provider is retried on refresh.
    return { story, providerName: this.heuristicProvider.displayName, fromCache: false };
  }

  public async askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string> {
    try {
      return await this.activeProvider.askQuestion(question, chapter, diffSnippet);
    } catch (err: any) {
      return `Failed to query ${this.activeProvider.displayName}: ${err.message}`;
    }
  }
}
