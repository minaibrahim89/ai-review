/**
 * Pure Markdown formatting utilities for Git Story review walkthrough.
 * Ensures zero raw markdown syntax is exposed and all code identifiers
 * (methods, classes, variables, file paths) are rendered as styled badges.
 */

export function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Unified regex for code identifiers. Single-pass prevents any nesting or double-wrapping.
 * 1. Method calls: validateToken(), redis.get(id), fn() (ends in parenthesis)
 * 2. Word-boundary patterns:
 *    - Dotted property chains: config.auth.token
 *    - File paths / names: src/auth/service.ts, package.json
 *    - camelCase variables: userId, currentIdx, isReady
 *    - PascalCase types / classes: SessionService, ReviewPanel, DiffParser
 *    - snake_case / CONSTANTS: user_id, MAX_BUFFER_SIZE
 */
const UNIFIED_IDENTIFIER_REGEX = /\b[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]+)*\s*\([^)\r\n]*\)|\b(?:[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]+)+|[a-zA-Z0-9_\-\./]+\.(?:ts|js|tsx|jsx|json|py|go|rs|css|scss|html|md|sql|ya?ml|proto|prisma|sh|bat)|[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+|[a-zA-Z0-9]+_[a-zA-Z0-9_]+)\b/g;

/**
 * Highlights code identifiers (methods, classes, variables, file paths) in plain text segments.
 * Only runs on text that is NOT inside existing HTML tags.
 */
export function highlightIdentifiers(text: string): string {
  if (!text) return '';
  return text.replace(UNIFIED_IDENTIFIER_REGEX, '<code class="inline-code">$&</code>');
}

/**
 * Runs identifier highlighting safely outside of any existing HTML tags.
 */
export function highlightIdentifiersOutsideTags(html: string): string {
  // Extract all existing HTML tags into non-word Private Use Area placeholders
  const tagPlaceholders: string[] = [];
  const withoutTags = html.replace(/<[^>]+>/g, (match) => {
    const idx = tagPlaceholders.length;
    tagPlaceholders.push(match);
    return `\uE004${idx}\uE005`;
  });

  // Highlight identifiers in plain text segments in a single pass
  const highlighted = highlightIdentifiers(withoutTags);

  // Restore HTML tags
  return highlighted.replace(/\uE004(\d+)\uE005/g, (_m, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return tagPlaceholders[idx] || '';
  });
}

/**
 * Parses inline markdown: backticks, bold, italic, and auto-detects identifiers.
 */
export function formatInlineMarkdown(text: string): string {
  if (!text) return '';
  let safe = escapeHtml(text);

  // 1. Extract explicit backtick code spans `code` into non-word tokens
  const codePlaceholders: string[] = [];
  safe = safe.replace(/`([^`\r\n]+)`/g, (_m, code) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(`<code class="inline-code">${code}</code>`);
    return `\uE000${idx}\uE001`;
  });

  // 2. Bold **text** or __text__
  safe = safe.replace(/\*\*([^*\r\n]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/__([^_\\r\n]+)__/g, '<strong>$1</strong>');

  // 3. Italic *text* or _text_
  safe = safe.replace(/(?<!\*)\*([^*\r\n]+)\*(?!\*)/g, '<em>$1</em>');
  safe = safe.replace(/(?<!_)_([^_\\r\n]+)_(?!_)/g, '<em>$1</em>');

  // 4. Highlight identifiers in prose outside existing tags
  safe = highlightIdentifiersOutsideTags(safe);

  // 5. Restore explicit backtick code spans
  safe = safe.replace(/\uE000(\d+)\uE001/g, (_m, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return codePlaceholders[idx] || '';
  });

  return safe;
}

/**
 * Full Markdown parser that guarantees NO RAW MARKDOWN is shown.
 * Handles headers, fenced code blocks, inline code, bold, italic, blockquotes,
 * bullet lists, numbered lists, and auto-detected code identifiers.
 */
export function formatMarkdown(raw: string): string {
  if (!raw) return '';

  // Step 1: Extract fenced code blocks ```lang\ncode\n```
  const codeBlockPlaceholders: string[] = [];
  let processed = raw.replace(/```(?:[a-zA-Z0-9_\-\.]*)\r?\n([\s\S]*?)```/g, (_match, code) => {
    const idx = codeBlockPlaceholders.length;
    codeBlockPlaceholders.push(`<pre class="code-block"><code>${escapeHtml(code.trim())}</code></pre>`);
    return `\uE002${idx}\uE003\n`;
  });

  // Step 2: Extract explicit inline code `code`
  const inlineCodePlaceholders: string[] = [];
  processed = processed.replace(/`([^`\r\n]+)`/g, (_match, code) => {
    const idx = inlineCodePlaceholders.length;
    inlineCodePlaceholders.push(`<code class="inline-code">${escapeHtml(code)}</code>`);
    return `\uE000${idx}\uE001`;
  });

  // Step 3: Escape HTML for prose
  processed = escapeHtml(processed);

  // Step 4: Headers (#, ##, ###, ####)
  processed = processed.replace(/^#{4,6}\s+(.+)$/gm, '<h5 class="prose-h5">$1</h5>');
  processed = processed.replace(/^#{3}\s+(.+)$/gm, '<h4 class="prose-h4">$1</h4>');
  processed = processed.replace(/^#{2}\s+(.+)$/gm, '<h4 class="prose-h4">$1</h4>');
  processed = processed.replace(/^#{1}\s+(.+)$/gm, '<h3 class="prose-h3">$1</h3>');

  // Step 5: Blockquotes (> quote)
  processed = processed.replace(/^>\s+(.+)$/gm, '<blockquote class="prose-quote">$1</blockquote>');

  // Step 6: Horizontal Rules (--- or ***)
  processed = processed.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr class="prose-hr"/>');

  // Step 7: Bold (**text** or __text__)
  processed = processed.replace(/\*\*([^*\r\n]+)\*\*/g, '<strong>$1</strong>');
  processed = processed.replace(/__([^_\\r\n]+)__/g, '<strong>$1</strong>');

  // Step 8: Italic (*text* or _text_)
  processed = processed.replace(/(?<!\*)\*([^*\r\n]+)\*(?!\*)/g, '<em>$1</em>');
  processed = processed.replace(/(?<!_)_([^_\\r\n]+)_(?!_)/g, '<em>$1</em>');

  // Step 9: Strikethrough (~~text~~)
  processed = processed.replace(/~~([^~\r\n]+)~~/g, '<del>$1</del>');

  // Step 10: Auto-detect code identifiers in plain text segments outside tags
  processed = highlightIdentifiersOutsideTags(processed);

  // Step 11: Unordered Lists (- or *)
  processed = processed.replace(/(?:^|\n)(?:[-*]\s+.+(?:\n[-*]\s+.+)*)/g, (match) => {
    const items = match.trim().split('\n').map(line => {
      const clean = line.replace(/^[-*]\s+/, '').trim();
      return `<li>${clean}</li>`;
    }).join('');
    return `\n<ul class="prose-ul">${items}</ul>\n`;
  });

  // Step 12: Ordered Lists (1. 2. 3.)
  processed = processed.replace(/(?:^|\n)(?:\d+\.\s+.+(?:\n\d+\.\s+.+)*)/g, (match) => {
    const items = match.trim().split('\n').map(line => {
      const clean = line.replace(/^\d+\.\s+/, '').trim();
      return `<li>${clean}</li>`;
    }).join('');
    return `\n<ol class="prose-ol">${items}</ol>\n`;
  });

  // Step 13: Split paragraphs by double newlines
  const blocks = processed.split(/\n\n+/).filter(b => b.trim().length > 0);
  const formattedBlocks = blocks.map(block => {
    const trimmed = block.trim();
    if (
      trimmed.startsWith('<h') ||
      trimmed.startsWith('<ul') ||
      trimmed.startsWith('<ol') ||
      trimmed.startsWith('<blockquote') ||
      trimmed.startsWith('<pre') ||
      trimmed.startsWith('<hr') ||
      trimmed.startsWith('\uE002')
    ) {
      return trimmed;
    }
    return `<p class="prose-p">${trimmed.replace(/\n/g, '<br/>')}</p>`;
  });

  let htmlResult = formattedBlocks.join('\n');

  // Step 14: Restore inline code placeholders
  htmlResult = htmlResult.replace(/\uE000(\d+)\uE001/g, (_m, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return inlineCodePlaceholders[idx] || '';
  });

  // Step 15: Restore code block placeholders
  htmlResult = htmlResult.replace(/\uE002(\d+)\uE003/g, (_m, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return codeBlockPlaceholders[idx] || '';
  });

  return htmlResult;
}
