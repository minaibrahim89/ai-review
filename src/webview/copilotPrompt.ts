export interface CopilotIssueInfo {
  id?: string;
  title: string;
  description: string;
  severity: string;
  lineNumber?: number;
  suggestion?: string;
}

/**
 * Builds a structured, context-rich prompt for GitHub Copilot Chat
 * referencing the file, line number, issue title, description, and suggested fix.
 */
export function buildCopilotPrompt(filePath: string, issue: CopilotIssueInfo): string {
  const lineInfo = issue.lineNumber ? ` around line ${issue.lineNumber}` : '';
  const suggestionText = issue.suggestion ? `\n\nSuggested Fix:\n${issue.suggestion}` : '';

  return `Address this ${issue.severity.toUpperCase()} concern in ${filePath}${lineInfo}:

Issue: ${issue.title}
${issue.description}${suggestionText}

Please explain how to resolve this concern and provide the corrected code.`;
}
