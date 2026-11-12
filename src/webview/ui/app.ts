import { Chapter, IssueCallout, StoryNarrative } from '../../ai/types';
import { DiffFile, DiffHunk, DiffLine } from '../../diff/types';
import { DiffScope, GitRepoInfo } from '../../git/types';
import { ExtensionMessageToWebview, WebviewMessageToExtension } from '../types';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessageToExtension): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

interface AppState {
  story?: StoryNarrative;
  providerName: string;
  currentRepo?: GitRepoInfo;
  repos: GitRepoInfo[];
  scope: DiffScope;
  diffMode: 'split' | 'unified';
  currentChapterIndex: number;
}

const state: AppState = {
  providerName: 'Heuristic',
  repos: [],
  scope: 'all',
  diffMode: 'split',
  currentChapterIndex: 0,
};

// DOM Elements
const elements = {
  storyTitle: document.getElementById('story-title') as HTMLElement,
  repoBranch: document.getElementById('repo-branch') as HTMLElement,
  chapterCounter: document.getElementById('chapter-counter') as HTMLElement,
  progressBarFill: document.getElementById('progress-bar-fill') as HTMLElement,
  scopeSelect: document.getElementById('scope-select') as HTMLSelectElement,
  diffModeControl: document.getElementById('diff-mode-control') as HTMLElement,
  refreshBtn: document.getElementById('refresh-btn') as HTMLButtonElement,
  tocBtn: document.getElementById('toc-btn') as HTMLButtonElement,
  tocDrawer: document.getElementById('toc-drawer') as HTMLElement,
  closeTocBtn: document.getElementById('close-toc-btn') as HTMLButtonElement,
  drawerBackdrop: document.getElementById('drawer-backdrop') as HTMLElement,
  tocList: document.getElementById('toc-list') as HTMLElement,

  // Left Page
  filePath: document.getElementById('file-path') as HTMLElement,
  fileStatusBadge: document.getElementById('file-status-badge') as HTMLElement,
  fileDiffStats: document.getElementById('file-diff-stats') as HTMLElement,
  stageFileBtn: document.getElementById('stage-file-btn') as HTMLButtonElement,
  openEditorBtn: document.getElementById('open-editor-btn') as HTMLButtonElement,
  diffContent: document.getElementById('diff-content') as HTMLElement,
  diffViewport: document.getElementById('diff-viewport') as HTMLElement,

  // Right Page
  chapterRoleBadge: document.getElementById('chapter-role-badge') as HTMLElement,
  aiProviderBadge: document.getElementById('ai-provider-badge') as HTMLElement,
  chapterTitle: document.getElementById('chapter-title') as HTMLElement,
  chapterNarrative: document.getElementById('chapter-narrative') as HTMLElement,
  keyPointsList: document.getElementById('key-points-list') as HTMLElement,
  issuesList: document.getElementById('issues-list') as HTMLElement,
  askAiInput: document.getElementById('ask-ai-input') as HTMLInputElement,
  askAiSubmitBtn: document.getElementById('ask-ai-submit-btn') as HTMLButtonElement,
  askAiConversation: document.getElementById('ask-ai-conversation') as HTMLElement,
  synopsisToggleBtn: document.getElementById('synopsis-toggle-btn') as HTMLButtonElement,

  // Footer
  prevChapterBtn: document.getElementById('prev-chapter-btn') as HTMLButtonElement,
  nextChapterBtn: document.getElementById('next-chapter-btn') as HTMLButtonElement,
  finishCommitBtn: document.getElementById('finish-commit-btn') as HTMLButtonElement,
  reviewedCheck: document.getElementById('reviewed-check') as HTMLInputElement,

  // Modals
  synopsisModal: document.getElementById('synopsis-modal') as HTMLElement,
  synopsisModalTitle: document.getElementById('synopsis-modal-title') as HTMLElement,
  synopsisText: document.getElementById('synopsis-text') as HTMLElement,
  closeSynopsisBtn: document.getElementById('close-synopsis-btn') as HTMLButtonElement,

  commitModal: document.getElementById('commit-modal') as HTMLElement,
  commitMessageInput: document.getElementById('commit-message-input') as HTMLTextAreaElement,
  cancelCommitBtn: document.getElementById('cancel-commit-btn') as HTMLButtonElement,
  executeCommitBtn: document.getElementById('execute-commit-btn') as HTMLButtonElement,
  closeCommitBtn: document.getElementById('close-commit-btn') as HTMLButtonElement,

  // Loading
  loadingOverlay: document.getElementById('loading-overlay') as HTMLElement,
  loadingMessage: document.getElementById('loading-message') as HTMLElement,
};

// Initialize listeners
function init() {
  window.addEventListener('message', handleExtensionMessage);

  elements.refreshBtn.addEventListener('click', () => {
    showLoading('Refreshing review changes...');
    vscode.postMessage({ type: 'refresh' });
  });

  elements.scopeSelect.addEventListener('change', (e) => {
    const scope = (e.target as HTMLSelectElement).value as DiffScope;
    state.scope = scope;
    showLoading(`Filtering changes (${scope})...`);
    vscode.postMessage({ type: 'changeScope', scope });
  });

  // Diff Mode buttons
  elements.diffModeControl.querySelectorAll('.segment-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode') as 'split' | 'unified';
      setDiffMode(mode);
    });
  });

  // TOC drawer toggle
  elements.tocBtn.addEventListener('click', toggleToc);
  elements.closeTocBtn.addEventListener('click', toggleToc);
  elements.drawerBackdrop.addEventListener('click', toggleToc);

  // Chapter Navigation
  elements.prevChapterBtn.addEventListener('click', goToPrevChapter);
  elements.nextChapterBtn.addEventListener('click', goToNextChapter);
  elements.finishCommitBtn.addEventListener('click', openCommitModal);

  // Reviewed Checkbox
  elements.reviewedCheck.addEventListener('change', () => {
    const chapter = getCurrentChapter();
    if (chapter) {
      chapter.isReviewed = elements.reviewedCheck.checked;
      renderToc();
      updateProgressBar();
      vscode.postMessage({
        type: 'markReviewed',
        chapterIndex: state.currentChapterIndex,
        isReviewed: chapter.isReviewed,
      });
    }
  });

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

  // Ask AI
  elements.askAiSubmitBtn.addEventListener('click', submitQuestion);
  elements.askAiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitQuestion();
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
      showLoading('Committing changes...');
      vscode.postMessage({ type: 'commit', message: msg });
      closeCommitModal();
    }
  });

  // Keyboard navigation shortcuts
  window.addEventListener('keydown', handleGlobalKeydown);

  // Let extension know webview is ready
  vscode.postMessage({ type: 'ready' });
}

function handleGlobalKeydown(e: KeyboardEvent) {
  // Ignore shortcuts if typing in input/textarea
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    return;
  }

  if (e.key === '[' || e.key === 'j' || e.key === 'J') {
    goToPrevChapter();
  } else if (e.key === ']' || e.key === 'k' || e.key === 'K') {
    goToNextChapter();
  } else if (e.key === 't' || e.key === 'T') {
    toggleToc();
  } else if (e.key === 'm' || e.key === 'M') {
    elements.reviewedCheck.click();
  } else if (e.key === 'r' || e.key === 'R') {
    elements.refreshBtn.click();
  }
}

function handleExtensionMessage(event: MessageEvent<ExtensionMessageToWebview>) {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      state.story = msg.payload.story;
      state.providerName = msg.payload.providerName;
      state.currentRepo = msg.payload.currentRepo;
      state.repos = msg.payload.repos;
      state.scope = msg.payload.scope;
      state.diffMode = msg.payload.diffMode || 'split';
      state.currentChapterIndex = 0;

      elements.scopeSelect.value = state.scope;
      setDiffMode(state.diffMode);
      renderAll();
      hideLoading();
      break;
    }
    case 'updateStory': {
      state.story = msg.payload.story;
      if (state.currentChapterIndex >= (state.story.chapters.length || 0)) {
        state.currentChapterIndex = 0;
      }
      renderAll();
      hideLoading();
      break;
    }
    case 'answer': {
      appendAiAnswer(msg.payload.question, msg.payload.answer);
      break;
    }
    case 'loading': {
      showLoading(msg.payload.message);
      break;
    }
    case 'fileStagedStatus': {
      const chapter = getCurrentChapter();
      if (chapter && chapter.filePath === msg.payload.filePath) {
        elements.stageFileBtn.textContent = msg.payload.isStaged ? 'Unstage' : 'Stage';
      }
      break;
    }
    case 'commitSuccess': {
      hideLoading();
      alert(`Commit successful:\n${msg.payload.message}`);
      vscode.postMessage({ type: 'refresh' });
      break;
    }
    case 'error': {
      hideLoading();
      alert(`Git Story Notice: ${msg.payload.message}`);
      break;
    }
  }
}

function getCurrentChapter(): Chapter | undefined {
  if (!state.story || !state.story.chapters || state.story.chapters.length === 0) {
    return undefined;
  }
  return state.story.chapters[state.currentChapterIndex];
}

function renderAll() {
  if (!state.story || !state.story.chapters || state.story.chapters.length === 0) {
    renderEmptyState();
    return;
  }

  elements.storyTitle.textContent = state.story.title || 'Review Walkthrough';
  elements.repoBranch.textContent = state.currentRepo?.headBranch || 'working-tree';
  elements.aiProviderBadge.textContent = state.providerName;
  elements.synopsisText.textContent = state.story.synopsis;

  renderChapter();
  renderToc();
  updateProgressBar();
}

function renderEmptyState() {
  elements.storyTitle.textContent = 'No Uncommitted Changes';
  elements.chapterCounter.textContent = '0 of 0';
  elements.filePath.textContent = 'Working Tree Clean';
  elements.chapterTitle.textContent = 'Everything is up to date!';
  elements.chapterNarrative.textContent = 'No modified, staged, or untracked changes were detected in the selected repository.';
  elements.diffContent.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted);">Working tree is clean. Make some edits in your workspace and click Refresh!</div>';
  elements.keyPointsList.innerHTML = '';
  elements.issuesList.innerHTML = '';
  elements.prevChapterBtn.disabled = true;
  elements.nextChapterBtn.disabled = true;
  elements.finishCommitBtn.style.display = 'none';
}

function renderChapter() {
  const chapters = state.story?.chapters || [];
  const total = chapters.length;
  const current = getCurrentChapter();
  if (!current) return;

  const currentIdx = state.currentChapterIndex;

  // Header progress
  elements.chapterCounter.textContent = `Step ${currentIdx + 1} of ${total}`;

  // Left Page: File Header
  elements.filePath.textContent = current.filePath;
  const status = current.diffFile?.status || 'modified';
  elements.fileStatusBadge.textContent = status[0].toUpperCase();
  elements.fileStatusBadge.className = `badge badge-${status}`;

  const additions = current.diffFile?.additions || 0;
  const deletions = current.diffFile?.deletions || 0;
  elements.fileDiffStats.textContent = `+${additions} -${deletions}`;

  // Left Page: Render Diff View
  renderDiff(current.diffFile);

  // Right Page: Story
  elements.chapterRoleBadge.textContent = current.role;
  elements.chapterTitle.textContent = current.title;
  elements.chapterNarrative.textContent = current.narrative;

  // Key Highlights
  elements.keyPointsList.innerHTML = '';
  (current.keyPoints || []).forEach((pt) => {
    const li = document.createElement('li');
    li.textContent = pt;
    elements.keyPointsList.appendChild(li);
  });

  // Issues
  renderIssues(current.issues || []);

  // Reviewed status
  elements.reviewedCheck.checked = !!current.isReviewed;

  // Clear or reset Ask AI conversation
  elements.askAiConversation.innerHTML = '';
  elements.askAiInput.value = '';

  // Bottom buttons
  elements.prevChapterBtn.disabled = currentIdx === 0;

  if (currentIdx === total - 1) {
    elements.nextChapterBtn.style.display = 'none';
    elements.finishCommitBtn.style.display = 'inline-block';
  } else {
    elements.nextChapterBtn.style.display = 'inline-block';
    elements.finishCommitBtn.style.display = 'none';
  }
}

function renderDiff(diffFile?: DiffFile) {
  if (!diffFile || !diffFile.hunks || diffFile.hunks.length === 0) {
    elements.diffContent.innerHTML = '<div style="padding: 24px; color: var(--text-muted);">No text differences to display (e.g. empty file or permissions change).</div>';
    return;
  }

  elements.diffContent.innerHTML = '';

  for (const hunk of diffFile.hunks) {
    // Hunk Header Row
    const headerRow = document.createElement('div');
    headerRow.className = 'diff-row diff-row-hunk-header';
    headerRow.innerHTML = `
      <div class="diff-gutter">...</div>
      <div class="diff-line-code">${escapeHtml(hunk.header)}</div>
    `;
    elements.diffContent.appendChild(headerRow);

    for (const line of hunk.lines) {
      const row = document.createElement('div');
      const lineClass = line.type === 'add' ? 'diff-row-add' : line.type === 'delete' ? 'diff-row-delete' : 'diff-row-context';
      row.className = `diff-row ${lineClass}`;

      // Assign id for line anchor scrolling if it has a line number
      const lineNum = line.newLineNumber || line.oldLineNumber;
      if (lineNum) {
        row.id = `diff-line-${lineNum}`;
      }

      // Gutter number
      const gutterText = line.type === 'add' ? `+${line.newLineNumber}` : line.type === 'delete' ? `-${line.oldLineNumber}` : `${line.newLineNumber || line.oldLineNumber || ''}`;

      // Content with word highlights if present
      let codeHtml = '';
      if (line.wordTokens && line.wordTokens.length > 0) {
        codeHtml = line.wordTokens.map(t => {
          if (t.isChanged) {
            return `<span class="diff-word-changed">${escapeHtml(t.text)}</span>`;
          }
          return escapeHtml(t.text);
        }).join('');
      } else {
        codeHtml = escapeHtml(line.content);
      }

      row.innerHTML = `
        <div class="diff-gutter">${gutterText}</div>
        <div class="diff-line-code">${codeHtml || ' '}</div>
      `;
      elements.diffContent.appendChild(row);
    }
  }
}

function renderIssues(issues: IssueCallout[]) {
  elements.issuesList.innerHTML = '';

  if (issues.length === 0) {
    elements.issuesList.innerHTML = '<div style="font-size: 13px; color: var(--text-muted); padding: 8px 0;">No automated issues detected. Looks clean!</div>';
    return;
  }

  for (const issue of issues) {
    const card = document.createElement('div');
    card.className = `issue-card severity-${issue.severity}`;

    const lineTag = issue.lineNumber
      ? `<span class="line-anchor-tag" data-line="${issue.lineNumber}" title="Jump to Line ${issue.lineNumber}">L${issue.lineNumber} &rarr;</span>`
      : '';

    card.innerHTML = `
      <div class="issue-header">
        <div class="issue-title-group">
          <span class="issue-badge">${issue.severity}</span>
          <span class="issue-title">${escapeHtml(issue.title)}</span>
        </div>
        ${lineTag}
      </div>
      <p class="issue-description">${escapeHtml(issue.description)}</p>
      ${issue.suggestion ? `<div class="issue-suggestion"><strong>Fix:</strong> ${escapeHtml(issue.suggestion)}</div>` : ''}
    `;

    // Click handler for jumping to diff line
    if (issue.lineNumber) {
      const tag = card.querySelector('.line-anchor-tag');
      tag?.addEventListener('click', () => {
        jumpToDiffLine(issue.lineNumber!);
      });
    }

    elements.issuesList.appendChild(card);
  }
}

function jumpToDiffLine(lineNumber: number) {
  const lineEl = document.getElementById(`diff-line-${lineNumber}`);
  if (lineEl) {
    lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    lineEl.classList.remove('diff-line-highlighted');
    // Trigger reflow to restart animation
    void lineEl.offsetWidth;
    lineEl.classList.add('diff-line-highlighted');
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
    elements.diffViewport.scrollTop = 0;
  }
}

function goToNextChapter() {
  const chapters = state.story?.chapters || [];
  if (state.currentChapterIndex < chapters.length - 1) {
    state.currentChapterIndex++;
    renderChapter();
    renderToc();
    elements.diffViewport.scrollTop = 0;
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

function setDiffMode(mode: 'split' | 'unified') {
  state.diffMode = mode;
  elements.diffModeControl.querySelectorAll('.segment-btn').forEach(b => {
    if (b.getAttribute('data-mode') === mode) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });

  if (mode === 'split') {
    elements.diffContent.classList.add('split-view');
  } else {
    elements.diffContent.classList.remove('split-view');
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
  // Find last thinking bubble
  const bubbles = elements.askAiConversation.querySelectorAll('.chat-bubble.ai');
  const lastBubble = bubbles[bubbles.length - 1];
  if (lastBubble) {
    lastBubble.textContent = answer;
  }
}

function openSynopsisModal() {
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

function showLoading(msg: string) {
  elements.loadingMessage.textContent = msg;
  elements.loadingOverlay.classList.add('open');
}

function hideLoading() {
  elements.loadingOverlay.classList.remove('open');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Start
init();
