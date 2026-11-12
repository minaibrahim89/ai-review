import * as path from 'path';
import { DiffFile } from '../diff/types';

export interface OrderedFileNode {
  file: DiffFile;
  layer: number;
  role: string;
  suggestedTitle: string;
  dependencies: string[]; // Paths of other changed files this file imports
}

export class OrderingEngine {
  /**
   * Sorts changed files into the optimal cognitive review sequence
   */
  public static orderFiles(files: DiffFile[]): OrderedFileNode[] {
    if (files.length <= 1) {
      return files.map(f => this.createNode(f, []));
    }

    // Step 1: Detect inter-file dependencies from diff content
    const changedPaths = new Set(files.map(f => this.normalizePath(f.newPath || f.oldPath)));
    const depMap = new Map<string, string[]>();

    for (const file of files) {
      const p = this.normalizePath(file.newPath || file.oldPath);
      const deps = this.extractImportedPaths(file, changedPaths);
      depMap.set(p, deps);
    }

    // Step 2: Create nodes with layer scores
    const nodes = files.map(f => {
      const p = this.normalizePath(f.newPath || f.oldPath);
      return this.createNode(f, depMap.get(p) || []);
    });

    // Step 3: Sort primarily by layer, secondarily by dependencies (topological tie-breaker), thirdly by path
    nodes.sort((a, b) => {
      // Primary: Semantic layer
      if (a.layer !== b.layer) {
        return a.layer - b.layer;
      }

      const pathA = this.normalizePath(a.file.newPath || a.file.oldPath);
      const pathB = this.normalizePath(b.file.newPath || b.file.oldPath);

      // If B depends on A, A must come before B!
      if (b.dependencies.includes(pathA)) {
        return -1;
      }
      if (a.dependencies.includes(pathB)) {
        return 1;
      }

      // Tie-breaker: stable alphabetical
      return pathA.localeCompare(pathB);
    });

    return nodes;
  }

  private static normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
  }

  private static extractImportedPaths(file: DiffFile, allChanged: Set<string>): string[] {
    const dependencies: string[] = [];
    const currentDir = path.dirname(this.normalizePath(file.newPath || file.oldPath));

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        // Match: from './...', import('./...'), require('./...')
        const importMatch = line.content.match(/(?:from\s+|require\(\s*|import\(\s*)['"](\.[^'"]+)['"]/i);
        if (importMatch) {
          const relativeImport = importMatch[1];
          const resolvedPath = path.posix.normalize(path.posix.join(currentDir, relativeImport)).toLowerCase();

          // Check if matches any changed file (accounting for file extensions)
          for (const changed of allChanged) {
            const changedWithoutExt = changed.replace(/\.[^/.]+$/, '');
            if (changed === resolvedPath || changedWithoutExt === resolvedPath) {
              if (!dependencies.includes(changed)) {
                dependencies.push(changed);
              }
            }
          }
        }
      }
    }

    return dependencies;
  }

  private static createNode(file: DiffFile, dependencies: string[]): OrderedFileNode {
    const filePath = file.newPath || file.oldPath;
    const { layer, role, suggestedTitle } = this.classifyFile(filePath, file);

    return {
      file,
      layer,
      role,
      suggestedTitle,
      dependencies,
    };
  }

  public static classifyFile(filePath: string, file?: DiffFile): { layer: number; role: string; suggestedTitle: string } {
    const lower = filePath.toLowerCase().replace(/\\/g, '/');
    const basename = path.basename(filePath);

    // 1. Data Contracts, Schemas, Migrations & Types
    if (
      lower.includes('schema') ||
      lower.includes('migration') ||
      lower.endsWith('.sql') ||
      lower.endsWith('.prisma') ||
      lower.includes('models/') ||
      lower.includes('entities/') ||
      lower.includes('types/') ||
      lower.endsWith('types.ts') ||
      lower.endsWith('interface.ts') ||
      lower.includes('/dto/') ||
      lower.endsWith('.proto')
    ) {
      return {
        layer: 10,
        role: 'Data Contract & Schema',
        suggestedTitle: `Foundations: ${basename}`,
      };
    }

    // 2. Core Business Logic & Domain Services
    if (
      lower.includes('services/') ||
      lower.includes('domain/') ||
      lower.includes('core/') ||
      lower.includes('logic/') ||
      lower.includes('usecases/') ||
      lower.includes('use-cases/') ||
      lower.endsWith('.service.ts') ||
      lower.endsWith('.service.js')
    ) {
      return {
        layer: 20,
        role: 'Core Business Logic',
        suggestedTitle: `Core Engine: ${basename}`,
      };
    }

    // 3. Repositories & Data Access / External Clients
    if (
      lower.includes('repositories/') ||
      lower.includes('repository/') ||
      lower.includes('dao/') ||
      lower.includes('clients/') ||
      lower.includes('adapters/') ||
      lower.includes('db/')
    ) {
      return {
        layer: 30,
        role: 'Data Access & Integration',
        suggestedTitle: `Data Pipeline: ${basename}`,
      };
    }

    // 4. API Endpoints, Controllers & Handlers
    if (
      lower.includes('controllers/') ||
      lower.includes('routes/') ||
      lower.includes('api/') ||
      lower.includes('handlers/') ||
      lower.includes('resolvers/') ||
      lower.endsWith('server.ts') ||
      lower.endsWith('app.ts')
    ) {
      return {
        layer: 40,
        role: 'API & Entrypoint',
        suggestedTitle: `Gateway: ${basename}`,
      };
    }

    // 5. Presentation, Views & UI Components
    if (
      lower.includes('components/') ||
      lower.includes('views/') ||
      lower.includes('pages/') ||
      lower.includes('screens/') ||
      lower.includes('styles/') ||
      lower.endsWith('.tsx') ||
      lower.endsWith('.jsx') ||
      lower.endsWith('.vue') ||
      lower.endsWith('.svelte') ||
      lower.endsWith('.css') ||
      lower.endsWith('.scss') ||
      lower.endsWith('.html')
    ) {
      return {
        layer: 50,
        role: 'User Interface & Presentation',
        suggestedTitle: `Interface: ${basename}`,
      };
    }

    // 6. Configuration & Infrastructure
    if (
      basename === 'package.json' ||
      basename === 'tsconfig.json' ||
      basename === 'dockerfile' ||
      lower.includes('.github/') ||
      lower.includes('docker-compose') ||
      lower.endsWith('.yml') ||
      lower.endsWith('.yaml') ||
      lower.endsWith('.env.example')
    ) {
      return {
        layer: 60,
        role: 'Configuration & Infrastructure',
        suggestedTitle: `System Config: ${basename}`,
      };
    }

    // 7. Tests & Verification
    if (
      lower.includes('test') ||
      lower.includes('spec') ||
      lower.endsWith('.test.ts') ||
      lower.endsWith('.spec.ts') ||
      lower.endsWith('.test.js') ||
      lower.endsWith('.spec.js')
    ) {
      return {
        layer: 70,
        role: 'Tests & Verification',
        suggestedTitle: `Verification: ${basename}`,
      };
    }

    // 8. Documentation
    if (lower.endsWith('.md') || lower.includes('docs/')) {
      return {
        layer: 80,
        role: 'Documentation',
        suggestedTitle: `Documentation: ${basename}`,
      };
    }

    // Default general code
    return {
      layer: 45,
      role: 'Application Code',
      suggestedTitle: `Changes: ${basename}`,
    };
  }
}
