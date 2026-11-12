import { DiffScope, GitRepoInfo } from '../../git/types';
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
  currentChapterIndex: number;
  currentRepo?: GitRepoInfo;
  repos: GitRepoInfo[];
  scope: DiffScope;
  providerName: string;
  themeStyle: 'zen' | 'editorial' | 'compact';
}

const state: AppState = {
  currentChapterIndex: 0,
  repos: [],
  scope: 'all',
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
  reviewedCheck: document.getElementById('reviewed-check') as HTMLInputElement,
  finishCommitBtn: document.getElementById('finish-commit-btn') as HTMLButtonElement,

  // Commit Modal
  commitModal: document.getElementById('commit-modal') as HTMLElement,
  closeCommitBtn: document.getElementById('close-commit-btn') as HTMLButtonElement,
  cancelCommitBtn: document.getElementById('cancel-commit-btn') as HTMLButtonElement,
  executeCommitBtn: document.getElementById('execute-commit-btn') as HTMLButtonElement,
  commitMessageInput: document.getElementById('commit-message-input') as HTMLTextAreaElement,

  // Loading
  loadingOverlay: document.getElementById('loading-overlay') as HTMLElement,
  loadingMessage: document.getElementById('loading-message') as HTMLElement,
};

function init() {
  window.addEventListener('message', handleExtensionMessage);

  elements.refreshBtn.addEventListener('click', () => {
    showLoading('Refreshing review changes...');
    vscode.postMessage({ type: 'refresh' });
  });

  elements.openDiffBtn.addEventListener('click', () => {
    const chapter = getCurrentChapter();
    if (chapter) {
      vscode.postMessage({ type: 'openDiffEditor', filePath: chapter.filePath });
    }
  });

  elements.scopeSelect.addEventListener('change', (e) => {
    const scope = (e.target as HTMLSelectElement).value as DiffScope;
    state.scope = scope;
    showLoading(`Filtering changes (${scope})...`);
    vscode.postMessage({ type: 'changeScope', scope });
  });

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

  // Synopsis modal
  elements.synopsisToggleBtn.addEventListener('click', openSynopsisModal);
  elements.closeSynopsisBtn.addEventListener('click', closeSynopsisModal);

  // Commit modal
  elements.closeCommitBtn.addEventListener('click', closeCommitModal);
  elements.cancelCommitBtn.addEventListener('click', closeCommitModal);
  elements.executeCommitBtn.addEventListener('click', () => {
    const msg = elements.commitMessageInput.value.trim();
    if (msg) {
      showLoading('Executing git commit...');
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
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
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
      elements.reviewedCheck.click();
    }
  });

  // Signal ready to extension
  vscode.postMessage({ type: 'ready' });
}

function handleExtensionMessage(event: MessageEvent<ExtensionMessageToWebview>) {
  const message = event.data;
  hideLoading();

  switch (message.type) {
    case 'init': {
      state.story = message.payload.story;
      state.providerName = message.payload.providerName;
      state.currentRepo = message.payload.currentRepo;
      state.repos = message.payload.repos;
      state.scope = message.payload.scope;
      state.currentChapterIndex = 0;

      if (message.payload.themeStyle) {
        setThemeStyle(message.payload.themeStyle as any);
      }

      elements.scopeSelect.value = state.scope;
      renderStory();
      break;
    }

    case 'updateStory': {
      state.story = message.payload.story;
      renderStory();
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

function renderStory() {
  if (!state.story || state.story.chapters.length === 0) {
    renderEmptyState();
    return;
  }

  elements.storyTitle.textContent = state.story.title;
  elements.repoBranch.textContent = state.currentRepo?.headBranch || 'main';
  elements.synopsisText.innerHTML = formatMarkdown(state.story.synopsis);

  renderChapter();
  renderToc();
  updateProgressBar();
}

function renderEmptyState() {
  elements.storyTitle.textContent = 'No Uncommitted Changes';
  elements.chapterCounter.textContent = '0 of 0';
  elements.filePath.textContent = 'Working Tree Clean';
  elements.chapterTitle.textContent = 'Everything is up to date!';
  elements.chapterNarrative.innerHTML = '<p class="prose-p">No modified, staged, or untracked changes were detected in the selected repository scope.</p>';
  elements.keyPointsList.innerHTML = '<li class="key-point-item">Working tree is clean. Make some edits and click Refresh!</li>';
  elements.issuesList.innerHTML = '';
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

  const isStaged = current.diffFile?.status !== 'untracked' && current.diffFile?.status !== 'modified';
  elements.stageFileBtn.textContent = isStaged ? 'Unstage' : 'Stage';

  // Step Narrative Card
  elements.chapterRoleBadge.textContent = current.role;
  elements.aiProviderBadge.textContent = state.providerName || 'AI Review';
  elements.chapterTitle.textContent = current.title;
  elements.chapterNarrative.innerHTML = formatMarkdown(current.narrative);

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

  // Reviewed status
  elements.reviewedCheck.checked = !!current.isReviewed;

  // Clear Ask AI conversation for new file
  elements.askAiConversation.innerHTML = '';
  elements.askAiInput.value = '';

  // Bottom buttons
  elements.prevChapterBtn.disabled = currentIdx === 0;

  if (currentIdx >= total - 1) {
    elements.nextChapterBtn.style.display = 'none';
    elements.nextChapterBtn.disabled = true;
    elements.finishCommitBtn.style.display = 'inline-block';
  } else {
    elements.nextChapterBtn.style.display = 'inline-block';
    elements.nextChapterBtn.disabled = false;
    elements.finishCommitBtn.style.display = 'none';
  }
}

function renderIssues(issues: IssueCallout[]) {
  elements.issuesList.innerHTML = '';

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

function showLoading(msg: string) {
  elements.loadingMessage.textContent = msg;
  elements.loadingOverlay.classList.add('open');
}

function hideLoading() {
  elements.loadingOverlay.classList.remove('open');
}

// Initialize on script load
init();
