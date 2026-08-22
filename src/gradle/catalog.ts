import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CatalogLibrary {
  alias: string;
  accessor: string;
  group: string;
  name: string;
  version?: string;
}

export interface CatalogPlugin {
  alias: string;
  accessor: string;
  id: string;
  version?: string;
}

export interface CatalogBundle {
  alias: string;
  accessor: string;
  /** Library aliases this bundle groups together. */
  members: string[];
}

export interface VersionCatalog {
  versions: Map<string, string>;
  libraries: CatalogLibrary[];
  plugins: CatalogPlugin[];
  bundles: CatalogBundle[];
}

/** Gradle configurations that reach the unit-test compile classpath. */
export const UNIT_TEST_CONFIGURATIONS = [
  'testImplementation',
  'testDebugImplementation',
  'testReleaseImplementation',
  'testApi',
  'testCompileOnly',
  'implementation',
  'api',
];

/** `alias-with-dashes_or_underscores` -> `<prefix>.alias.with.dashes.or.underscores`. */
export function accessorFor(alias: string, prefix = 'libs'): string {
  return `${prefix}.${alias.replace(/[-_]/g, '.')}`;
}

/** `alias-with-dashes` -> `<prefix>.plugins.alias.with.dashes`. */
export function pluginAccessorFor(alias: string, prefix = 'libs'): string {
  return `${prefix}.plugins.${alias.replace(/[-_]/g, '.')}`;
}

/** `alias-with-dashes` -> `<prefix>.bundles.alias.with.dashes`. */
export function bundleAccessorFor(alias: string, prefix = 'libs'): string {
  return `${prefix}.bundles.${alias.replace(/[-_]/g, '.')}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `accessor` appears in `text` as a whole token: not immediately
 * preceded or followed by an identifier character or `.` (so a longer
 * neighbouring accessor, e.g. `libs.androidx.compose.ui.test.junit4.something`,
 * doesn't falsely match a shorter one).
 */
export function accessorAppears(text: string, accessor: string): boolean {
  const re = new RegExp(`(?<![\\w.])${escapeRegExp(accessor)}(?![\\w.])`);
  return re.test(text);
}

/** Strips a `#` comment that isn't inside a quoted string. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inString = !inString;
    else if (c === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

/** Extracts `field = "value"` from an inline-table body. */
function extractString(body: string, field: string): string | undefined {
  const m = body.match(new RegExp(`\\b${field}\\s*=\\s*"([^"]*)"`));
  return m?.[1];
}

/** Extracts a version ref name from `version.ref = "x"` or `version = { ref = "x" }`. */
function extractVersionRef(body: string): string | undefined {
  const dotted = body.match(/\bversion\.ref\s*=\s*"([^"]*)"/);
  if (dotted) return dotted[1];
  const nested = body.match(/\bversion\s*=\s*\{[^}]*\bref\s*=\s*"([^"]*)"[^}]*\}/);
  if (nested) return nested[1];
  return undefined;
}

/** Extracts a literal `version = "x"` (not the `.ref` / nested-object forms). */
function extractVersionLiteral(body: string): string | undefined {
  const m = body.match(/\bversion\s*=\s*"([^"]*)"/);
  return m?.[1];
}

function resolveVersion(body: string, versions: Map<string, string>): string | undefined {
  const ref = extractVersionRef(body);
  if (ref !== undefined) return versions.get(ref);
  return extractVersionLiteral(body);
}

function parseLibraryEntry(
  alias: string,
  value: string,
  versions: Map<string, string>,
  prefix: string,
): CatalogLibrary | undefined {
  const accessor = accessorFor(alias, prefix);
  if (value.startsWith('"')) {
    const m = value.match(/^"([^"]*)"$/);
    if (!m) return undefined;
    const [group, name, version] = m[1].split(':');
    if (!group || !name) return undefined;
    return { alias, accessor, group, name, version };
  }
  if (value.startsWith('{')) {
    const module = extractString(value, 'module');
    let group = extractString(value, 'group');
    let name = extractString(value, 'name');
    if (module) {
      const idx = module.indexOf(':');
      if (idx !== -1) {
        group = module.slice(0, idx);
        name = module.slice(idx + 1);
      }
    }
    if (!group || !name) return undefined;
    return { alias, accessor, group, name, version: resolveVersion(value, versions) };
  }
  return undefined;
}

function parseBundleEntry(alias: string, value: string, prefix: string): CatalogBundle | undefined {
  const m = value.match(/^\[([\s\S]*)\]$/);
  if (!m) return undefined;
  const members = [...m[1].matchAll(/"([^"]*)"/g)].map((mm) => mm[1]);
  return { alias, accessor: bundleAccessorFor(alias, prefix), members };
}

function parsePluginEntry(
  alias: string,
  value: string,
  versions: Map<string, string>,
  prefix: string,
): CatalogPlugin | undefined {
  const accessor = pluginAccessorFor(alias, prefix);
  if (value.startsWith('"')) {
    const m = value.match(/^"([^"]*)"$/);
    if (!m) return undefined;
    const idx = m[1].lastIndexOf(':');
    if (idx === -1) return undefined;
    const id = m[1].slice(0, idx);
    const version = m[1].slice(idx + 1);
    if (!id) return undefined;
    return { alias, accessor, id, version };
  }
  if (value.startsWith('{')) {
    const id = extractString(value, 'id');
    if (!id) return undefined;
    return { alias, accessor, id, version: resolveVersion(value, versions) };
  }
  return undefined;
}

/**
 * Minimal parser for a Gradle version catalog TOML file: [versions],
 * [libraries], [plugins] sections. Handles the entry shapes documented on
 * CatalogLibrary/CatalogPlugin. Comments and blank lines are ignored;
 * malformed entries are skipped rather than throwing. `prefix` is the
 * catalog's Gradle accessor prefix ("libs" by default, or the name given to
 * `versionCatalogs { create("name") { ... } }` for a custom catalog).
 */
export function parseVersionCatalogText(toml: string, prefix = 'libs'): VersionCatalog {
  const versions = new Map<string, string>();
  const libraries: CatalogLibrary[] = [];
  const plugins: CatalogPlugin[] = [];
  const bundles: CatalogBundle[] = [];

  let section: 'versions' | 'libraries' | 'plugins' | 'bundles' | undefined;
  for (const rawLine of toml.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const sectionMatch = line.match(/^\[(versions|libraries|plugins|bundles)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] as 'versions' | 'libraries' | 'plugins' | 'bundles';
      continue;
    }
    if (!section) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;

    if (section === 'versions') {
      const m = value.match(/^"([^"]*)"$/);
      if (m) versions.set(key, m[1]);
      continue;
    }
    if (section === 'libraries') {
      const lib = parseLibraryEntry(key, value, versions, prefix);
      if (lib) libraries.push(lib);
      continue;
    }
    if (section === 'plugins') {
      const plugin = parsePluginEntry(key, value, versions, prefix);
      if (plugin) plugins.push(plugin);
      continue;
    }
    if (section === 'bundles') {
      const bundle = parseBundleEntry(key, value, prefix);
      if (bundle) bundles.push(bundle);
      continue;
    }
  }

  return { versions, libraries, plugins, bundles };
}

async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export interface CatalogDeclaration {
  /** The catalog's accessor prefix, e.g. "deps" for `libs.plugins.foo` -> `deps.plugins.foo`. */
  prefix: string;
  /** Path to the catalog's TOML file, relative to the project root. */
  tomlPath: string;
}

/**
 * Parses `settings.gradle(.kts)` for additional named version catalogs
 * declared via `versionCatalogs { create("name") { from(files("path")) } }`.
 * Does not include the default "libs" catalog (see loadVersionCatalog).
 */
export function parseCatalogDeclarations(settingsText: string): CatalogDeclaration[] {
  const results: CatalogDeclaration[] = [];
  const createRe = /create\(\s*"([^"]+)"\s*\)\s*\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(settingsText))) {
    const prefix = m[1];
    const body = m[2];
    const fromMatch = body.match(/from\(\s*files\(\s*"([^"]+)"\s*\)\s*\)/);
    const tomlPath = fromMatch?.[1] ?? `gradle/${prefix}.versions.toml`;
    results.push({ prefix, tomlPath });
  }
  return results;
}

/**
 * Loads every version catalog available to the project: the default
 * `gradle/libs.versions.toml` (prefix "libs") plus any custom catalogs
 * declared in settings.gradle(.kts) via `versionCatalogs { create(...) }`.
 * Returns a map keyed by accessor prefix; empty if none are present or
 * parseable.
 */
export async function loadVersionCatalog(projectDir: string): Promise<Map<string, VersionCatalog>> {
  const result = new Map<string, VersionCatalog>();

  const defaultText = await readTextOrUndefined(join(projectDir, 'gradle', 'libs.versions.toml'));
  if (defaultText !== undefined) {
    try {
      result.set('libs', parseVersionCatalogText(defaultText, 'libs'));
    } catch {
      // Unparseable; leave the default catalog absent.
    }
  }

  let settingsText: string | undefined;
  for (const rel of ['settings.gradle.kts', 'settings.gradle']) {
    settingsText = await readTextOrUndefined(join(projectDir, rel));
    if (settingsText !== undefined) break;
  }
  if (settingsText) {
    for (const decl of parseCatalogDeclarations(settingsText)) {
      if (result.has(decl.prefix)) continue;
      const text = await readTextOrUndefined(join(projectDir, decl.tomlPath));
      if (text === undefined) continue;
      try {
        result.set(decl.prefix, parseVersionCatalogText(text, decl.prefix));
      } catch {
        // Unparseable; skip this catalog.
      }
    }
  }

  return result;
}

export interface CoordinateLookup {
  found: boolean;
  version?: string;
  via: 'literal' | 'catalog' | 'wrong-configuration' | 'none';
  /**
   * Set when `via` is 'wrong-configuration': the Gradle configuration the
   * coordinate was actually found under (e.g. "androidTestImplementation"),
   * which doesn't reach the unit-test compile classpath.
   */
  foundConfiguration?: string;
}

export interface FindLibraryOptions {
  /**
   * When set, a match only counts as "found" if it's declared under one of
   * these Gradle configurations (e.g. testImplementation). A match under a
   * different configuration is reported as `via: 'wrong-configuration'`
   * rather than silently accepted or silently ignored. Omit to accept a
   * match under any configuration (original, configuration-blind behavior).
   */
  configurations?: string[];
}

type CatalogInput = VersionCatalog | VersionCatalog[] | undefined;

function toCatalogArray(catalog: CatalogInput): VersionCatalog[] {
  if (!catalog) return [];
  return Array.isArray(catalog) ? catalog : [catalog];
}

/**
 * Determines the Gradle configuration (e.g. "testImplementation",
 * "androidTestImplementation") whose declaration statement contains the
 * match starting at `matchIndex`, by walking back from the match to the
 * nearest identifier — handling both `config(coordinate)` and
 * `config "coordinate"` styles, and leading whitespace. Returns undefined
 * when no identifier immediately precedes the match (unrecognized style;
 * treated as unknown rather than guessed).
 */
function configurationForMatch(text: string, matchIndex: number): string | undefined {
  let searchEnd = matchIndex;
  for (let hops = 0; hops < 5; hops++) {
    const lineStart = text.lastIndexOf('\n', searchEnd - 1) + 1;
    let prefix = text.slice(lineStart, searchEnd).trimEnd();
    while (/[("',]$/.test(prefix)) {
      prefix = prefix.slice(0, -1).trimEnd();
    }
    if (prefix === '') {
      // Nothing useful on this line (e.g. the coordinate is on its own
      // line inside a multi-line statement) — hop to the end of the
      // previous line and keep looking for the configuration identifier.
      if (lineStart === 0) return undefined;
      searchEnd = lineStart - 1;
      continue;
    }
    const m = prefix.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    return m?.[1];
  }
  return undefined;
}

type ScanResult =
  | { kind: 'allowed'; version?: string }
  | { kind: 'disallowed'; version?: string; configuration: string }
  | { kind: 'none' };

/** Scans all matches of `regex` (must have the 'g' flag) against `text`, applying the configuration filter. */
function scan(text: string, regex: RegExp, configurations?: string[]): ScanResult {
  let disallowed: { version?: string; configuration: string } | undefined;
  for (const m of text.matchAll(regex)) {
    if (!configurations) return { kind: 'allowed', version: m[1] };
    const configuration = configurationForMatch(text, m.index!);
    if (configuration === undefined || configurations.includes(configuration)) {
      return { kind: 'allowed', version: m[1] };
    }
    if (!disallowed) disallowed = { version: m[1], configuration };
  }
  return disallowed ? { kind: 'disallowed', ...disallowed } : { kind: 'none' };
}

/**
 * Scans for a `group:name` coordinate in either its plain string form
 * (`"group:name[:version]"`, Kotlin or Groovy) or Groovy's map form
 * (`group: 'g', name: 'n'[, version: 'v']`).
 */
function scanLibraryLiteral(text: string, group: string, name: string, configurations?: string[]): ScanResult {
  const coordRe = new RegExp(`${escapeRegExp(`${group}:${name}`)}(?::([0-9][^"'\\s),]*))?`, 'g');
  const coordScan = scan(text, coordRe, configurations);
  if (coordScan.kind === 'allowed') return coordScan;

  const mapRe = new RegExp(
    `group:\\s*['"]${escapeRegExp(group)}['"]\\s*,\\s*name:\\s*['"]${escapeRegExp(name)}['"](?:\\s*,\\s*version:\\s*['"]([^'"]+)['"])?`,
    'g',
  );
  const mapScan = scan(text, mapRe, configurations);
  if (mapScan.kind === 'allowed') return mapScan;

  return coordScan.kind === 'disallowed' ? coordScan : mapScan;
}

/**
 * Looks up a `group:name` Maven coordinate in raw Gradle build-file text,
 * either as a literal coordinate string or, if a version catalog (or list of
 * catalogs) is supplied, via a `<prefix>.*` accessor that resolves to that
 * group:name. With `options.configurations` set, a match declared under a
 * configuration outside that list (e.g. androidTestImplementation when only
 * testImplementation etc. were requested) is reported as
 * `via: 'wrong-configuration'` instead of `found: true`.
 */
export function findLibrary(
  gradleText: string,
  catalog: CatalogInput,
  group: string,
  name: string,
  options: FindLibraryOptions = {},
): CoordinateLookup {
  const { configurations } = options;
  const literalScan = scanLibraryLiteral(gradleText, group, name, configurations);
  if (literalScan.kind === 'allowed') {
    return { found: true, version: literalScan.version, via: 'literal' };
  }

  let disallowed: { version?: string; configuration: string } | undefined =
    literalScan.kind === 'disallowed'
      ? { version: literalScan.version, configuration: literalScan.configuration }
      : undefined;

  for (const cat of toCatalogArray(catalog)) {
    for (const lib of cat.libraries) {
      if (lib.group !== group || lib.name !== name) continue;
      const accessorRe = new RegExp(`(?<![\\w.])${escapeRegExp(lib.accessor)}(?![\\w.])`, 'g');
      const catScan = scan(gradleText, accessorRe, configurations);
      if (catScan.kind === 'allowed') {
        return { found: true, version: lib.version, via: 'catalog' };
      }
      if (catScan.kind === 'disallowed' && !disallowed) {
        disallowed = { version: lib.version, configuration: catScan.configuration };
      }
    }

    for (const bundle of cat.bundles) {
      const memberLib = cat.libraries.find(
        (lib) => bundle.members.includes(lib.alias) && lib.group === group && lib.name === name,
      );
      if (!memberLib) continue;
      const accessorRe = new RegExp(`(?<![\\w.])${escapeRegExp(bundle.accessor)}(?![\\w.])`, 'g');
      const bundleScan = scan(gradleText, accessorRe, configurations);
      if (bundleScan.kind === 'allowed') {
        return { found: true, version: memberLib.version, via: 'catalog' };
      }
      if (bundleScan.kind === 'disallowed' && !disallowed) {
        disallowed = { version: memberLib.version, configuration: bundleScan.configuration };
      }
    }
  }

  if (disallowed) {
    return { found: false, via: 'wrong-configuration', version: disallowed.version, foundConfiguration: disallowed.configuration };
  }
  return { found: false, via: 'none' };
}

/**
 * Looks up a Gradle plugin id in raw build-file text: as `id("x")` /
 * `id 'x'` (optionally with `version "y"` on the same line), as the Gradle
 * plugin marker dependency coordinate (`pluginId:pluginId.gradle.plugin[:version]`),
 * or, if a version catalog (or list of catalogs) is supplied, via a
 * `<prefix>.plugins.*` accessor.
 */
export function findPlugin(gradleText: string, catalog: CatalogInput, pluginId: string): CoordinateLookup {
  const idEscaped = escapeRegExp(pluginId);
  const idPatterns = [
    new RegExp(`id\\(\\s*["']${idEscaped}["']\\s*\\)(?:\\s+version\\s+["']([^"']+)["'])?`),
    new RegExp(`id\\s+["']${idEscaped}["'](?:\\s+version\\s+["']([^"']+)["'])?`),
    // Legacy Groovy application: apply plugin: 'x.y.z' (no version on this form).
    new RegExp(`apply\\s+plugin:\\s*["']${idEscaped}["']`),
  ];
  for (const pattern of idPatterns) {
    const m = gradleText.match(pattern);
    if (m) return { found: true, version: m[1], via: 'literal' };
  }

  // buildscript { dependencies { classpath "<pluginId>:<artifact>:<version>" } }.
  // Matched on group only — the artifact (e.g. "roborazzi-gradle-plugin") doesn't
  // have to equal the plugin id.
  const classpathRe = new RegExp(`${idEscaped}:[A-Za-z0-9_.-]+(?::([0-9][^"'\\s),]*))?`);
  const classpathMatch = gradleText.match(classpathRe);
  if (classpathMatch) return { found: true, version: classpathMatch[1], via: 'literal' };

  for (const cat of toCatalogArray(catalog)) {
    for (const plugin of cat.plugins) {
      if (plugin.id === pluginId && accessorAppears(gradleText, plugin.accessor)) {
        return { found: true, version: plugin.version, via: 'catalog' };
      }
    }
  }

  return { found: false, via: 'none' };
}
