import { CommitComparison, CommitRef, DiffScope, GitBranchInfo, GitRepoInfo } from '../../git/types';
import { Chapter, IssueCallout, StoryNarrative, resolveSeverityLevel } from '../../ai/types';
import { ExtensionMessageToWebview, WebviewMessageToExtension } from '../types';
import { escapeHtml, formatInlineMarkdown, formatMarkdown } from '../markdown';

// Acquire VS Code API
declare function acquireVsCodeApi(): {
  postMessage: (message: WebviewMessageToExtension) => void;
  getState: () => any;
  setState: (state: any) => void;
};

const vscode = acquireVsCodeApi();

interface AppState {
  story?: StoryNarrative;
  lastCompletedStory?: StoryNarrative;
  lastCompletedProviderName?: string;
  currentChapterIndex: number;
  currentRepo?: GitRepoInfo;
  repos: GitRepoInfo[];
  scope: DiffScope;
  lastWorkingScope: Exclude<DiffScope, 'commits'>;
  comparison?: CommitComparison;
  commits: CommitRef[];
  branches: GitBranchInfo[];
  compareMode: 'branches' | 'commits';
  defaultCompareBase?: string;
  defaultCompareTarget?: string;
  isCompareSubmitting: boolean;
  providerName: string;
  themeStyle: 'zen' | 'editorial' | 'compact';
}

const state: AppState = {
  currentChapterIndex: 0,
  repos: [],
  scope: 'all',
  lastWorkingScope: 'all',
  commits: [],
  branches: [],
  compareMode: 'branches',
  isCompareSubmitting: false,
  providerName: 'Heuristic',
  themeStyle: 'zen',
};

// DOM Elements cache
const elements = {
  // Header
  storyTitle: document.getElementById('story-title') as HTMLElement,
  repoBranch: document.getElementById('repo-branch') as HTMLElement,
  chapterCounter: document.getElementById('chapter-counter') as HTMLElement,
  progressBarFill: document.getElementById('progress-bar-fill') as HTMLElement,
  scopeSelect: document.getElementById('scope-select') as HTMLSelectElement,
  compareCommitsBtn: document.getElementById('compare-commits-btn') as HTMLButtonElement,
  compareBar: document.getElementById('compare-bar') as HTMLElement,
  compareBaseBadge: document.getElementById('compare-base-badge') as HTMLElement,
  compareTargetBadge: document.getElementById('compare-target-badge') as HTMLElement,
  swapCommitsBtn: document.getElementById('swap-commits-btn') as HTMLButtonElement,
  changeCommitsBtn: document.getElementById('change-commits-btn') as HTMLButtonElement,
  themeSelect: document.getElementById('theme-select') as HTMLSelectElement,
  openDiffBtn: document.getElementById('open-diff-btn') as HTMLButtonElement,
  refreshBtn: document.getElementById('refresh-btn') as HTMLButtonElement,
  tocBtn: document.getElementById('toc-btn') as HTMLButtonElement,
  closeTocBtn: document.getElementById('close-toc-btn') as HTMLButtonElement,
  tocDrawer: document.getElementById('toc-drawer') as HTMLElement,
  drawerBackdrop: document.getElementById('drawer-backdrop') as HTMLElement,
  tocList: document.getElementById('toc-list') as HTMLElement,
  synopsisToggleBtn: document.getElementById('synopsis-toggle-btn') as HTMLButtonElement,
  synopsisModal: document.getElementById('synopsis-modal') as HTMLElement,
  closeSynopsisBtn: document.getElementById('close-synopsis-btn') as HTMLButtonElement,
  synopsisText: document.getElementById('synopsis-text') as HTMLElement,

  // Main Walkthrough Viewport
  walkthroughViewport: document.getElementById('walkthrough-viewport') as HTMLElement,
  branchSummaryCard: document.getElementById('branch-summary-card') as HTMLElement,
  branchSummaryRange: document.getElementById('branch-summary-range') as HTMLElement,
  branchSummaryPurpose: document.getElementById('branch-summary-purpose') as HTMLElement,
  branchSummaryArchitecture: document.getElementById('branch-summary-architecture') as HTMLElement,
  branchSummaryIssues: document.getElementById('branch-summary-issues') as HTMLElement,

  // File Card
  fileStatusBadge: document.getElementById('file-status-badge') as HTMLElement,
  filePath: document.getElementById('file-path') as HTMLElement,
  fileDiffStats: document.getElementById('file-diff-stats') as HTMLElement,
  stageFileBtn: document.getElementById('stage-file-btn') as HTMLButtonElement,
  openEditorBtn: document.getElementById('open-editor-btn') as HTMLButtonElement,

  // Step Narrative Card
  chapterRoleBadge: document.getElementById('chapter-role-badge') as HTMLElement,
  aiProviderBadge: document.getElementById('ai-provider-badge') as HTMLElement,
  intentionBanner: document.getElementById('intention-banner') as HTMLElement,
  intentionSourcesTag: document.getElementById('intention-sources-tag') as HTMLElement,
  intentionSummaryText: document.getElementById('intention-summary-text') as HTMLElement,
  chapterTitle: document.getElementById('chapter-title') as HTMLElement,
  chapterNarrative: document.getElementById('chapter-narrative') as HTMLElement,

  // Highlights & Issues
  keyPointsList: document.getElementById('key-points-list') as HTMLElement,
  issuesList: document.getElementById('issues-list') as HTMLElement,

  // Ask AI
  askAiInput: document.getElementById('ask-ai-input') as HTMLInputElement,
  askAiSubmitBtn: document.getElementById('ask-ai-submit-btn') as HTMLButtonElement,
  askAiConversation: document.getElementById('ask-ai-conversation') as HTMLElement,

  // Footer
  prevChapterBtn: document.getElementById('prev-chapter-btn') as HTMLButtonElement,
  nextChapterBtn: document.getElementById('next-chapter-btn') as HTMLButtonElement,
  markReviewedBtn: document.getElementById('mark-reviewed-btn') as HTMLButtonElement,
  finishCommitBtn: document.getElementById('finish-commit-btn') as HTMLButtonElement,

  // Commit Modal
  commitModal: document.getElementById('commit-modal') as HTMLElement,
  closeCommitBtn: document.getElementById('close-commit-btn') as HTMLButtonElement,
  cancelCommitBtn: document.getElementById('cancel-commit-btn') as HTMLButtonElement,
  executeCommitBtn: document.getElementById('execute-commit-btn') as HTMLButtonElement,
  commitMessageInput: document.getElementById('commit-message-input') as HTMLTextAreaElement,

  // Compare Branches / Commits Dialog
  compareModal: document.getElementById('compare-modal') as HTMLDialogElement,
  closeCompareBtn: document.getElementById('close-compare-btn') as HTMLButtonElement,
  cancelCompareBtn: document.getElementById('cancel-compare-btn') as HTMLButtonElement,
  compareForm: document.getElementById('compare-form') as HTMLFormElement,
  compareModeBranches: document.getElementById('compare-mode-branches') as HTMLInputElement,
  compareModeCommits: document.getElementById('compare-mode-commits') as HTMLInputElement,
  baseCommitLabel: document.getElementById('base-commit-label') as HTMLLabelElement,
  targetCommitLabel: document.getElementById('target-commit-label') as HTMLLabelElement,
  baseCommitSelect: document.getElementById('base-commit-select') as HTMLSelectElement,
  baseCommitInput: document.getElementById('base-commit-input') as HTMLInputElement,
  targetCommitSelect: document.getElementById('target-commit-select') as HTMLSelectElement,
  targetCommitInput: document.getElementById('target-commit-input') as HTMLInputElement,
  modalSwapCommitsBtn: document.getElementById('modal-swap-commits-btn') as HTMLButtonElement,
  compareErrorMsg: document.getElementById('compare-error-msg') as HTMLElement,
  executeCompareBtn: document.getElementById('execute-compare-btn') as HTMLButtonElement,

  // Loading
  loadingOverlay: document.getElementById('loading-overlay') as HTMLElement,
  loadingMessage: document.getElementById('loading-message') as HTMLElement,
  cancelReviewBtn: document.getElementById('cancel-review-btn') as HTMLButtonElement,
};

function init() {
  window.addEventListener('message', handleExtensionMessage);

  elements.refreshBtn.addEventListener('click', () => {
    showLoading('Refreshing review changes...');
    vscode.postMessage({ type: 'refresh' });
  });

  elements.cancelReviewBtn.addEventListener('click', requestCancelReview);

  elements.openDiffBtn.addEventListener('click', () => {
    const chapter = getCurrentChapter();
    if (chapter) {
      vscode.postMessage({ type: 'openDiffEditor', filePath: chapter.filePath });
    }
  });

  elements.scopeSelect.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    if (val === 'branches') {
      openCompareModal('branches');
      return;
    }
    if (val === 'commits') {
      openCompareModal('commits');
      return;
    }
    const scope = val as Exclude<DiffScope, 'commits'>;
    state.lastWorkingScope = scope;
    state.scope = scope;
    state.comparison = undefined;
    showLoading(`Filtering changes (${scope})...`);
    vscode.postMessage({ type: 'changeScope', scope });
  });

  elements.compareCommitsBtn.addEventListener('click', () => openCompareModal());
  elements.changeCommitsBtn.addEventListener('click', () => openCompareModal());
  elements.compareModeBranches.addEventListener('change', () => {
    if (elements.compareModeBranches.checked) {
      setCompareMode('branches', true);
    }
  });
  elements.compareModeCommits.addEventListener('change', () => {
    if (elements.compareModeCommits.checked) {
      setCompareMode('commits', true);
    }
  });
  elements.swapCommitsBtn.addEventListener('click', () => {
    if (state.comparison) {
      showLoading('Swapping compared commits...');
      vscode.postMessage({ type: 'swapCompareCommits' });
    }
  });

  elements.closeCompareBtn.addEventListener('click', closeCompareModal);
  elements.cancelCompareBtn.addEventListener('click', closeCompareModal);
  elements.modalSwapCommitsBtn.addEventListener('click', () => {
    const prevBase = elements.baseCommitInput.value;
    elements.baseCommitInput.value = elements.targetCommitInput.value;
    elements.targetCommitInput.value = prevBase;
    syncSelectToInput(elements.baseCommitSelect, elements.baseCommitInput.value);
    syncSelectToInput(elements.targetCommitSelect, elements.targetCommitInput.value);
    clearCompareError();
  });

  elements.baseCommitSelect.addEventListener('change', () => {
    if (elements.baseCommitSelect.value) {
      elements.baseCommitInput.value = elements.baseCommitSelect.value;
      clearCompareError();
    }
  });

  elements.targetCommitSelect.addEventListener('change', () => {
    if (elements.targetCommitSelect.value) {
      elements.targetCommitInput.value = elements.targetCommitSelect.value;
      clearCompareError();
    }
  });

  elements.baseCommitInput.addEventListener('input', () => {
    clearCompareError('base');
    syncSelectToInput(elements.baseCommitSelect, elements.baseCommitInput.value);
  });

  elements.targetCommitInput.addEventListener('input', () => {
    clearCompareError('target');
    syncSelectToInput(elements.targetCommitSelect, elements.targetCommitInput.value);
  });

  elements.compareForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.isCompareSubmitting) return;

    const baseRef = elements.baseCommitInput.value.trim();
    const targetRef = elements.targetCommitInput.value.trim();

    if (!baseRef && !targetRef) {
      setCompareError('Enter both a base commit and a target commit.', 'both');
      return;
    }
    if (!baseRef) {
      setCompareError('Enter a base commit reference or SHA.', 'base');
      return;
    }
    if (!targetRef) {
      setCompareError('Enter a target commit reference or SHA.', 'target');
      return;
    }

    clearCompareError();
    state.isCompareSubmitting = true;
    elements.executeCompareBtn.disabled = true;
    elements.executeCompareBtn.textContent = 'Comparing...';
    vscode.postMessage({ type: 'compareCommits', baseRef, targetRef });
  });

  elements.compareModal.addEventListener('close', () => {
    if ('returnValue' in elements.compareModal) {
      elements.compareModal.returnValue = '';
    }
    resetCompareSubmitState();
    elements.scopeSelect.value = state.scope;
  });

  if (typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = elements.compareModal.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    elements.compareModal.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutside(e);
    });
    elements.compareModal.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutside(e)) {
        closeCompareModal();
      }
    });
  }

  elements.themeSelect.addEventListener('change', (e) => {
    const theme = (e.target as HTMLSelectElement).value as 'zen' | 'editorial' | 'compact';
    setThemeStyle(theme);
    vscode.postMessage({ type: 'changeTheme', themeStyle: theme });
  });

  // TOC drawer toggle
  elements.tocBtn.addEventListener('click', toggleToc);
  elements.closeTocBtn.addEventListener('click', toggleToc);
  elements.drawerBackdrop.addEventListener('click', toggleToc);

  // Step Navigation
  elements.prevChapterBtn.addEventListener('click', goToPrevChapter);
  elements.nextChapterBtn.addEventListener('click', goToNextChapter);
  elements.markReviewedBtn.addEventListener('click', () => {
    const chapter = getCurrentChapter();
    if (chapter) {
      chapter.isReviewed = true;
      renderToc();
      updateProgressBar();
      vscode.postMessage({
        type: 'markReviewed',
        chapterIndex: state.currentChapterIndex,
        isReviewed: true,
      });
      goToNextChapter();
    }
  });
  elements.finishCommitBtn.addEventListener('click', openCommitModal);

  // Stage button
  elements.stageFileBtn.addEventListener('click', () => {
    const chapter = getCurrentChapter();
    if (chapter) {
      const isCurrentlyStaged = chapter.diffFile?.status !== 'untracked' && elements.stageFileBtn.textContent === 'Unstage';
      if (isCurrentlyStaged) {
        vscode.postMessage({ type: 'unstageFile', filePath: chapter.filePath });
        elements.stageFileBtn.textContent = 'Stage';
      } else {
        vscode.postMessage({ type: 'stageFile', filePath: chapter.filePath });
        elements.stageFileBtn.textContent = 'Unstage';
      }
    }
  });

  // Open in editor button
  elements.openEditorBtn.addEventListener('click', () => {
    const chapter = getCurrentChapter();
    if (chapter) {
      vscode.postMessage({ type: 'openFileInEditor', filePath: chapter.filePath });
    }
  });

  // Synopsis modal
  elements.synopsisToggleBtn.addEventListener('click', openSynopsisModal);
  elements.closeSynopsisBtn.addEventListener('click', closeSynopsisModal);

  // Commit modal
  elements.closeCommitBtn.addEventListener('click', closeCommitModal);
  elements.cancelCommitBtn.addEventListener('click', closeCommitModal);
  elements.executeCommitBtn.addEventListener('click', () => {
    const msg = elements.commitMessageInput.value.trim();
    if (msg) {
      showLoading('Executing git commit...', false);
      vscode.postMessage({ type: 'commit', message: msg });
      closeCommitModal();
    }
  });

  // Ask AI
  elements.askAiSubmitBtn.addEventListener('click', submitQuestion);
  elements.askAiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submitQuestion();
    }
  });

  // Keyboard navigation shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && elements.loadingOverlay.classList.contains('open') && !elements.cancelReviewBtn.hidden) {
      requestCancelReview();
      return;
    }

    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLButtonElement
    ) {
      return;
    }

    if (e.key === ']' || e.key === 'j' || e.key === 'ArrowRight') {
      goToNextChapter();
    } else if (e.key === '[' || e.key === 'k' || e.key === 'ArrowLeft') {
      goToPrevChapter();
    } else if (e.key === 't' || e.key === 'T') {
      toggleToc();
    } else if (e.key === 'r' || e.key === 'R') {
      vscode.postMessage({ type: 'refresh' });
    } else if (e.key === ' ') {
      e.preventDefault();
      elements.markReviewedBtn.click();
    }
  });

  // Signal ready to extension
  vscode.postMessage({ type: 'ready' });
}

function handleExtensionMessage(event: MessageEvent<ExtensionMessageToWebview>) {
  const message = event.data;

  switch (message.type) {
    case 'init': {
      state.story = message.payload.story;
      state.providerName = message.payload.providerName;
      state.currentRepo = message.payload.currentRepo;
      state.repos = message.payload.repos;
      state.scope = message.payload.scope;
      if (message.payload.scope !== 'commits') {
        state.lastWorkingScope = message.payload.scope;
      }
      state.comparison = message.payload.comparison;
      state.currentChapterIndex = 0;

      if (message.payload.themeStyle) {
        setThemeStyle(message.payload.themeStyle as any);
      }

      elements.scopeSelect.value = state.scope;
      closeCompareModal();
      if (!state.story?.chapters.some(ch => ch.isPending)) {
        state.lastCompletedStory = state.story;
        state.lastCompletedProviderName = state.providerName;
      }
      renderStory();
      break;
    }

    case 'updateStory': {
      state.story = message.payload.story;
      if (message.payload.providerName) {
        state.providerName = message.payload.providerName;
      }
      if (message.payload.scope) {
        state.scope = message.payload.scope;
        elements.scopeSelect.value = state.scope;
      }
      if ('comparison' in message.payload) {
        state.comparison = message.payload.comparison;
      }
      closeCompareModal();
      if (!state.story?.chapters.some(ch => ch.isPending)) {
        state.lastCompletedStory = state.story;
        state.lastCompletedProviderName = state.providerName;
      }
      renderStory();
      break;
    }

    case 'commitsList': {
      state.commits = message.payload.commits || [];
      state.branches = message.payload.branches || [];
      state.defaultCompareBase = message.payload.currentBase;
      state.defaultCompareTarget = message.payload.currentTarget;
      populateCompareSelectors(true);
      break;
    }

    case 'compareError': {
      resetCompareSubmitState();
      setCompareError(message.payload.message, message.payload.invalidField);
      break;
    }

    case 'setChapter': {
      state.currentChapterIndex = message.payload.chapterIndex;
      renderChapter();
      renderToc();
      updateProgressBar();
      break;
    }

    case 'setTheme': {
      setThemeStyle(message.payload.themeStyle);
      break;
    }

    case 'answer': {
      appendAiAnswer(message.payload.question, message.payload.answer);
      break;
    }

    case 'loading': {
      showLoading(message.payload.message);
      break;
    }

    case 'reviewCancelled': {
      hideLoading();
      if (!state.story || state.story.chapters.some(ch => ch.isPending)) {
        if (state.lastCompletedStory) {
          state.story = state.lastCompletedStory;
          state.providerName = state.lastCompletedProviderName || state.providerName;
          renderStory();
        } else {
          renderCancelledState(message.payload.message);
        }
      }
      break;
    }

    case 'fileStagedStatus': {
      const current = getCurrentChapter();
      if (current && current.filePath === message.payload.filePath) {
        elements.stageFileBtn.textContent = message.payload.isStaged ? 'Unstage' : 'Stage';
      }
      break;
    }

    case 'commitSuccess': {
      hideLoading();
      vscode.postMessage({ type: 'refresh' });
      break;
    }

    case 'error': {
      hideLoading();
      alert(`Git Story Notice: ${message.payload.message}`);
      break;
    }
  }
}

function getCurrentChapter(): Chapter | undefined {
  if (!state.story || !state.story.chapters) return undefined;
  return state.story.chapters[state.currentChapterIndex];
}

function formatCompareRefShort(ref: CommitRef): string {
  return ref.label || ref.shortHash;
}

function formatCompareRefPill(ref: CommitRef): string {
  return ref.label ? `${ref.label} (${ref.shortHash})` : ref.shortHash;
}

function updateComparisonHeader() {
  if (state.scope === 'commits' && state.comparison) {
    const { base, target } = state.comparison;
    const baseShort = formatCompareRefShort(base);
    const targetShort = formatCompareRefShort(target);
    elements.compareBar.hidden = false;
    elements.compareBaseBadge.textContent = `${formatCompareRefPill(base)}: ${base.subject}`;
    elements.compareBaseBadge.title = `${base.hash} — ${base.subject}`;
    elements.compareTargetBadge.textContent = `${formatCompareRefPill(target)}: ${target.subject}`;
    elements.compareTargetBadge.title = `${target.hash} — ${target.subject}`;
    elements.repoBranch.textContent = `${baseShort} ↔ ${targetShort}`;
    elements.repoBranch.title = `Comparing ${formatCompareRefPill(base)} (${base.subject}) → ${formatCompareRefPill(target)} (${target.subject})`;
  } else {
    elements.compareBar.hidden = true;
    elements.repoBranch.textContent = state.currentRepo?.headBranch || 'main';
    elements.repoBranch.title = '';
  }
}

function renderBranchSummary() {
  const summary = state.story?.changeSummary;
  if (state.scope !== 'commits' || !summary) {
    elements.branchSummaryCard.hidden = true;
    return;
  }

  elements.branchSummaryCard.hidden = false;
  if (state.comparison) {
    elements.branchSummaryRange.textContent = `${formatCompareRefShort(state.comparison.base)} ↔ ${formatCompareRefShort(state.comparison.target)}`;
  } else {
    elements.branchSummaryRange.textContent = '';
  }

  elements.branchSummaryPurpose.innerHTML = formatMarkdown(summary.purpose || state.story?.synopsis || '');
  elements.branchSummaryArchitecture.innerHTML = formatMarkdown(summary.architectureReview || '');

  elements.branchSummaryIssues.innerHTML = '';
  const issues = summary.potentialIssues || [];
  if (issues.length === 0) {
    const li = document.createElement('li');
    li.className = 'branch-summary-issues-empty';
    li.textContent = 'No major cross-cutting issues detected.';
    elements.branchSummaryIssues.appendChild(li);
  } else {
    for (const issueText of issues) {
      const li = document.createElement('li');
      li.className = 'key-point-item';
      li.innerHTML = formatInlineMarkdown(issueText);
      elements.branchSummaryIssues.appendChild(li);
    }
  }
}

function renderStory() {
  const pendingCount = state.story?.chapters.filter(chapter => chapter.isPending).length || 0;
  if (pendingCount > 0) {
    showLoading(`AI analysis in progress for ${pendingCount} file${pendingCount === 1 ? '' : 's'}...`);
  } else {
    hideLoading();
  }

  updateComparisonHeader();
  renderBranchSummary();

  if (!state.story || state.story.chapters.length === 0) {
    renderEmptyState();
    return;
  }

  elements.storyTitle.textContent = state.story.title;
  elements.synopsisText.innerHTML = formatMarkdown(state.story.synopsis);

  renderChapter();
  renderToc();
  updateProgressBar();
}

function renderEmptyState() {
  if (state.scope === 'commits') {
    const hasComparison = !!state.comparison;
    const baseShort = hasComparison ? formatCompareRefShort(state.comparison!.base) : '';
    const targetShort = hasComparison ? formatCompareRefShort(state.comparison!.target) : '';
    elements.storyTitle.textContent = state.story?.title || (hasComparison ? 'No Differences Found' : 'Compare Branches or Commits');
    elements.chapterCounter.textContent = '0 of 0';
    elements.filePath.textContent = hasComparison
      ? `${baseShort} ↔ ${targetShort}`
      : 'No Comparison Selected';
    elements.chapterTitle.textContent = hasComparison
      ? 'No differences between the selected states'
      : 'Select two branches or commits to compare';
    elements.chapterNarrative.innerHTML = hasComparison
      ? `<p class="prose-p">No file differences were found between <code>${escapeHtml(baseShort)}</code> and <code>${escapeHtml(targetShort)}</code>.</p>`
      : '<p class="prose-p">Choose a base and target branch or commit to compare their repository states.</p>';
    elements.keyPointsList.innerHTML = '<li class="key-point-item">Click Change Commits above to pick a different pair of branches or commits.</li>';
  } else {
    elements.storyTitle.textContent = 'No Uncommitted Changes';
    elements.chapterCounter.textContent = '0 of 0';
    elements.filePath.textContent = 'Working Tree Clean';
    elements.chapterTitle.textContent = 'Everything is up to date!';
    elements.chapterNarrative.innerHTML = '<p class="prose-p">No modified, staged, or untracked changes were detected in the selected repository scope.</p>';
    elements.keyPointsList.innerHTML = '<li class="key-point-item">Working tree is clean. Make some edits and click Refresh!</li>';
  }
  elements.issuesList.innerHTML = '';
  elements.stageFileBtn.style.display = state.scope === 'commits' ? 'none' : '';
  elements.prevChapterBtn.disabled = true;
  elements.nextChapterBtn.disabled = true;
  elements.finishCommitBtn.style.display = 'none';
  elements.openDiffBtn.disabled = true;
}

function renderChapter() {
  const chapters = state.story?.chapters || [];
  const total = chapters.length;
  const current = getCurrentChapter();
  if (!current) return;

  const currentIdx = state.currentChapterIndex;

  // Header progress
  elements.chapterCounter.textContent = `Step ${currentIdx + 1} of ${total}`;
  elements.openDiffBtn.disabled = false;

  // File Card
  elements.filePath.textContent = current.filePath;
  const status = current.diffFile?.status || 'modified';
  elements.fileStatusBadge.textContent = status[0].toUpperCase();
  elements.fileStatusBadge.className = `badge badge-${status}`;

  const additions = current.diffFile?.additions || 0;
  const deletions = current.diffFile?.deletions || 0;
  elements.fileDiffStats.textContent = `+${additions} -${deletions}`;

  const isCommitComparison = state.scope === 'commits';
  const isStaged = current.diffFile?.status !== 'untracked' && current.diffFile?.status !== 'modified';
  elements.stageFileBtn.style.display = isCommitComparison ? 'none' : '';
  elements.stageFileBtn.textContent = isStaged ? 'Unstage' : 'Stage';

  // Step Narrative Card
  elements.chapterRoleBadge.textContent = current.role;
  elements.aiProviderBadge.textContent = state.providerName || 'AI Review';
  elements.chapterTitle.textContent = current.title;
  if (current.isPending) {
    elements.chapterNarrative.textContent = current.narrative;
  } else {
    elements.chapterNarrative.innerHTML = formatMarkdown(current.narrative);
  }

  // Intention Banner
  if (state.story?.intentionContext) {
    const { summary, sources } = state.story.intentionContext;
    elements.intentionBanner.style.display = 'block';
    elements.intentionSourcesTag.textContent = sources.length > 0 ? sources.join(' • ') : '';
    elements.intentionSummaryText.textContent = summary;
  } else {
    elements.intentionBanner.style.display = 'none';
  }

  // Key Highlights
  elements.keyPointsList.innerHTML = '';
  (current.keyPoints || []).forEach((pt) => {
    const li = document.createElement('li');
    li.className = 'key-point-item';
    li.innerHTML = formatInlineMarkdown(pt);
    elements.keyPointsList.appendChild(li);
  });

  // Issues
  renderIssues(current.issues || []);

  // Clear Ask AI conversation for new file
  elements.askAiConversation.innerHTML = '';
  elements.askAiInput.value = '';
  elements.askAiInput.disabled = !!current.isPending;
  elements.askAiSubmitBtn.disabled = !!current.isPending;

  // Bottom buttons
  elements.prevChapterBtn.disabled = currentIdx === 0;

  if (currentIdx >= total - 1) {
    if (isCommitComparison) {
      elements.nextChapterBtn.style.display = 'inline-block';
      elements.nextChapterBtn.disabled = true;
      elements.finishCommitBtn.style.display = 'none';
    } else {
      elements.nextChapterBtn.style.display = 'none';
      elements.nextChapterBtn.disabled = true;
      elements.finishCommitBtn.style.display = 'inline-block';
    }
  } else {
    elements.nextChapterBtn.style.display = 'inline-block';
    elements.nextChapterBtn.disabled = false;
    elements.finishCommitBtn.style.display = 'none';
  }
}

function renderIssues(issues: IssueCallout[]) {
  elements.issuesList.innerHTML = '';

  if (getCurrentChapter()?.isPending) {
    elements.issuesList.innerHTML = '<div class="issues-empty-state">AI analysis is in progress for this file.</div>';
    return;
  }

  if (issues.length === 0) {
    elements.issuesList.innerHTML = '<div class="issues-empty-state">No automated issues detected. Changes look clean and well-structured!</div>';
    return;
  }

  const current = getCurrentChapter();

  for (const issue of issues) {
    const level = resolveSeverityLevel(issue);
    const levelUpper = level.toUpperCase();
    const card = document.createElement('div');
    card.className = `issue-card severity-${issue.severity} level-${level}`;

    const lineTag = issue.lineNumber
      ? `<button class="line-anchor-tag" data-line="${issue.lineNumber}" title="Jump to Line ${issue.lineNumber} in Native Diff">L${issue.lineNumber} &rarr;</button>`
      : '';

    card.innerHTML = `
      <div class="issue-header">
        <div class="issue-title-group">
          <span class="issue-badge badge-${issue.severity}">${escapeHtml(issue.severity.toUpperCase())}</span>
          <span class="severity-level-badge level-${level}">
            <span class="severity-dot"></span>
            <span class="severity-level-text">${escapeHtml(levelUpper)} SEVERITY</span>
          </span>
          ${issue.crossCheckVerified ? `<span class="crosscheck-badge" title="Verified against repository: Concern is not addressed elsewhere">Repo Verified</span>` : ''}
          <span class="issue-title">${formatInlineMarkdown(issue.title)}</span>
        </div>
        <div class="issue-actions">
          ${lineTag}
          <button class="copilot-action-btn" type="button" title="Address this concern with GitHub Copilot Chat">
            <svg class="copilot-icon" width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14.997 6.702a4.5 4.5 0 0 0-.825-2.072 4.475 4.475 0 0 0-1.89-1.464A4.542 4.542 0 0 0 9.878 2.6a4.49 4.49 0 0 0-3.756 0 4.542 4.542 0 0 0-2.404.566 4.475 4.475 0 0 0-1.89 1.464 4.5 4.5 0 0 0-.825 2.072A4.27 4.27 0 0 0 0 10.75c0 1.282.529 2.457 1.41 3.303.88.847 2.083 1.352 3.407 1.385l.083.002.327-.002a7.6 7.6 0 0 0 1.956-.379c.263-.09.52-.196.77-.318.016-.008.031-.016.047-.024.016.008.031.016.047.024.25.122.507.228.77.318.63.216 1.294.346 1.956.379l.327.002.083-.002c1.324-.033 2.527-.538 3.407-1.385.881-.846 1.41-2.021 1.41-3.303a4.27 4.27 0 0 0-1.003-4.048zM8 12.5a.75.75 0 0 1-.75-.75v-1.5a.75.75 0 0 1 1.5 0v1.5A.75.75 0 0 1 8 12.5zm-3.5-3a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm7 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
            </svg>
            <span class="btn-text">Address with Copilot</span>
          </button>
        </div>
      </div>
      <p class="issue-description">${formatInlineMarkdown(issue.description)}</p>
      ${issue.suggestion ? `<div class="issue-suggestion"><strong>Fix Suggestion:</strong> ${formatInlineMarkdown(issue.suggestion)}</div>` : ''}
    `;

    // Click handler for jumping to diff line in VS Code native diff editor
    if (issue.lineNumber) {
      const tag = card.querySelector('.line-anchor-tag');
      tag?.addEventListener('click', () => {
        if (current) {
          vscode.postMessage({
            type: 'jumpToDiffLine',
            filePath: current.filePath,
            lineNumber: issue.lineNumber!,
          });
        }
      });
    }

    // Click handler for sending issue to GitHub Copilot Chat
    const copilotBtn = card.querySelector('.copilot-action-btn') as HTMLButtonElement | null;
    copilotBtn?.addEventListener('click', () => {
      if (current) {
        vscode.postMessage({
          type: 'addressWithCopilot',
          filePath: current.filePath,
          issue: {
            id: issue.id,
            title: issue.title,
            description: issue.description,
            severity: issue.severity,
            severityLevel: level,
            lineNumber: issue.lineNumber,
            suggestion: issue.suggestion,
          },
        });

        // Provide immediate visual feedback on button
        const btnText = copilotBtn.querySelector('.btn-text');
        if (btnText) {
          const originalText = btnText.textContent;
          btnText.textContent = 'Opening Copilot...';
          copilotBtn.classList.add('loading');
          setTimeout(() => {
            btnText.textContent = 'Sent to Copilot ✓';
            setTimeout(() => {
              btnText.textContent = originalText;
              copilotBtn.classList.remove('loading');
            }, 1500);
          }, 600);
        }
      }
    });

    elements.issuesList.appendChild(card);
  }
}

function renderToc() {
  const chapters = state.story?.chapters || [];
  elements.tocList.innerHTML = '';

  chapters.forEach((ch, idx) => {
    const item = document.createElement('div');
    item.className = `toc-item ${idx === state.currentChapterIndex ? 'active' : ''}`;
    item.innerHTML = `
      <div class="toc-item-header">
        <span class="toc-item-num">Step ${idx + 1}</span>
        ${ch.isReviewed ? '<span class="toc-item-status">✓ Reviewed</span>' : ''}
      </div>
      <div class="toc-item-title">${escapeHtml(ch.title)}</div>
      <div class="toc-item-file">${escapeHtml(ch.filePath)}</div>
    `;

    item.addEventListener('click', () => {
      state.currentChapterIndex = idx;
      renderChapter();
      renderToc();
      updateProgressBar();
      toggleToc();
      // Notify extension to open native diff editor for this file
      vscode.postMessage({ type: 'selectChapter', chapterIndex: idx });
    });

    elements.tocList.appendChild(item);
  });
}

function updateProgressBar() {
  const chapters = state.story?.chapters || [];
  if (chapters.length === 0) {
    elements.progressBarFill.style.width = '0%';
    return;
  }
  const reviewedCount = chapters.filter(c => c.isReviewed).length;
  const pct = Math.round((reviewedCount / chapters.length) * 100);
  elements.progressBarFill.style.width = `${pct}%`;
}

function goToPrevChapter() {
  if (state.currentChapterIndex > 0) {
    state.currentChapterIndex--;
    renderChapter();
    renderToc();
    updateProgressBar();
    elements.walkthroughViewport.scrollTop = 0;
    vscode.postMessage({ type: 'selectChapter', chapterIndex: state.currentChapterIndex });
  }
}

function goToNextChapter() {
  const chapters = state.story?.chapters || [];
  if (state.currentChapterIndex < chapters.length - 1) {
    state.currentChapterIndex++;
    renderChapter();
    renderToc();
    updateProgressBar();
    elements.walkthroughViewport.scrollTop = 0;
    vscode.postMessage({ type: 'selectChapter', chapterIndex: state.currentChapterIndex });
  }
}

function toggleToc() {
  const isOpen = elements.tocDrawer.classList.contains('open');
  if (isOpen) {
    elements.tocDrawer.classList.remove('open');
    elements.drawerBackdrop.classList.remove('open');
  } else {
    elements.tocDrawer.classList.add('open');
    elements.drawerBackdrop.classList.add('open');
  }
}

function setThemeStyle(theme: 'zen' | 'editorial' | 'compact') {
  const validThemes: ('zen' | 'editorial' | 'compact')[] = ['zen', 'editorial', 'compact'];
  const safeTheme = validThemes.includes(theme) ? theme : 'zen';
  state.themeStyle = safeTheme;
  document.body.classList.remove('theme-zen', 'theme-editorial', 'theme-compact');
  document.body.classList.add(`theme-${safeTheme}`);
  if (elements.themeSelect && elements.themeSelect.value !== safeTheme) {
    elements.themeSelect.value = safeTheme;
  }
}

function submitQuestion() {
  const question = elements.askAiInput.value.trim();
  if (!question) return;

  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble user';
  userBubble.textContent = question;
  elements.askAiConversation.appendChild(userBubble);
  elements.askAiInput.value = '';

  const aiBubble = document.createElement('div');
  aiBubble.className = 'chat-bubble ai';
  aiBubble.textContent = 'Thinking...';
  elements.askAiConversation.appendChild(aiBubble);

  vscode.postMessage({
    type: 'askQuestion',
    question,
    chapterIndex: state.currentChapterIndex,
  });
}

function appendAiAnswer(question: string, answer: string) {
  const bubbles = elements.askAiConversation.querySelectorAll('.chat-bubble.ai');
  const lastBubble = bubbles[bubbles.length - 1];
  if (lastBubble) {
    lastBubble.innerHTML = formatMarkdown(answer);
  }
}

function openSynopsisModal() {
  let synopsisHtml = formatMarkdown(state.story?.synopsis || 'No overview available.');
  if (state.story?.changeSummary) {
    const { purpose, architectureReview, potentialIssues } = state.story.changeSummary;
    const issuesHtml = potentialIssues.length > 0
      ? `<ul>${potentialIssues.map(i => `<li>${formatInlineMarkdown(i)}</li>`).join('')}</ul>`
      : '<p class="prose-p">No major cross-cutting issues detected.</p>';
    synopsisHtml =
      `<h4>Purpose</h4>${formatMarkdown(purpose)}` +
      `<h4>Architecture Review</h4>${formatMarkdown(architectureReview)}` +
      `<h4>Potential Issues</h4>${issuesHtml}` +
      `<hr/>` +
      synopsisHtml;
  }
  if (state.story?.intentionContext) {
    const { summary, sources } = state.story.intentionContext;
    synopsisHtml = `<div class="intention-overview-callout">` +
      `<strong>Intent Grounding:</strong> ${escapeHtml(summary)}` +
      (sources.length > 0 ? `<div class="intention-sources-subtext">Sources: ${escapeHtml(sources.join(', '))}</div>` : '') +
      `</div>` + synopsisHtml;
  }
  elements.synopsisText.innerHTML = synopsisHtml;
  elements.synopsisModal.classList.add('open');
}

function closeSynopsisModal() {
  elements.synopsisModal.classList.remove('open');
}

function openCommitModal() {
  elements.commitMessageInput.value = state.story?.suggestedCommitMessage || '';
  elements.commitModal.classList.add('open');
}

function closeCommitModal() {
  elements.commitModal.classList.remove('open');
}

function openCompareModal(preferredMode?: 'branches' | 'commits') {
  clearCompareError();
  resetCompareSubmitState();
  const mode = preferredMode || (state.comparison ? (state.comparison.base.label || state.comparison.target.label ? 'branches' : 'commits') : state.compareMode);
  setCompareMode(mode, false);
  if (state.comparison) {
    elements.baseCommitInput.value = formatCompareRefShort(state.comparison.base);
    elements.targetCommitInput.value = formatCompareRefShort(state.comparison.target);
  }
  vscode.postMessage({ type: 'requestCommits' });
  if (typeof elements.compareModal.showModal === 'function') {
    if (!elements.compareModal.open) {
      elements.compareModal.showModal();
    }
  }
}

function setCompareMode(mode: 'branches' | 'commits', resetDefaults: boolean) {
  state.compareMode = mode;
  elements.compareModeBranches.checked = mode === 'branches';
  elements.compareModeCommits.checked = mode === 'commits';

  if (mode === 'branches') {
    elements.baseCommitLabel.textContent = 'Base Branch (From / Left State)';
    elements.targetCommitLabel.textContent = 'Target Branch (To / Right State)';
    elements.baseCommitInput.placeholder = 'e.g. main, origin/main, HEAD~1, or commit SHA';
    elements.targetCommitInput.placeholder = 'e.g. feature/branch, HEAD, or commit SHA';
  } else {
    elements.baseCommitLabel.textContent = 'Base Commit (From / Left State)';
    elements.targetCommitLabel.textContent = 'Target Commit (To / Right State)';
    elements.baseCommitInput.placeholder = 'e.g. HEAD~1, main, v1.0.0, or commit SHA';
    elements.targetCommitInput.placeholder = 'e.g. HEAD, feature-branch, or commit SHA';
  }

  if (resetDefaults) {
    elements.baseCommitInput.value = '';
    elements.targetCommitInput.value = '';
    clearCompareError();
  }
  populateCompareSelectors(resetDefaults);
}

function closeCompareModal() {
  if (typeof elements.compareModal.close === 'function' && elements.compareModal.open) {
    elements.compareModal.close();
  }
  resetCompareSubmitState();
  elements.scopeSelect.value = state.scope;
}

function resetCompareSubmitState() {
  state.isCompareSubmitting = false;
  elements.executeCompareBtn.disabled = false;
  elements.executeCompareBtn.textContent = 'Compare Changes';
}

function clearCompareError(field?: 'base' | 'target') {
  elements.compareErrorMsg.textContent = '';
  if (!field || field === 'base') {
    elements.baseCommitInput.removeAttribute('aria-invalid');
  }
  if (!field || field === 'target') {
    elements.targetCommitInput.removeAttribute('aria-invalid');
  }
}

function setCompareError(message: string, invalidField?: 'base' | 'target' | 'both') {
  elements.compareErrorMsg.textContent = message;
  if (invalidField === 'base' || invalidField === 'both') {
    elements.baseCommitInput.setAttribute('aria-invalid', 'true');
  }
  if (invalidField === 'target' || invalidField === 'both') {
    elements.targetCommitInput.setAttribute('aria-invalid', 'true');
  }
  if (invalidField === 'target') {
    elements.targetCommitInput.focus?.();
  } else {
    elements.baseCommitInput.focus?.();
  }
}

function syncSelectToInput(selectEl: HTMLSelectElement, inputVal: string) {
  const trimmed = inputVal.trim();
  const options = Array.from(selectEl.options || []);
  const match = options.find(opt => opt.value === trimmed);
  selectEl.value = match ? match.value : '';
}

function populateCompareSelectors(applyDefaults: boolean) {
  const isBranchMode = state.compareMode === 'branches';

  const buildBranchOptions = (selectEl: HTMLSelectElement, placeholder: string) => {
    selectEl.innerHTML = '';
    const customOpt = document.createElement('option');
    customOpt.value = '';
    customOpt.textContent = state.branches.length > 0 ? placeholder : 'No branches found (enter ref below)';
    selectEl.appendChild(customOpt);

    for (const b of state.branches) {
      const opt = document.createElement('option');
      opt.value = b.name;
      const scopeTag = b.isCurrent ? ' (current)' : b.isRemote ? ' (remote)' : '';
      const dateTag = b.date ? ` • ${b.date}` : '';
      opt.textContent = `${b.name}${scopeTag} — ${b.shortHash} ${b.subject}${dateTag}`;
      selectEl.appendChild(opt);
    }
  };

  const buildCommitOptions = (selectEl: HTMLSelectElement, placeholder: string) => {
    selectEl.innerHTML = '';
    const customOpt = document.createElement('option');
    customOpt.value = '';
    customOpt.textContent = state.commits.length > 0 ? placeholder : 'No commits found (enter ref below)';
    selectEl.appendChild(customOpt);

    for (const c of state.commits) {
      const opt = document.createElement('option');
      opt.value = c.shortHash;
      const refsTag = c.refs ? ` [${c.refs}]` : '';
      const dateTag = c.date ? ` (${c.date})` : '';
      opt.textContent = `${c.shortHash} — ${c.subject}${refsTag}${dateTag}`;
      selectEl.appendChild(opt);
    }
  };

  if (isBranchMode) {
    buildBranchOptions(elements.baseCommitSelect, 'Choose a base branch...');
    buildBranchOptions(elements.targetCommitSelect, 'Choose a target branch...');
  } else {
    buildCommitOptions(elements.baseCommitSelect, 'Choose a recent base commit...');
    buildCommitOptions(elements.targetCommitSelect, 'Choose a recent target commit...');
  }

  if (applyDefaults) {
    if (isBranchMode) {
      const currentBranch = state.branches.find(b => b.isCurrent)?.name;
      const fallbackBase =
        state.branches.find(b => !b.isRemote && (b.name === 'main' || b.name === 'master') && b.name !== currentBranch)?.name ||
        state.branches.find(b => !b.isRemote && b.name !== currentBranch)?.name ||
        state.branches.find(b => b.name !== currentBranch)?.name ||
        state.branches[0]?.name ||
        state.defaultCompareBase;
      const fallbackTarget = currentBranch || state.branches[0]?.name || state.defaultCompareTarget;

      if (!elements.baseCommitInput.value.trim() && fallbackBase) {
        elements.baseCommitInput.value = fallbackBase;
      }
      if (!elements.targetCommitInput.value.trim() && fallbackTarget) {
        elements.targetCommitInput.value = fallbackTarget;
      }
    } else {
      const commitBase = state.commits[1]?.shortHash || state.commits[0]?.shortHash || state.defaultCompareBase;
      const commitTarget = state.commits[0]?.shortHash || state.defaultCompareTarget || 'HEAD';
      if (!elements.baseCommitInput.value.trim() && commitBase) {
        elements.baseCommitInput.value = commitBase;
      }
      if (!elements.targetCommitInput.value.trim() && commitTarget) {
        elements.targetCommitInput.value = commitTarget;
      }
    }
  }

  syncSelectToInput(elements.baseCommitSelect, elements.baseCommitInput.value);
  syncSelectToInput(elements.targetCommitSelect, elements.targetCommitInput.value);
}

function showLoading(msg: string, cancellable: boolean = true) {
  elements.loadingMessage.textContent = msg;
  elements.cancelReviewBtn.disabled = false;
  elements.cancelReviewBtn.textContent = 'Cancel';
  elements.cancelReviewBtn.hidden = !cancellable;
  elements.loadingOverlay.classList.add('open');
}

function hideLoading() {
  elements.loadingOverlay.classList.remove('open');
  elements.cancelReviewBtn.disabled = false;
  elements.cancelReviewBtn.textContent = 'Cancel';
}

function requestCancelReview() {
  if (elements.cancelReviewBtn.disabled) return;
  elements.cancelReviewBtn.disabled = true;
  elements.cancelReviewBtn.textContent = 'Cancelling...';
  elements.loadingMessage.textContent = 'Cancelling AI review...';
  vscode.postMessage({ type: 'cancelReview' });
}

function renderCancelledState(message: string) {
  elements.storyTitle.textContent = 'Review Cancelled';
  elements.chapterCounter.textContent = '0 of 0';
  elements.filePath.textContent = 'Generation Cancelled';
  elements.chapterTitle.textContent = 'AI review generation cancelled';
  elements.chapterNarrative.innerHTML = `<p class="prose-p">${escapeHtml(message || 'AI review generation was cancelled.')}</p>`;
  elements.keyPointsList.innerHTML = '<li class="key-point-item">Click Refresh in the toolbar whenever you want to run the AI review again.</li>';
  elements.issuesList.innerHTML = '';
  elements.stageFileBtn.style.display = state.scope === 'commits' ? 'none' : '';
  elements.prevChapterBtn.disabled = true;
  elements.nextChapterBtn.disabled = true;
  elements.finishCommitBtn.style.display = 'none';
  elements.openDiffBtn.disabled = true;
}

// Initialize on script load
init();
