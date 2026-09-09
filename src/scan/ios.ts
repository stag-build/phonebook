import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CoverageReport, ScannedComponent, ScannedPreview } from './types.js';
import { previewHints } from './hints.js';
import { componentGaps, type ComponentProperty, type PropertyKind } from './gaps.js';
import { computeStats } from './stats.js';

/**
 * Regex-based heuristic scanner for SwiftUI `View` structs and `#Preview`
 * macros (plus legacy `PreviewProvider` structs). Walks the project tree and
 * matches previews to components by file + name heuristics.
 */
export async function scanIos(projectDir: string): Promise<CoverageReport> {
  const components: ScannedComponent[] = [];
  const orphanPreviews: ScannedPreview[] = [];

  const files = await walkSwiftFiles(projectDir);
  const extraLocales = await detectLocales(projectDir);
  const enumTypes = new Set<string>();
  // Project-wide: a preview calls `withPreviewsEnv()` in one module and the
  // function that says what that supplies lives in another, so this cannot be
  // resolved a file at a time.
  const envHelpers = new Map<string, string>();

  for (const file of files) {
    const relFile = relative(projectDir, file);
    const content = await readFile(file, 'utf8');

    for (const enumName of findEnums(content)) enumTypes.add(enumName);
    for (const [name, provided] of findEnvironmentHelpers(content)) envHelpers.set(name, provided);

    const fileComponents = findViewStructs(content, relFile);
    const filePreviews = findPreviews(content, relFile);

    for (const comp of fileComponents) components.push(comp);
    matchPreviewsToComponents(filePreviews, fileComponents, orphanPreviews);
  }

  components.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  orphanPreviews.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  for (const component of components) {
    const gaps = componentGaps({
      platform: 'ios',
      component: component.name,
      properties: component.properties ?? [],
      previewNames: component.previews.map((p) => p.displayName ?? p.name),
      hasDarkPreview: component.previews.some((p) => p.dark),
      previewText: component.previews.map((p) => p.annotationText ?? '').join('\n'),
      extraLocales,
      enumTypes: [...enumTypes],
      ...(component.environmentTypes ? { environmentTypes: component.environmentTypes } : {}),
      environmentProvided: environmentProvided(
        component.previews.map((p) => p.annotationText ?? '').join('\n'),
        envHelpers,
      ),
    });
    if (gaps.length > 0) component.gaps = gaps;
  }

  return {
    platform: 'ios',
    components,
    orphanPreviews,
    extraLocales,
    stats: computeStats(components, orphanPreviews),
  };
}

function findViewStructs(content: string, relFile: string): ScannedComponent[] {
  const results: ScannedComponent[] = [];
  const regex = /(?:struct|final class)\s+([A-Z]\w*)\s*:\s*[^{]*\bView\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const body = structBody(content, regex.lastIndex);
    const properties = findStoredProperties(body);
    const environmentTypes = findEnvironmentReads(body);
    results.push({
      name: match[1],
      file: relFile,
      line: lineNumberAt(content, match.index),
      previews: [],
      ...(properties.length > 0 ? { properties } : {}),
      ...(environmentTypes.length > 0 ? { environmentTypes } : {}),
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
    const annotationText = previewSource(content, match.index, match.index + match[0].length);
    const dark = isDarkPreview(annotationText, displayName);
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
    // Read the struct, same as a #Preview body. Reporting nothing here made a
    // legacy preview look like it declared nothing: never dark, and supplying
    // no environment object it in fact supplies — two false alarms on the
    // oldest previews in a project, which are the ones least likely to be wrong.
    const source = `${match[0]} {${structBody(content, legacyRegex.lastIndex)}}`;
    results.push({
      name: `${match[1]}_Previews`,
      file: relFile,
      line: lineNumberAt(content, match.index),
      dark: isDarkPreview(source, undefined),
      annotationText: source,
    });
  }

  return results;
}

/** True when a preview declares a dark colour scheme, by name or by modifier. */
function isDarkPreview(source: string, displayName: string | undefined): boolean {
  if (displayName && displayName.endsWith('Dark')) return true;
  return /\.preferredColorScheme\(\s*\.dark\s*\)/.test(source);
}

/**
 * The `#Preview(...)` declaration together with its body, from the macro to the
 * brace that closes it.
 *
 * Reading a fixed number of lines instead — the 15-line window this replaces,
 * and the 11-line one dark detection used — truncates exactly the previews
 * worth reading. A long body pushes the modifiers that carry the configuration
 * past the cap, so a preview that declares `.preferredColorScheme(.dark)` is
 * reported as not declaring it. Seen on IceCubesApp: a 17-line preview flagged
 * for a modifier written on its line 16, in a report that called that same
 * preview dark — because the two checks read two different windows.
 *
 * Balancing braces has neither failure mode. It ends where the preview ends, so
 * it can no more truncate a long body than bleed into the next declaration, and
 * one reading now serves every check. `cap` is runaway protection for a file
 * whose braces never balance — an unterminated string literal, most likely —
 * not a window: a preview that reaches it is already unparseable.
 */
function previewSource(content: string, matchIndex: number, bodyFrom: number): string {
  const cap = Math.min(content.length, matchIndex + 8000);
  const open = content.indexOf('{', bodyFrom);
  if (open === -1 || open >= cap) return content.slice(matchIndex, cap);

  let depth = 0;
  for (let i = open; i < cap; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(matchIndex, i + 1);
    }
  }
  return content.slice(matchIndex, cap);
}

/**
 * Stored properties of a struct, given its body.
 *
 * Only the declaration line matters, so this reads lines rather than parsing
 * Swift: a stored property is `let`/`var name: Type`, optionally preceded by
 * property wrappers and an access modifier. `var body: some View` is the one
 * that always appears and never describes a state, and a `var` with a `{`
 * before any `=` is computed, so both are skipped.
 */
function findStoredProperties(body: string): ComponentProperty[] {
  const properties: ComponentProperty[] = [];
  const declaration =
    /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:private|fileprivate|internal|public|package)\s+)?(?:let|var)\s+(\w+)\s*:\s*([^={\n]+)/;

  for (const line of body.split('\n')) {
    const match = line.match(declaration);
    if (!match) continue;
    const name = match[1];
    const type = match[2].trim();
    if (name === 'body') continue;
    // Computed: a brace opens before any assignment.
    const rest = line.slice(line.indexOf(type) + type.length);
    if (rest.includes('{') && !rest.includes('=')) continue;
    properties.push({ name, type, kind: classifyType(type) });
  }
  return properties;
}

/**
 * Types the struct reads out of the environment by type — `@Environment(X.self)`.
 *
 * The keypath form, `@Environment(\\.openURL)`, is deliberately not matched: it
 * reads a value SwiftUI always provides, so it can never be the missing thing.
 * Only an object looked up by its own type can be absent, and when it is, the
 * read traps.
 */
function findEnvironmentReads(body: string): string[] {
  const found = new Set<string>();
  const regex = /@Environment\(\s*([A-Z]\w*)\.self\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) found.add(match[1]);
  return [...found];
}

/**
 * What each `-> some View` helper in this file supplies to the environment,
 * keyed by function name.
 *
 * A preview that calls `withPreviewsEnv()` supplies everything that function
 * supplies, and the preview's own text names none of it. Without this the rule
 * would flag every component in a project that has such a helper — which is
 * every project that has more than a handful of previews.
 */
function findEnvironmentHelpers(content: string): Map<string, string> {
  const helpers = new Map<string, string>();
  const regex = /func\s+(\w+)\s*\([^)]*\)\s*->\s*some\s+View/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    helpers.set(match[1], environmentArguments(structBody(content, regex.lastIndex)));
  }
  return helpers;
}

/** Everything the previews supply, directly or through a helper they call. */
function environmentProvided(previewText: string, helpers: Map<string, string>): string {
  const parts = [environmentArguments(previewText)];
  for (const [name, provided] of helpers) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(previewText)) parts.push(provided);
  }
  return parts.join('\n');
}

/**
 * The arguments of every `.environment(...)` call in some source, concatenated.
 *
 * Kept as text rather than resolved to type names because the value passed is
 * rarely the type itself: `.environment(StatusDataControllerProvider.shared
 * .dataController(for:client:))` supplies a StatusDataController and never
 * writes that name as the head of the expression. Matching on the text covers
 * both spellings, and its failure mode is silence rather than a false alarm.
 *
 * The leading dot is optional because a helper written as an extension on View
 * calls the first one on itself — `environment(CurrentAccount.shared)` — and
 * only chains the rest. Requiring the dot loses whatever the first call
 * supplies, which is the one a project's preview helper opens with.
 */
function environmentArguments(source: string): string {
  const parts: string[] = [];
  const regex = /\benvironment\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    parts.push(balancedArgument(source, regex.lastIndex - 1));
  }
  return parts.join('\n');
}

/** The text inside the parenthesis opening at `openIndex`, to its match. */
function balancedArgument(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return source.slice(openIndex + 1);
}

/** Enum type names declared in this file, including indirect and raw-value enums. */
function findEnums(content: string): string[] {
  const results: string[] = [];
  const regex = /(?:^|\n)\s*(?:public\s+|internal\s+|private\s+|fileprivate\s+|package\s+)?(?:indirect\s+)?enum\s+([A-Z]\w*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) results.push(match[1]);
  return results;
}

/** The text between the struct's opening brace and its matching close, capped. */
function structBody(content: string, from: number): string {
  const open = content.indexOf('{', from);
  if (open === -1) return '';
  let depth = 0;
  const cap = Math.min(content.length, open + 8000);
  for (let i = open; i < cap; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(open + 1, i);
    }
  }
  return content.slice(open + 1, cap);
}

/** Types whose values are a spectrum rather than a set of states worth previewing. */
const SCALAR_TYPES = new Set([
  'String', 'Int', 'Double', 'Float', 'CGFloat', 'Date', 'URL', 'UUID', 'Data',
  'Color', 'Font', 'Image', 'Text', 'TimeInterval', 'Any', 'AnyView',
]);

function classifyType(type: string): PropertyKind {
  const bare = type.replace(/\s+/g, '');
  if (bare.endsWith('?') || bare.startsWith('Optional<')) return 'optional';
  if (bare.startsWith('[') || bare.startsWith('Set<') || bare.startsWith('Array<')) return 'collection';
  if (bare === 'Bool') return 'bool';
  if (SCALAR_TYPES.has(bare)) return 'other';
  // A capitalized type of the project's own is the shape an enum takes; the
  // agent reads it to find out whether it actually is one.
  if (/^[A-Z]\w*$/.test(bare)) return 'enum-like';
  return 'other';
}

/**
 * Locales the project ships beyond its development language, from `.lproj`
 * directories and String Catalog localizations. "Base" is not a locale.
 */
async function detectLocales(projectDir: string): Promise<string[]> {
  const found = new Set<string>();
  const developmentRegion = await readDevelopmentRegion(projectDir);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.endsWith('.lproj')) {
          const code = entry.name.slice(0, -'.lproj'.length);
          if (code !== 'Base') found.add(code);
          continue;
        }
        await walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.xcstrings')) {
        try {
          const catalogue = JSON.parse(await readFile(join(dir, entry.name), 'utf8')) as {
            sourceLanguage?: string;
            strings?: Record<string, { localizations?: Record<string, unknown> }>;
          };
          const source = catalogue.sourceLanguage;
          for (const entryValue of Object.values(catalogue.strings ?? {})) {
            for (const code of Object.keys(entryValue.localizations ?? {})) {
              if (code !== source) found.add(code);
            }
          }
        } catch {
          // A catalogue we cannot read tells us nothing; it is not an error.
        }
      }
    }
  }

  await walk(projectDir, 0);
  if (developmentRegion) found.delete(developmentRegion);
  return [...found].sort();
}

/**
 * The project's development language, which is not a localization of itself.
 * Xcode records it as `developmentRegion` in the project file.
 */
async function readDevelopmentRegion(projectDir: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.xcodeproj')) continue;
    try {
      const pbxproj = await readFile(join(projectDir, entry.name, 'project.pbxproj'), 'utf8');
      const match = pbxproj.match(/developmentRegion\s*=\s*(\w+)/);
      if (match) return match[1];
    } catch {
      // No readable project file: fall through and report every locale found.
    }
  }
  return undefined;
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
