import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CoverageReport, ScannedComponent, ScannedPreview } from './types.js';
import { previewHints } from './hints.js';
import { componentGaps, type ComponentProperty, type PropertyKind } from './gaps.js';

/**
 * Regex-based heuristic scanner for Jetpack Compose `@Composable` / `@Preview`
 * functions. Walks each module's `src/main` tree and matches previews to
 * components by file + name-prefix.
 */
export async function scanAndroid(projectDir: string, modules: string[]): Promise<CoverageReport> {
  const components: ScannedComponent[] = [];
  const orphanPreviews: ScannedPreview[] = [];
  const extraLocales = await detectLocales(projectDir, modules);
  const enumTypes = new Set<string>();

  for (const module of modules) {
    const moduleDir = join(projectDir, ...module.split(':').filter(Boolean));
    const srcRoot = join(moduleDir, 'src', 'main');
    const files = await walkKotlinFiles(srcRoot);

    for (const file of files) {
      const relFile = relative(projectDir, file);
      const content = await readFile(file, 'utf8');
      for (const enumName of findEnums(content)) enumTypes.add(enumName);

      const { fileComponents, filePreviews } = scanKotlinFile(content, relFile);

      for (const comp of fileComponents) components.push(comp);

      matchPreviewsToComponents(filePreviews, fileComponents, orphanPreviews);
    }
  }

  components.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  orphanPreviews.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  for (const component of components) {
    const gaps = componentGaps({
      platform: 'android',
      component: component.name,
      properties: component.properties ?? [],
      previewNames: component.previews.map((p) => p.displayName ?? p.name),
      hasDarkPreview: component.previews.some((p) => p.dark),
      previewText: component.previews.map((p) => p.annotationText ?? '').join('\n'),
      extraLocales,
      enumTypes: [...enumTypes],
    });
    if (gaps.length > 0) component.gaps = gaps;
  }

  return {
    platform: 'android',
    components,
    orphanPreviews,
    extraLocales,
    stats: computeStats(components, orphanPreviews),
  };
}

interface RawFunction {
  name: string;
  line: number;
  /** Text of the annotation block (all annotations) immediately above `fun`. */
  annotations: string;
  /** Index into the file content where the `fun` keyword starts. */
  funIndex: number;
}

function scanKotlinFile(
  content: string,
  relFile: string,
): { fileComponents: ScannedComponent[]; filePreviews: ScannedPreview[] } {
  const functions = findAnnotatedFunctions(content);

  const fileComponents: ScannedComponent[] = [];
  const filePreviews: ScannedPreview[] = [];
  const previewComposables: { fn: RawFunction; preview: ScannedPreview }[] = [];

  for (const fn of functions) {
    const isComposable = /@Composable\b/.test(fn.annotations);
    if (!isComposable) continue;

    const previewMatches = [...fn.annotations.matchAll(/@Preview\b(\([^)]*\))?/g)];
    if (previewMatches.length > 0) {
      // @Preview @Composable: either a wrapper preview of a separate component, or
      // a "self-preview" (a screen-level composable that previews itself via
      // default parameters). Decided below once all non-preview components in the
      // file are known.
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
      const bodyText = captureBodyText(content, fn.funIndex);
      const hints = previewHints({
        platform: 'android',
        functionName: fn.name,
        displayName,
        annotationText,
        bodyText,
      });

      previewComposables.push({
        fn,
        preview: {
          name: fn.name,
          ...(displayName ? { displayName } : {}),
          file: relFile,
          line: fn.line,
          dark,
          annotationText,
          ...(bodyText ? { bodyText } : {}),
          ...(hints.length > 0 ? { hints } : {}),
        },
      });
    } else {
      const properties = findParameters(content, fn.funIndex);
      fileComponents.push({
        name: fn.name,
        file: relFile,
        line: fn.line,
        previews: [],
        ...(properties.length > 0 ? { properties } : {}),
      });
    }
  }

  // Classify each @Preview-annotated composable: if its name matches an existing
  // non-preview component in this file by the prefix heuristic, it's a wrapper
  // preview of that component (existing behavior). Otherwise it's a self-preview:
  // the function is both a component and its own preview.
  for (const { fn, preview } of previewComposables) {
    const wrapperTarget = bestPrefixMatch(fn.name, fileComponents);
    if (wrapperTarget) {
      filePreviews.push(preview);
    } else {
      const properties = findParameters(content, fn.funIndex);
      fileComponents.push({
        name: fn.name,
        file: relFile,
        line: fn.line,
        previews: [preview],
        ...(properties.length > 0 ? { properties } : {}),
      });
    }
  }

  return { fileComponents, filePreviews };
}

/** Longest-name-prefix match, same heuristic as `matchPreviewsToComponents`. */
function bestPrefixMatch(name: string, components: ScannedComponent[]): ScannedComponent | undefined {
  let best: ScannedComponent | undefined;
  for (const comp of components) {
    if (name.startsWith(comp.name)) {
      if (!best || comp.name.length > best.name.length) best = comp;
    }
  }
  return best;
}

/**
 * Finds `fun Name(` declarations preceded by uppercase-first names, along with
 * the block of annotations (e.g. `@Composable`, `@Preview(...)`) found within
 * roughly 5 lines above the `fun` keyword.
 */
/**
 * Parameters of the composable whose `fun` keyword starts at `funIndex`.
 *
 * A composable's parameters are its states: a `Boolean` has two values, a
 * nullable can be absent, a `List` can be empty. `Modifier` is excluded because
 * it configures placement rather than describing a state.
 */
function findParameters(content: string, funIndex: number): ComponentProperty[] {
  const open = content.indexOf('(', funIndex);
  if (open === -1) return [];
  let depth = 0;
  let close = -1;
  const cap = Math.min(content.length, open + 4000);
  for (let i = open; i < cap; i++) {
    if (content[i] === '(') depth++;
    else if (content[i] === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];

  const properties: ComponentProperty[] = [];
  for (const raw of splitTopLevel(content.slice(open + 1, close))) {
    const match = raw.match(/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(\w+)\s*:\s*([^=]+)/);
    if (!match) continue;
    const name = match[1];
    const type = match[2].trim();
    if (type.startsWith('Modifier')) continue;
    properties.push({ name, type, kind: classifyKotlinType(type) });
  }
  return properties;
}

/** Enum type names declared in this file. */
function findEnums(content: string): string[] {
  const results: string[] = [];
  const regex = /\benum\s+class\s+([A-Z]\w*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) results.push(match[1]);
  return results;
}

/** Splits a parameter list on commas that are not inside brackets. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '<' || char === '(' || char === '[') depth++;
    else if (char === '>' || char === ')' || char === ']') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Types whose values are a spectrum rather than a set of states worth previewing. */
const SCALAR_TYPES = new Set([
  'String', 'Int', 'Long', 'Float', 'Double', 'Char', 'Dp', 'TextUnit', 'Color',
  'Any', 'Unit',
]);

function classifyKotlinType(type: string): PropertyKind {
  const bare = type.replace(/\s+/g, '');
  if (bare.endsWith('?')) return 'optional';
  if (/^(List|Set|Array|Collection|Iterable|Map)</.test(bare)) return 'collection';
  if (bare === 'Boolean') return 'bool';
  if (bare.includes('->')) return 'other';
  if (SCALAR_TYPES.has(bare)) return 'other';
  if (/^[A-Z]\w*$/.test(bare)) return 'enum-like';
  return 'other';
}

/**
 * Locales the project ships, from `res/values-<code>` resource directories.
 * The unqualified `values` directory is the default language, not a locale.
 */
async function detectLocales(projectDir: string, modules: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const module of modules) {
    const moduleDir = join(projectDir, ...module.split(':').filter(Boolean));
    const resDir = join(moduleDir, 'src', 'main', 'res');
    let entries;
    try {
      entries = await readdir(resDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^values-([a-z]{2}(?:-r[A-Z]{2})?)$/);
      if (match) found.add(match[1].replace('-r', '-'));
    }
  }
  return [...found].sort();
}

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

    results.push({ name, line, annotations, funIndex });
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

const BODY_LINE_CAP = 20;

/** Captures the preview function's body from its opening brace, capped to ~20 lines.
 * A simple line cap (no brace matching) -- good enough for hints to pattern-match against. */
function captureBodyText(content: string, funIndex: number): string | undefined {
  const braceIndex = content.indexOf('{', funIndex);
  if (braceIndex === -1) return undefined;
  const lines = content.slice(braceIndex).split('\n').slice(0, BODY_LINE_CAP);
  return lines.join('\n');
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
  const gapCount = components.reduce((sum, c) => sum + (c.gaps?.length ?? 0), 0);
  const componentsWithGaps = components.filter((c) =>
    (c.gaps ?? []).some((g) => g.severity === 'warning'),
  ).length;
  const selfPreviewed = components.filter((c) =>
    c.previews.some((p) => p.name === c.name && p.line === c.line),
  ).length;
  return {
    components: components.length,
    withPreview,
    withDarkPreview,
    totalPreviews,
    hintCount,
    gapCount,
    componentsWithGaps,
    selfPreviewed,
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
