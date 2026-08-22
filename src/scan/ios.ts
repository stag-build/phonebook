import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CoverageReport, ScannedComponent, ScannedPreview } from './types.js';
import { previewHints } from './hints.js';

/**
 * Regex-based heuristic scanner for SwiftUI `View` structs and `#Preview`
 * macros (plus legacy `PreviewProvider` structs). Walks the project tree and
 * matches previews to components by file + name heuristics.
 */
export async function scanIos(projectDir: string): Promise<CoverageReport> {
  const components: ScannedComponent[] = [];
  const orphanPreviews: ScannedPreview[] = [];

  const files = await walkSwiftFiles(projectDir);

  for (const file of files) {
    const relFile = relative(projectDir, file);
    const content = await readFile(file, 'utf8');

    const fileComponents = findViewStructs(content, relFile);
    const filePreviews = findPreviews(content, relFile);

    for (const comp of fileComponents) components.push(comp);
    matchPreviewsToComponents(filePreviews, fileComponents, orphanPreviews);
  }

  components.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  orphanPreviews.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    platform: 'ios',
    components,
    orphanPreviews,
    stats: computeStats(components, orphanPreviews),
  };
}

function findViewStructs(content: string, relFile: string): ScannedComponent[] {
  const results: ScannedComponent[] = [];
  const regex = /(?:struct|final class)\s+([A-Z]\w*)\s*:\s*[^{]*\bView\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    results.push({
      name: match[1],
      file: relFile,
      line: lineNumberAt(content, match.index),
      previews: [],
    });
  }
  return results;
}

function findPreviews(content: string, relFile: string): ScannedPreview[] {
  const results: ScannedPreview[] = [];

  // #Preview("Name", traits: ...) { ... }
  const previewRegex = /#Preview\s*(\(([^)]*)\))?/g;
  let match: RegExpExecArray | null;
  while ((match = previewRegex.exec(content)) !== null) {
    const argsText = match[2] ?? '';
    const nameMatch = argsText.match(/"([^"]*)"/);
    const displayName = nameMatch ? nameMatch[1] : undefined;

    const line = lineNumberAt(content, match.index);
    const dark = isDarkPreview(content, match.index, displayName);
    const annotationText = extractAnnotationText(content, match.index);
    const functionName = displayName ?? 'unnamed';
    const hints = previewHints({
      platform: 'ios',
      functionName,
      displayName,
      annotationText,
    });

    results.push({
      name: functionName,
      ...(displayName !== undefined ? { displayName } : {}),
      file: relFile,
      line,
      dark,
      annotationText,
      ...(hints.length > 0 ? { hints } : {}),
    });
  }

  // Legacy: struct X_Previews: PreviewProvider
  const legacyRegex = /struct\s+(\w+)_Previews\s*:\s*PreviewProvider/g;
  while ((match = legacyRegex.exec(content)) !== null) {
    results.push({
      name: `${match[1]}_Previews`,
      file: relFile,
      line: lineNumberAt(content, match.index),
      dark: false,
    });
  }

  return results;
}

/** True when the ~10 lines following a #Preview declaration set a dark color scheme. */
function isDarkPreview(content: string, matchIndex: number, displayName: string | undefined): boolean {
  if (displayName && displayName.endsWith('Dark')) return true;

  const rest = content.slice(matchIndex);
  const restLines = rest.split('\n');
  // Stop at the next #Preview / preview-provider struct so we don't bleed into it.
  const boundary = restLines.findIndex(
    (l, i) => i > 0 && (/#Preview\b/.test(l) || /:\s*PreviewProvider\b/.test(l)),
  );
  const window = boundary === -1 ? restLines.slice(0, 11) : restLines.slice(0, Math.min(11, boundary));
  return /\.preferredColorScheme\(\s*\.dark\s*\)/.test(window.join('\n'));
}

/** The #Preview(...) line plus the following lines of its body, up to the next
 * #Preview/PreviewProvider or ~15 lines, whichever comes first. */
function extractAnnotationText(content: string, matchIndex: number): string {
  const rest = content.slice(matchIndex);
  const restLines = rest.split('\n');
  const boundary = restLines.findIndex(
    (l, i) => i > 0 && (/#Preview\b/.test(l) || /:\s*PreviewProvider\b/.test(l)),
  );
  const cap = 15;
  const limit = boundary === -1 ? cap : Math.min(cap, boundary);
  return restLines.slice(0, limit).join('\n');
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Matches previews to components within the same file:
 * 1. A "Component/State" display name matches a component by name
 *    (case/space-insensitive).
 * 2. A legacy `X_Previews` preview matches component `X` directly.
 * 3. Otherwise: the single component in the file if there is exactly one,
 *    else the nearest component declared above the preview, else orphan.
 */
function matchPreviewsToComponents(
  previews: ScannedPreview[],
  components: ScannedComponent[],
  orphanPreviews: ScannedPreview[],
): void {
  for (const preview of previews) {
    let target: ScannedComponent | undefined;

    const legacyMatch = preview.name.match(/^(\w+)_Previews$/);
    if (legacyMatch) {
      target = components.find((c) => c.name === legacyMatch[1]);
    }

    if (!target && preview.displayName?.includes('/')) {
      const componentPart = preview.displayName.slice(0, preview.displayName.indexOf('/'));
      target = components.find((c) => normalize(c.name) === normalize(componentPart));
    }

    if (!target) {
      if (components.length === 1) {
        target = components[0];
      } else if (components.length > 1) {
        // Nearest component declared above the preview.
        const above = components.filter((c) => c.line <= preview.line);
        if (above.length > 0) {
          target = above.reduce((a, b) => (b.line > a.line ? b : a));
        }
      }
    }

    if (target) {
      target.previews.push(preview);
    } else {
      orphanPreviews.push(preview);
    }
  }
}

function normalize(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

function computeStats(components: ScannedComponent[], orphanPreviews: ScannedPreview[]) {
  const withPreview = components.filter((c) => c.previews.length > 0).length;
  const withDarkPreview = components.filter((c) => c.previews.some((p) => p.dark)).length;
  const totalPreviews =
    components.reduce((sum, c) => sum + c.previews.length, 0) + orphanPreviews.length;
  const allPreviews = [...components.flatMap((c) => c.previews), ...orphanPreviews];
  const hintCount = allPreviews.reduce((sum, p) => sum + (p.hints?.length ?? 0), 0);
  return {
    components: components.length,
    withPreview,
    withDarkPreview,
    totalPreviews,
    hintCount,
  };
}

const SKIP_DIRS = new Set(['build', '.build', 'DerivedData', 'Pods']);

async function walkSwiftFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.endsWith('.xcodeproj')) continue;
      if (entry.name.includes('Test')) continue;
      results.push(...(await walkSwiftFiles(join(dir, entry.name))));
    } else if (entry.isFile() && entry.name.endsWith('.swift')) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}
