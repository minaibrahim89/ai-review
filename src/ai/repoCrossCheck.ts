import * as path from 'path';
import * as fs from 'fs';
import { DiffFile } from '../diff/types';
import { FileDefenseContext, IssueCallout, RepoDefenseAnalysis, RepoDefenseItem, StoryNarrative } from './types';

/**
 * Service that cross-checks the repository and file context to discover existing
 * defenses (validation, error handling, auth guards) and filters out false-positive issues
 * that are already handled in the codebase.
 */
export class RepoCrossChecker {
  /**
   * Scans modified files and common workspace locations for existing defensive patterns:
   * imports, guards, try/catch blocks, schemas, and middleware.
   */
  public static gatherRepoDefenses(repoRoot: string, diffFiles: DiffFile[]): RepoDefenseAnalysis {
    const fileDefenses: FileDefenseContext[] = [];

    for (const file of diffFiles) {
      const relPath = file.newPath || file.oldPath;
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath);

      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const defense = this.analyzeFileContent(relPath, content);
          fileDefenses.push(defense);
        } catch {
          // ignore read error
        }
      }
    }

    const workspaceDefenses = this.discoverWorkspaceDefenses(repoRoot);
    const promptContext = this.buildPromptContext(fileDefenses, workspaceDefenses);

    return {
      fileDefenses,
      workspaceDefenses,
      promptContext,
    };
  }

  /**
   * Analyzes a single file's full content to extract existing imports, guards, and error handling.
   */
  public static analyzeFileContent(filePath: string, content: string): FileDefenseContext {
    const lines = content.split('\n');
    const imports: string[] = [];
    const existingGuards: string[] = [];
    let hasErrorHandling = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Collect imports
      if (line.startsWith('import ') || (line.includes('require(') && (line.startsWith('const ') || line.startsWith('let ')))) {
        imports.push(line.slice(0, 120));
      }

      // Check for error handling
      if (/\b(try\s*\{|\.catch\s*\(|catchAsync|errorHandler|withErrorHandling|handleError)\b/.test(line)) {
        hasErrorHandling = true;
      }

      // Collect explicit guards (null checks, validation calls, auth middleware)
      if (
        /(\bif\s*\(!|\?\?|\?\.|validate\(|\.parse\(|z\.object|joi\.|UseGuards|authMiddleware|requireAuth|check\()/.test(line)
      ) {
        if (existingGuards.length < 8) {
          existingGuards.push(`Line ${i + 1}: ${line.slice(0, 80)}`);
        }
      }
    }

    return {
      filePath,
      imports: imports.slice(0, 10),
      existingGuards,
      hasErrorHandling,
    };
  }

  /**
   * Discovers workspace-wide defensive layers like validation schemas, global error handlers, and auth guards.
   */
  public static discoverWorkspaceDefenses(repoRoot: string): RepoDefenseItem[] {
    const defenses: RepoDefenseItem[] = [];
    const searchDirs = ['src', 'lib', 'app', 'middleware', 'validators', 'utils'];

    const checkFile = (relPath: string, category: RepoDefenseItem['category'], desc: string) => {
      const full = path.join(repoRoot, relPath);
      if (fs.existsSync(full)) {
        defenses.push({
          category,
          filePath: relPath,
          description: desc,
        });
      }
    };

    // Validation modules
    checkFile('src/middleware/validate.ts', 'validation', 'Request schema validation middleware');
    checkFile('src/middleware/validation.ts', 'validation', 'Request validation middleware');
    checkFile('src/validators/index.ts', 'validation', 'Centralized input validation schemas');
    checkFile('src/schemas/index.ts', 'validation', 'Schema definitions & payload validators');

    // Error handling modules
    checkFile('src/middleware/errorHandler.ts', 'error-handling', 'Centralized global error handling middleware');
    checkFile('src/middleware/errors.ts', 'error-handling', 'Standardized exception handling middleware');
    checkFile('src/utils/catchAsync.ts', 'error-handling', 'Async route exception wrapper');

    // Security / Auth modules
    checkFile('src/middleware/auth.ts', 'security', 'Authentication & token verification middleware');
    checkFile('src/auth/jwt.ts', 'security', 'JWT token signing & expiration validation');
    checkFile('src/middleware/rateLimiter.ts', 'security', 'API rate limiting & DDoS protection');

    return defenses;
  }

  /**
   * Formats the discovered defenses into a strict LLM grounding instruction prompt block.
   */
  public static buildPromptContext(
    fileDefenses: FileDefenseContext[],
    workspaceDefenses: RepoDefenseItem[]
  ): string {
    if (fileDefenses.length === 0 && workspaceDefenses.length === 0) {
      return '';
    }

    let block = `\n--- REPOSITORY DEFENSES & SURROUNDING CONTEXT (CROSS-CHECK GROUNDING) ---\n` +
      `The codebase already implements the following surrounding code, imported utilities, and defense mechanisms:\n\n`;

    if (fileDefenses.length > 0) {
      block += `[Surrounding File Code & Imported Guards]\n`;
      for (const fd of fileDefenses.slice(0, 5)) {
        block += `• ${fd.filePath}:\n`;
        if (fd.imports.length > 0) {
          block += `  - Imports: ${fd.imports.slice(0, 4).join('; ')}\n`;
        }
        if (fd.existingGuards.length > 0) {
          block += `  - Existing guards in file: ${fd.existingGuards.slice(0, 3).join('; ')}\n`;
        }
        if (fd.hasErrorHandling) {
          block += `  - Error handling: Enclosed in or assisted by existing try/catch / error handler\n`;
        }
      }
      block += '\n';
    }

    if (workspaceDefenses.length > 0) {
      block += `[Workspace Defense Modules Detected]\n`;
      for (const wd of workspaceDefenses) {
        block += `• ${wd.category.toUpperCase()}: ${wd.filePath} (${wd.description})\n`;
      }
      block += '\n';
    }

    block += `CRITICAL CROSS-CHECK & ANTI-HALLUCINATION RULES:\n` +
      `1. DO NOT SUGGEST ISSUES ALREADY ADDRESSED: Before generating any warning, bug, or suggestion, cross-check whether the concern is already handled in surrounding code, imported modules, or workspace middleware.\n` +
      `2. SPECIFIC DEFENSE VERIFICATION:\n` +
      `   - If input validation, null checking, or schema parsing is handled by surrounding code or imported validators, DO NOT raise it as an issue.\n` +
      `   - If exceptions are caught by surrounding try/catch blocks, error middleware, or wrappers, DO NOT flag missing error handling.\n` +
      `   - If authentication, rate limiting, or permission checks are enforced at route or middleware levels, DO NOT flag missing auth.\n` +
      `3. GROUNDED EXPLANATIONS: In the narrative, acknowledge how the changes integrate with these existing defenses rather than inventing redundant concerns.\n` +
      `--- END REPOSITORY DEFENSES ---\n`;

    return block;
  }

  /**
   * Determines whether a candidate issue has already been addressed in the repository.
   */
  public static isIssueAlreadyAddressed(
    issue: IssueCallout,
    file: DiffFile,
    repoRoot?: string,
    fileDefense?: FileDefenseContext
  ): { addressed: boolean; reason?: string } {
    const textToCheck = `${issue.title} ${issue.description}`.toLowerCase();
    const relPath = (file.newPath || file.oldPath || '').toLowerCase();

    // 1. Check if issue is in a test file, mock, or fixture
    const isTestFile =
      relPath.includes('.test.') ||
      relPath.includes('.spec.') ||
      relPath.includes('__tests__') ||
      relPath.includes('/test/') ||
      relPath.includes('/fixtures/');

    // A. Debugging statements (console.log / debugger) in test files or scripts
    if (textToCheck.includes('debugging statement') || textToCheck.includes('console.log') || textToCheck.includes('debugger')) {
      if (isTestFile || relPath.startsWith('scripts/') || relPath.startsWith('bin/')) {
        return {
          addressed: true,
          reason: 'Console logging or test output is expected in test files and scripts.',
        };
      }
    }

    // B. Mock secrets in test files
    if (textToCheck.includes('hardcoded secret') || textToCheck.includes('api key') || textToCheck.includes('token credential')) {
      if (isTestFile || textToCheck.includes('dummy') || textToCheck.includes('mock') || textToCheck.includes('example')) {
        return {
          addressed: true,
          reason: 'Secret is a mock fixture in a test file.',
        };
      }
    }

    // If repoRoot is available, inspect the actual surrounding file lines on disk
    if (repoRoot && (file.newPath || file.oldPath)) {
      const fullPath = path.join(repoRoot, file.newPath || file.oldPath);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          const targetLine = issue.lineNumber || 1;

          // Extract a 40-line window around targetLine
          const start = Math.max(0, targetLine - 25);
          const end = Math.min(lines.length, targetLine + 25);
          const windowContent = lines.slice(start, end).join('\n');
          const fullFileLower = content.toLowerCase();

          // C. Error Handling / Unhandled Exceptions / JSON.parse
          const isErrorHandlingIssue =
            textToCheck.includes('error handling') ||
            textToCheck.includes('unhandled') ||
            textToCheck.includes('try/catch') ||
            textToCheck.includes('try catch') ||
            textToCheck.includes('json.parse') ||
            textToCheck.includes('syntaxerror') ||
            textToCheck.includes('exception');

          if (isErrorHandlingIssue) {
            // Check if window has try/catch or file has error wrappers
            const hasTryCatch = /try\s*\{[\s\S]*?\}\s*catch/.test(windowContent) || windowContent.includes('try {');
            const hasCatchAsync = fullFileLower.includes('catchasync') || fullFileLower.includes('witherror') || fullFileLower.includes('errorhandler');
            const hasPromiseCatch = windowContent.includes('.catch(');

            if (hasTryCatch || hasCatchAsync || hasPromiseCatch) {
              return {
                addressed: true,
                reason: 'Exceptions are already caught by enclosing try/catch block or error middleware.',
              };
            }
          }

          // D. Input Validation / Null Safety / Undefined Checks
          const isValidationIssue =
            textToCheck.includes('validation') ||
            textToCheck.includes('null check') ||
            textToCheck.includes('null pointer') ||
            textToCheck.includes('undefined') ||
            textToCheck.includes('sanitize') ||
            textToCheck.includes('schema parser');

          if (isValidationIssue) {
            // Check for surrounding guards: if (!x), ?. , ?? , zod parse, validate
            const hasNullGuard =
              windowContent.includes('?.') ||
              windowContent.includes('??') ||
              /\bif\s*\(!/.test(windowContent) ||
              /\btypeof\s+/.test(windowContent);
            const hasSchemaValidator =
              fullFileLower.includes('.parse(') ||
              fullFileLower.includes('validate(') ||
              fullFileLower.includes('zod') ||
              fullFileLower.includes('joi');

            if (hasNullGuard || hasSchemaValidator) {
              return {
                addressed: true,
                reason: 'Input validation or null safety is already enforced by surrounding checks or schema validators.',
              };
            }
          }

          // E. Authentication & Authorization Guards
          const isAuthIssue =
            textToCheck.includes('auth') ||
            textToCheck.includes('unprotected') ||
            textToCheck.includes('permission') ||
            textToCheck.includes('authorization');

          if (isAuthIssue) {
            const hasAuthGuard =
              fullFileLower.includes('@useguards') ||
              fullFileLower.includes('authmiddleware') ||
              fullFileLower.includes('requireauth') ||
              fullFileLower.includes('verifytoken') ||
              fullFileLower.includes('passport.authenticate');

            if (hasAuthGuard) {
              return {
                addressed: true,
                reason: 'Authentication and permission guards are already applied to this module or route.',
              };
            }
          }
        } catch {
          // ignore read error
        }
      }
    }

    return { addressed: false };
  }

  /**
   * Filters a list of issues for a file, eliminating false positives that are already handled.
   */
  public static verifyAndFilterIssues(
    issues: IssueCallout[],
    file: DiffFile,
    repoRoot?: string,
    fileDefense?: FileDefenseContext
  ): IssueCallout[] {
    const verified: IssueCallout[] = [];

    for (const issue of issues) {
      const check = this.isIssueAlreadyAddressed(issue, file, repoRoot, fileDefense);
      if (check.addressed) {
        console.log(
          `[RepoCrossCheck] Filtered addressed issue "${issue.title}" on ${file.newPath || file.oldPath}:${issue.lineNumber || '?'}: ${check.reason}`
        );
      } else {
        verified.push({
          ...issue,
          crossCheckVerified: true,
        });
      }
    }

    return verified;
  }

  /**
   * Cross-checks and verifies all issues across all chapters in a StoryNarrative.
   */
  public static verifyStoryIssues(
    story: StoryNarrative,
    diffFiles: DiffFile[],
    repoRoot?: string
  ): StoryNarrative {
    const fileMap = new Map(diffFiles.map(f => [f.newPath || f.oldPath, f]));

    for (const chapter of story.chapters) {
      const diffFile = fileMap.get(chapter.filePath);
      if (diffFile && chapter.issues && chapter.issues.length > 0) {
        chapter.issues = this.verifyAndFilterIssues(chapter.issues, diffFile, repoRoot);
      }
    }

    return story;
  }
}
