import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export interface KotlinVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parses a "X.Y[.Z]" version string. */
export function parseKotlinVersion(s: string): KotlinVersion | undefined {
  const m = s.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] !== undefined ? Number(m[3]) : 0 };
}

async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Patterns for the Kotlin plugin version in a Gradle build/settings file, in the
 * forms observed in real projects (Kotlin DSL and Groovy DSL alike). The first
 * pattern that matches wins.
 */
const GRADLE_KOTLIN_PATTERNS: RegExp[] = [
  /kotlin\(\s*["']android["']\s*\)\s+version\s+["']([0-9][0-9.]*)["']/,
  /id\(\s*["']org\.jetbrains\.kotlin\.android["']\s*\)\s+version\s+["']([0-9][0-9.]*)["']/,
  /id\s+["']org\.jetbrains\.kotlin\.android["']\s+version\s+["']([0-9][0-9.]*)["']/,
  /ext\.kotlin_version\s*=\s*["']([0-9][0-9.]*)["']/,
  /(?<!ext\.)\bkotlin_version\s*=\s*["']([0-9][0-9.]*)["']/,
];

async function detectFromGradleFile(path: string): Promise<KotlinVersion | undefined> {
  const text = await readTextOrUndefined(path);
  if (!text) return undefined;
  for (const pattern of GRADLE_KOTLIN_PATTERNS) {
    const m = text.match(pattern);
    if (m) return parseKotlinVersion(m[1]);
  }
  return undefined;
}

async function detectFromVersionCatalog(path: string): Promise<KotlinVersion | undefined> {
  const text = await readTextOrUndefined(path);
  if (!text) return undefined;
  const section = text.match(/\[versions\]([\s\S]*?)(?:\n\[|$)/);
  const body = section ? section[1] : text;
  // Matches "kotlin = "X.Y.Z"" as well as "kotlin-something = "X.Y.Z"" (aliases
  // used by e.g. `libs.plugins.kotlin.android`), but not "kotlinx-..." keys.
  const m = body.match(/^\s*kotlin(?:[-_][A-Za-z0-9_-]*)?\s*=\s*"([0-9]+\.[0-9]+(?:\.[0-9]+)?)"/m);
  if (!m) return undefined;
  return parseKotlinVersion(m[1]);
}

/**
 * Detects the project's Kotlin (compiler) version by searching, in order:
 * gradle/libs.versions.toml, root build.gradle.kts/build.gradle, and
 * settings.gradle.kts/settings.gradle (pluginManagement plugins block).
 * Returns the first hit, with `source` set to the file it came from
 * (relative to `projectDir`).
 */
export async function detectKotlinVersion(
  projectDir: string,
): Promise<{ version: KotlinVersion; source: string } | undefined> {
  const tomlRel = join('gradle', 'libs.versions.toml');
  const tomlVersion = await detectFromVersionCatalog(join(projectDir, tomlRel));
  if (tomlVersion) return { version: tomlVersion, source: tomlRel };

  for (const rel of ['build.gradle.kts', 'build.gradle']) {
    const version = await detectFromGradleFile(join(projectDir, rel));
    if (version) return { version, source: rel };
  }

  for (const rel of ['settings.gradle.kts', 'settings.gradle']) {
    const version = await detectFromGradleFile(join(projectDir, rel));
    if (version) return { version, source: rel };
  }

  return undefined;
}

/**
 * Whether a Kotlin compiler `K.M.*` can read metadata written by a compiler
 * whose binary metadata version is `(a, b[, c])`: (a, b) <= (K, M+1).
 * Special case: metadata (1, 9, 9999) means "pinned to language version 1.9"
 * and is readable by any compiler >= 1.9.
 */
export function canRead(compiler: { major: number; minor: number }, metadata: [number, number, number?]): boolean {
  const [a, b, c] = metadata;
  if (a === 1 && b === 9 && c === 9999) {
    return compiler.major > 1 || (compiler.major === 1 && compiler.minor >= 9);
  }
  if (a !== compiler.major) return a < compiler.major;
  return b <= compiler.minor + 1;
}

// ---------------------------------------------------------------------------
// Minimal zip reading (no new dependencies): parse the End Of Central
// Directory + central directory to locate an entry, then inflate it.
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;

/** Finds and decompresses a single zip entry whose name satisfies `matches`. */
export function readZipEntry(buf: Buffer, matches: (name: string) => boolean): Buffer | undefined {
  const maxCommentLen = 65535;
  const searchStart = Math.max(0, buf.length - 22 - maxCommentLen);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (i >= 0 && buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return undefined;

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > buf.length) return undefined;
    if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) return undefined;

    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (matches(name)) {
      const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compData = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(compData);
      if (method === 8) return inflateRawSync(compData);
      return undefined;
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

/**
 * Parses a `META-INF/*.kotlin_module` file: a big-endian int32 entry count N,
 * followed by N big-endian int32s making up the metadata version, e.g. (2,3,0).
 */
function parseKotlinModuleMetadata(buf: Buffer): [number, number, number] | undefined {
  if (buf.length < 4) return undefined;
  const n = buf.readInt32BE(0);
  if (n <= 0 || buf.length < 4 + n * 4) return undefined;
  const nums: number[] = [];
  for (let i = 0; i < n; i++) nums.push(buf.readInt32BE(4 + i * 4));
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

async function fetchWithTimeout(url: string, ms = 15000): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function mavenGroupPath(group: string): string {
  return group.replace(/\./g, '/');
}

const metadataCache = new Map<string, [number, number, number] | undefined>();

/**
 * Fetches an artifact's real Kotlin metadata version straight from its
 * bytecode (not its POM, which can lie): tries the .aar first (containing
 * classes.jar), falling back to a plain .jar on 404.
 */
export async function fetchKotlinMetadataVersion(
  group: string,
  artifact: string,
  version: string,
): Promise<[number, number, number] | undefined> {
  const key = `${group}:${artifact}:${version}`;
  if (metadataCache.has(key)) return metadataCache.get(key);
  const result = await fetchKotlinMetadataVersionUncached(group, artifact, version);
  metadataCache.set(key, result);
  return result;
}

async function fetchKotlinMetadataVersionUncached(
  group: string,
  artifact: string,
  version: string,
): Promise<[number, number, number] | undefined> {
  const base = `https://repo1.maven.org/maven2/${mavenGroupPath(group)}/${artifact}/${version}/${artifact}-${version}`;

  const aarRes = await fetchWithTimeout(`${base}.aar`);
  if (aarRes && aarRes.ok) {
    const aarBuf = Buffer.from(await aarRes.arrayBuffer());
    const classesJar = readZipEntry(aarBuf, (name) => name === 'classes.jar');
    if (!classesJar) return undefined;
    return extractKotlinModuleMetadata(classesJar);
  }

  const jarRes = await fetchWithTimeout(`${base}.jar`);
  if (!jarRes || !jarRes.ok) return undefined;
  const jarBuf = Buffer.from(await jarRes.arrayBuffer());
  return extractKotlinModuleMetadata(jarBuf);
}

function extractKotlinModuleMetadata(jarBuf: Buffer): [number, number, number] | undefined {
  const entry = readZipEntry(
    jarBuf,
    (name) => name.startsWith('META-INF/') && name.endsWith('.kotlin_module'),
  );
  if (!entry) return undefined;
  return parseKotlinModuleMetadata(entry);
}

const versionsCache = new Map<string, string[]>();

/** Lists released (non-alpha/rc) versions of a Maven artifact, oldest first. */
export async function listMavenVersions(group: string, artifact: string): Promise<string[]> {
  const key = `${group}:${artifact}`;
  const cached = versionsCache.get(key);
  if (cached) return cached;

  const url = `https://repo1.maven.org/maven2/${mavenGroupPath(group)}/${artifact}/maven-metadata.xml`;
  const res = await fetchWithTimeout(url);
  let versions: string[] = [];
  if (res && res.ok) {
    const text = await res.text();
    versions = [...text.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((m) => m[1])
      .filter((v) => !v.includes('-'));
  }
  versionsCache.set(key, versions);
  return versions;
}

interface FallbackRange {
  /** Inclusive [low, high] version range this metadata applies to. */
  range: [string, string];
  metadata: [number, number, number];
}

/**
 * Known Kotlin-metadata ranges, probed empirically on 2026-08-22 by fetching
 * each artifact's real bytecode (its POM understates Kotlin requirements).
 * Used to skip network probes in resolveMaxCompatible, and as a last resort
 * when the network is unavailable.
 */
export const FALLBACK: Record<string, FallbackRange[]> = {
  'io.github.takahirom.roborazzi:roborazzi': [
    { range: ['1.61.0', '1.72.0'], metadata: [2, 3, 0] },
    { range: ['1.50.0', '1.60.0'], metadata: [1, 9, 9999] },
    { range: ['1.44.0', '1.46.1'], metadata: [1, 9, 0] },
  ],
  'io.github.sergio-sastre.ComposablePreviewScanner:android': [
    // Probed 2026-08-22: android-0.9.3.jar has no .aar (pure JVM artifact);
    // META-INF/android.kotlin_module = (1, 9, 9999) — pinned to language
    // version 1.9, readable by any Kotlin compiler >= 1.9.
    { range: ['0.9.3', '0.9.3'], metadata: [1, 9, 9999] },
  ],
};

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Looks up an artifact version's Kotlin metadata in the FALLBACK table, if known. */
export function lookupFallbackMetadata(
  group: string,
  artifact: string,
  version: string,
): [number, number, number] | undefined {
  const entries = FALLBACK[`${group}:${artifact}`];
  if (!entries) return undefined;
  for (const entry of entries) {
    if (compareVersions(version, entry.range[0]) >= 0 && compareVersions(version, entry.range[1]) <= 0) {
      return entry.metadata;
    }
  }
  return undefined;
}

function needsKotlinLabel(metadata: [number, number, number]): string {
  const [a, b, c] = metadata;
  if (a === 1 && b === 9 && c === 9999) return '1.9';
  return `${a}.${Math.max(0, b - 1)}`;
}

export interface ResolveResult {
  /** Highest version compatible with the detected Kotlin compiler, if any. */
  best?: string;
  /** Newest released version, regardless of compatibility. */
  latest?: string;
  /** Minimum Kotlin compiler ("major.minor") the `latest` version needs. */
  latestNeedsKotlin?: string;
}

/** Offline fallback path: only FALLBACK's known ranges are available (no version list). */
function resolveFromFallbackOnly(
  group: string,
  artifact: string,
  kotlin: { major: number; minor: number },
): ResolveResult {
  const entries = FALLBACK[`${group}:${artifact}`];
  if (!entries || entries.length === 0) return {};
  const byLatest = [...entries].sort((a, b) => compareVersions(b.range[1], a.range[1]));
  const latestEntry = byLatest[0];
  const latest = latestEntry.range[1];
  const latestNeedsKotlin = needsKotlinLabel(latestEntry.metadata);
  let best: string | undefined;
  for (const entry of byLatest) {
    if (canRead(kotlin, entry.metadata)) {
      best = entry.range[1];
      break;
    }
  }
  return { best, latest, latestNeedsKotlin };
}

const resolveCache = new Map<string, ResolveResult>();

/**
 * Finds the newest version of `group:artifact` compatible with `kotlin`, by
 * walking released versions from newest to oldest (capped at 15 network
 * probes) checking real Kotlin metadata, seeded by FALLBACK to skip probing
 * known ranges.
 */
export async function resolveMaxCompatible(
  group: string,
  artifact: string,
  kotlin: { major: number; minor: number },
): Promise<ResolveResult> {
  const key = `${group}:${artifact}:${kotlin.major}.${kotlin.minor}`;
  const cached = resolveCache.get(key);
  if (cached) return cached;

  const versions = await listMavenVersions(group, artifact);
  if (versions.length === 0) {
    const result = resolveFromFallbackOnly(group, artifact, kotlin);
    resolveCache.set(key, result);
    return result;
  }

  const latest = versions[versions.length - 1];
  const latestMeta = lookupFallbackMetadata(group, artifact, latest) ?? (await fetchKotlinMetadataVersion(group, artifact, latest));
  const latestNeedsKotlin = latestMeta ? needsKotlinLabel(latestMeta) : undefined;

  let best: string | undefined;
  let probes = 0;
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i];
    let meta = lookupFallbackMetadata(group, artifact, v);
    if (!meta) {
      if (probes >= 15) continue;
      meta = await fetchKotlinMetadataVersion(group, artifact, v);
      probes++;
    }
    if (meta && canRead(kotlin, meta)) {
      best = v;
      break;
    }
  }

  const result: ResolveResult = { best, latest, latestNeedsKotlin };
  resolveCache.set(key, result);
  return result;
}
