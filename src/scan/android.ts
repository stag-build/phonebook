import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CoverageReport, ScannedComponent, ScannedPreview } from './types.js';
import { previewHints } from './hints.js';

/**
 * Regex-based heuristic scanner for Jetpack Compose `@Composable` / `@Preview`
 * functions. Walks each module's `src/main` tree and matches previews to
 * components by file + name-prefix.
 */
export async function scanAndroid(projectDir: string, modules: string[]): Promise<CoverageReport> {
  const components: ScannedComponent[] = [];
  const orphanPreviews: ScannedPreview[] = [];

  for (const module of modules) {
    const moduleDir = join(projectDir, ...module.split(':').filter(Boolean));
    const srcRoot = join(moduleDir, 'src', 'main');
    const files = await walkKotlinFiles(srcRoot);

    for (const file of files) {
      const relFile = relative(projectDir, file);
      const content = await readFile(file, 'utf8');
      const { fileComponents, filePreviews } = scanKotlinFile(content, relFile);

      for (const comp of fileComponents) components.push(comp);

      matchPreviewsToComponents(filePreviews, fileComponents, orphanPreviews);
    }
  }

  components.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  orphanPreviews.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    platform: 'android',
    components,
    orphanPreviews,
    stats: computeStats(components, orphanPreviews),
  };
}

interface RawFunction {
  name: string;
  line: number;
  /** Text of the annotation block (all annotations) immediately above `fun`. */
  annotations: string;
}

function scanKotlinFile(
  content: string,
  relFile: string,
): { fileComponents: ScannedComponent[]; filePreviews: ScannedPreview[] } {
  const functions = findAnnotatedFunctions(content);

  const fileComponents: ScannedComponent[] = [];
  const filePreviews: ScannedPreview[] = [];

  for (const fn of functions) {
    const isComposable = /@Composable\b/.test(fn.annotations);
    if (!isComposable) continue;

    const previewMatches = [...fn.annotations.matchAll(/@Preview\b(\([^)]*\))?/g)];
    if (previewMatches.length > 0) {
      // Preview function: not itself a component.
      let displayName: string | undefined;
      let dark = false;
      for (const m of previewMatches) {
        const args = m[1] ?? '';
        const nameMatch = args.match(/name\s*=\s*"([^"]*)"/);
        if (nameMatch && !displayName) displayName = nameMatch[1];
        if (/UI_MODE_NIGHT_YES/.test(args)) dark = true;
      }
      if (/(Dark|Night)$/.test(fn.name)) dark = true;

      const annotationText = previewMatches.map((m) => m[0]).join('\n');
      const hints = previewHints({
        platform: 'android',
        functionName: fn.name,
        displayName,
        annotationText,
      });

      filePreviews.push({
        name: fn.name,
        ...(displayName ? { displayName } : {}),
        file: relFile,
        line: fn.line,
        dark,
        annotationText,
        ...(hints.length > 0 ? { hints } : {}),
      });
    } else {
      fileComponents.push({
        name: fn.name,
        file: relFile,
        line: fn.line,
        previews: [],
      });
    }
  }

  return { fileComponents, filePreviews };
}

/**
 * Finds `fun Name(` declarations preceded by uppercase-first names, along with
 * the block of annotations (e.g. `@Composable`, `@Preview(...)`) found within
 * roughly 5 lines above the `fun` keyword.
 */
function findAnnotatedFunctions(content: string): RawFunction[] {
  const results: RawFunction[] = [];
  const funRegex = /\bfun\s+([A-Z]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = funRegex.exec(content)) !== null) {
    const name = match[1];
    const funIndex = match.index;
    const line = lineNumberAt(content, funIndex);

    // Look back up to 5 lines above the `fun` line for annotations.
    const linesBefore = content.slice(0, funIndex).split('\n');
    const contextLines = linesBefore.slice(Math.max(0, linesBefore.length - 6));
    const annotations = contextLines.join('\n');

    results.push({ name, line, annotations });
  }
  return results;
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Matches previews to components using: same file + preview name starts with
 * component name (longest component-name match wins). Unmatched previews are
 * pushed to `orphanPreviews`.
 */
function matchPreviewsToComponents(
  previews: ScannedPreview[],
  components: ScannedComponent[],
  orphanPreviews: ScannedPreview[],
): void {
  for (const preview of previews) {
    let best: ScannedComponent | undefined;
    for (const comp of components) {
      if (preview.name.startsWith(comp.name)) {
        if (!best || comp.name.length > best.name.length) best = comp;
      }
    }
    if (best) {
      best.previews.push(preview);
    } else {
      orphanPreviews.push(preview);
    }
  }
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

async function walkKotlinFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'build') continue;
      results.push(...(await walkKotlinFiles(join(dir, entry.name))));
    } else if (entry.isFile() && entry.name.endsWith('.kt')) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}
