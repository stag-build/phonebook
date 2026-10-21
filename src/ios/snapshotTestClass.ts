import { execFile } from 'node:child_process';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Shared iOS SnapshotTest-subclass discovery: scanning project sources for an
 * existing subclass, and (heuristically) parsing a .pbxproj to find which
 * target links SnapshottingTests, whether it's properly hosted (TEST_HOST),
 * and — for projects using Xcode's filesystem-synchronized groups — which
 * folder a new file should be dropped into.
 *
 * Used by both `doctor` (to report on the setup) and `init --write-snapshot-class`
 * (to safely write the missing file). Lives outside doctor.ts/init.ts to avoid a
 * circular import between those two modules.
 */

const SNAPSHOT_TEST_SUBCLASS_PATTERN = /class\s+(\w+)\s*:\s*SnapshotTest\b/;
const SNAPSHOT_TEST_SCAN_SKIP_DIRS = new Set(['.build', 'DerivedData', 'Pods', '.git']);

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Scans a project's .swift files for a `class X: SnapshotTest` subclass,
 * skipping build-output/dependency directories (.build, DerivedData, Pods,
 * .git) and any path segment named "checkouts" — SPM package sources
 * (including SnapshotPreviews' own SnapshotTest subclasses, if any) must not
 * count towards this check.
 */
export async function findSnapshotTestSubclass(
  projectDir: string,
): Promise<{ className: string; relativePath: string; importsSnapshottingTests: boolean } | undefined> {
  async function walk(dir: string): Promise<{ className: string; relativePath: string; importsSnapshottingTests: boolean } | undefined> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SNAPSHOT_TEST_SCAN_SKIP_DIRS.has(entry.name) || entry.name === 'checkouts') continue;
        const found = await walk(full);
        if (found) return found;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.swift')) continue;
      const text = await readTextIfExists(full);
      const match = text.match(SNAPSHOT_TEST_SUBCLASS_PATTERN);
      if (match) {
        return {
          className: match[1],
          relativePath: relative(projectDir, full),
          // The SnapshotTest base class lives in the SnapshottingTests module;
          // any other import (e.g. SnapshotPreviews) fails to compile.
          importsSnapshottingTests: /^\s*import\s+SnapshottingTests\b/m.test(text),
        };
      }
    }
    return undefined;
  }
  return walk(projectDir);
}

/**
 * Extracts the bodies of every object with the given `isa` from a raw
 * .pbxproj text, keyed by object id. Minimal/defensive regex parsing — no
 * plist library — matched against the standard pbxproj indentation.
 */
function extractPbxprojObjects(pbxproj: string, isa: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = new RegExp(`\\n\\t\\t([0-9A-F]{24}) [^\\n]*=\\s*\\{\\n\\t\\t\\tisa = ${isa};([\\s\\S]*?)\\n\\t\\t\\};`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(pbxproj))) {
    map.set(match[1], match[2]);
  }
  return map;
}

/**
 * Like extractPbxprojObjects, but for the isas Xcode writes on a single line.
 *
 * A pbxproj uses two layouts and the choice is per isa, not per project:
 * PBXGroup and PBXNativeTarget get a line per field, while PBXFileReference and
 * PBXBuildFile are written whole on one line —
 * `ID /* Name *\/ = {isa = PBXFileReference; path = Name.swift; ...};`. A
 * regex anchored on "\n\t\t\tisa" therefore finds every group in a project and
 * none of its files, which reads as a project with no source files rather than
 * as a parser that only knows one layout.
 *
 * This accepts either. Bodies come back with their fields in whatever spacing
 * they were written, so read them with pbxprojField rather than a
 * newline-anchored pattern of your own.
 */
function extractPbxprojEntries(pbxproj: string, isa: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = new RegExp(
    `\\n\\t\\t([0-9A-F]{24}) [^\\n]*?=\\s*\\{\\s*isa = ${isa};([\\s\\S]*?)\\n?\\t*\\};`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(pbxproj))) {
    map.set(match[1], match[2]);
  }
  return map;
}

/**
 * One field's value out of an object body, whichever layout it was written in.
 * Comments are stripped because a single-line entry carries its name in one.
 */
function pbxprojField(body: string, key: string): string | undefined {
  const match = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(new RegExp(`(?:^|[\\n;{]|\\s)${key} = ([^\\n;]+);`));
  return match ? unquote(match[1]) : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Reads the project's .pbxproj text: from the configured `ios.project` path
 * when given, otherwise by discovering the first *.xcodeproj directly under
 * projectDir (mirroring how `doctor` locates it for a workspace-only config).
 */
export async function readPbxprojText(projectDir: string, projectPath?: string): Promise<string> {
  if (projectPath) {
    return readTextIfExists(join(projectPath, 'project.pbxproj'));
  }
  try {
    const texts: string[] = [];
    for (const entry of await readdir(projectDir)) {
      if (entry.endsWith('.xcodeproj')) {
        const text = await readTextIfExists(join(projectDir, entry, 'project.pbxproj'));
        if (text) texts.push(text);
      }
    }
    return texts.join('\n');
  } catch {
    return '';
  }
}

/** A PBXNativeTarget whose body references SnapshottingTests (i.e. links the product). */
export interface SnapshottingTestsTarget {
  id: string;
  name: string;
  body: string;
}

/**
 * Finds every PBXNativeTarget in the pbxproj that links the SnapshottingTests
 * product. In practice there's exactly one (the app-hosted unit-test target);
 * returned as a list to stay defensive.
 */
export function findSnapshottingTestsTargets(pbxproj: string): SnapshottingTestsTarget[] {
  const targets = extractPbxprojObjects(pbxproj, 'PBXNativeTarget');
  const result: SnapshottingTestsTarget[] = [];
  for (const [id, body] of targets) {
    if (!body.includes('SnapshottingTests')) continue;
    const nameMatch = body.match(/\n\t\t\tname = ([^\n;]+);/);
    result.push({ id, name: nameMatch ? unquote(nameMatch[1]) : id, body });
  }
  return result;
}

/**
 * Heuristically checks whether the pbxproj target that links
 * SnapshottingTests has TEST_HOST/BUNDLE_LOADER set in any of its build
 * configurations (i.e. is hosted in the app, as SnapshotPreviews requires).
 * Returns a note string when the wiring is present but hosting can't be
 * confirmed; undefined otherwise (including when parsing fails — this is a
 * best-effort heuristic, not a hard failure).
 */
export function findMissingTestHostNote(pbxproj: string): string | undefined {
  if (!pbxproj.includes('SnapshottingTests')) return undefined;
  try {
    const targets = findSnapshottingTestsTargets(pbxproj);
    const configLists = extractPbxprojObjects(pbxproj, 'XCConfigurationList');
    const buildConfigs = extractPbxprojObjects(pbxproj, 'XCBuildConfiguration');

    for (const target of targets) {
      const confListMatch = target.body.match(/buildConfigurationList = ([0-9A-F]{24})/);
      const confListBody = confListMatch ? configLists.get(confListMatch[1]) : undefined;
      if (!confListBody) continue;

      const buildConfigIds = [...confListBody.matchAll(/([0-9A-F]{24}) \/\*/g)].map((m) => m[1]);
      if (buildConfigIds.length === 0) continue;

      const hasHost = buildConfigIds.some((id) => {
        const cfgBody = buildConfigs.get(id);
        return cfgBody !== undefined && (cfgBody.includes('TEST_HOST') || cfgBody.includes('BUNDLE_LOADER'));
      });
      if (!hasHost) {
        return 'the target linking SnapshottingTests appears to have no TEST_HOST; SnapshotPreviews must run in a test target hosted in the app';
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Where to put the missing SnapshotTest subclass, derived from the pbxproj. */
export interface SnapshotTestClassLocation {
  /** Name of the PBXNativeTarget that links SnapshottingTests. */
  targetName: string;
  /**
   * Folder path (relative to the project, "/"-joined) covered by a
   * PBXFileSystemSynchronizedRootGroup tied to the target, if the project
   * uses Xcode's synchronized groups (objectVersion >= ~77). When set,
   * simply creating a .swift file in this folder is enough — Xcode picks it
   * up automatically, no project-file edit required.
   */
  synchronizedFolder?: string;
}

/**
 * Identifies the target that links SnapshottingTests and, for a project
 * using filesystem-synchronized groups, the folder a new source file can be
 * dropped into to be picked up automatically. Best-effort/heuristic — returns
 * undefined if the target can't be identified or parsing fails.
 */
export function findSnapshotTestClassLocation(pbxproj: string): SnapshotTestClassLocation | undefined {
  try {
    const targets = findSnapshottingTestsTargets(pbxproj);
    if (targets.length === 0) return undefined;
    const target = targets[0];

    const syncGroups = extractPbxprojObjects(pbxproj, 'PBXFileSystemSynchronizedRootGroup');
    const groupsMatch = target.body.match(/fileSystemSynchronizedGroups = \(([\s\S]*?)\)/);
    let synchronizedFolder: string | undefined;
    if (groupsMatch) {
      const groupIds = [...groupsMatch[1].matchAll(/([0-9A-F]{24})/g)].map((m) => m[1]);
      for (const gid of groupIds) {
        const groupBody = syncGroups.get(gid);
        const pathMatch = groupBody?.match(/\n\t\t\tpath = ([^\n;]+);/);
        if (pathMatch) {
          synchronizedFolder = unquote(pathMatch[1]);
          break;
        }
      }
    }

    return { targetName: target.name, synchronizedFolder };
  } catch {
    return undefined;
  }
}

/**
 * A folder covered by a PBXFileSystemSynchronizedRootGroup, and the target that
 * owns it. Xcode 16+ projects assign whole folders to a target this way, so a
 * source file's target — and therefore its Swift module — can be read off the
 * pbxproj without any per-file build-phase membership.
 *
 * This covers one of the two ways Xcode records membership. The other —
 * per-file PBXBuildFile entries listed in a target's PBXSourcesBuildPhase — is
 * what every project written before Xcode 16 uses, and what XcodeGen and Tuist
 * still generate today. See sourcesBuildPhaseOwner for that half.
 */
export interface SynchronizedGroupOwner {
  targetName: string;
  /** Folder path, relative to the project directory, "/"-joined and unquoted. */
  path: string;
  /** Paths (relative to the project directory) explicitly excluded from this target. */
  exclusions: Set<string>;
}

function parseListItems(body: string, key: string): string[] {
  const match = body.match(new RegExp(`${key} = \\(([\\s\\S]*?)\\);`));
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => unquote(item.replace(/\/\*[\s\S]*?\*\//g, '').trim()))
    .filter((item) => item.length > 0);
}

/**
 * Every filesystem-synchronized folder in the project, with the target it
 * belongs to and the files explicitly excepted from that target.
 */
export function synchronizedGroupOwners(pbxproj: string): SynchronizedGroupOwner[] {
  const targets = extractPbxprojObjects(pbxproj, 'PBXNativeTarget');
  const syncGroups = extractPbxprojObjects(pbxproj, 'PBXFileSystemSynchronizedRootGroup');
  const exceptionSets = extractPbxprojObjects(pbxproj, 'PBXFileSystemSynchronizedBuildFileExceptionSet');

  const owners: SynchronizedGroupOwner[] = [];
  for (const [targetId, targetBody] of targets) {
    const nameMatch = targetBody.match(/\n\t\t\tname = ([^\n;]+);/);
    const targetName = nameMatch ? unquote(nameMatch[1]) : targetId;
    const groupsMatch = targetBody.match(/fileSystemSynchronizedGroups = \(([\s\S]*?)\)/);
    if (!groupsMatch) continue;

    for (const gid of [...groupsMatch[1].matchAll(/([0-9A-F]{24})/g)].map((m) => m[1])) {
      const groupBody = syncGroups.get(gid);
      if (!groupBody) continue;
      const pathMatch = groupBody.match(/\n\t\t\tpath = ([^\n;]+);/);
      if (!pathMatch) continue;
      const path = unquote(pathMatch[1]).replace(/\/+$/, '');

      const exclusions = new Set<string>();
      const exceptionIds = [
        ...(groupBody.match(/exceptions = \(([\s\S]*?)\)/)?.[1] ?? '').matchAll(/([0-9A-F]{24})/g),
      ].map((m) => m[1]);
      for (const eid of exceptionIds) {
        const exceptionBody = exceptionSets.get(eid);
        if (!exceptionBody) continue;
        // An exception set belongs to one target; one that names another target
        // says nothing about this folder's membership here.
        const exceptionTarget = exceptionBody.match(/\n\t\t\ttarget = ([0-9A-F]{24})/)?.[1];
        if (exceptionTarget && exceptionTarget !== targetId) continue;
        for (const member of parseListItems(exceptionBody, 'membershipExceptions')) {
          exclusions.add(`${path}/${member}`);
        }
      }
      owners.push({ targetName, path, exclusions });
    }
  }
  return owners;
}

/**
 * The target that compiles `filePath`, via the synchronized folder that covers
 * it. The longest covering folder wins, so a nested folder assigned to its own
 * target beats the parent that contains it; a file explicitly excepted from a
 * folder's target falls through to the next-longest candidate.
 */
export function targetForFile(pbxproj: string, filePath: string): string | undefined {
  const normalized = filePath.replace(/^\.\//, '');
  const candidates = synchronizedGroupOwners(pbxproj)
    .filter((owner) => normalized === owner.path || normalized.startsWith(`${owner.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  for (const candidate of candidates) {
    if (candidate.exclusions.has(normalized)) continue;
    return candidate.targetName;
  }
  // Synchronized folders are the Xcode 16 way and not the only way. A project
  // that lists its files explicitly answers the same question through its
  // build phases, so a file not covered by any folder is not a file whose
  // target is unknowable.
  return sourcesBuildPhaseOwner(pbxproj, normalized);
}

/**
 * Every local Swift package the project references, by the path (relative to
 * the project directory) its Package.swift lives under.
 *
 * A local package is added to a project as an XCLocalSwiftPackageReference —
 * one object, one field (`relativePath`), no per-file membership at all: the
 * files inside it are never PBXFileReferences and never appear in any
 * PBXSourcesBuildPhase, because SwiftPM compiles them, not xcodebuild acting
 * directly on the .xcodeproj. Neither of the two resolvers above can ever see
 * them, structurally, not as a gap to close but because they are answering a
 * question ("which Xcode target's build phase compiles this file") that does
 * not apply here.
 */
export function localSwiftPackageRoots(pbxproj: string): string[] {
  const roots: string[] = [];
  for (const [, body] of extractPbxprojEntries(pbxproj, 'XCLocalSwiftPackageReference')) {
    const path = pbxprojField(body, 'relativePath');
    if (path) roots.push(path.replace(/\/+$/, ''));
  }
  return roots;
}

/**
 * The Swift module a file inside a local package compiles into, by SwiftPM's
 * own naming convention: a target's module name is the target's own name, and
 * by default a target's sources live at "Sources/<TargetName>/..." (or
 * "Tests/<TargetName>/..." for a test target) under the package root. That
 * directory name is the module — not something to shell out to xcodebuild to
 * ask, because xcodebuild does not build this target directly; SwiftPM does,
 * as a dependency, and does not expose a `-showBuildSettings` query for one of
 * its own targets the way it does for a target listed in the .xcodeproj.
 *
 * This reads the convention, not the package manifest: a Package.swift that
 * overrides a target's `path:` to something other than "Sources/<name>" is out
 * of scope, the same way a project whose classic build phase or synchronized
 * folder is malformed is out of scope for the two resolvers above — the
 * manifest is executable Swift, and evaluating it is not a cost this
 * comment-scale check is worth paying. The overwhelming majority of packages,
 * including every one Phonebook itself scaffolds, use the default.
 */
export function localSwiftPackageModule(pbxproj: string, filePath: string): string | undefined {
  const normalized = filePath.replace(/^\.\//, '');
  for (const root of localSwiftPackageRoots(pbxproj)) {
    if (normalized !== root && !normalized.startsWith(`${root}/`)) continue;
    const withinPackage = normalized.slice(root.length + 1);
    const match = withinPackage.match(/^(?:Sources|Tests)\/([^/]+)\//);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Every file reference in the project, by its path relative to the project
 * directory.
 *
 * A PBXFileReference carries only its own last path component; the rest comes
 * from the PBXGroups above it, each contributing its own `path` when it has
 * one. So the map is built by walking down from every group rather than up
 * from each file: a group with no `path` is a pure grouping folder that Xcode
 * shows in the navigator and that contributes nothing to the path on disk,
 * which is exactly what makes walking up from a file ambiguous.
 *
 * The walk starts at the project's mainGroup, then at groups nothing else
 * contains, because the order groups appear in the file is by object id.
 *
 * A group whose sourceTree is SOURCE_ROOT restarts the path at the project
 * directory, because that is what the field means; one that is "<absolute>"
 * describes a file outside the project entirely and is skipped, since nothing
 * here can express it as a project-relative path.
 */
export function fileReferencePaths(pbxproj: string): Map<string, string> {
  const groups = new Map<string, string>([
    ...extractPbxprojEntries(pbxproj, 'PBXGroup'),
    ...extractPbxprojEntries(pbxproj, 'PBXVariantGroup'),
  ]);
  const files = extractPbxprojEntries(pbxproj, 'PBXFileReference');

  const childIds = (body: string): string[] =>
    [...(body.match(/children = \(([\s\S]*?)\);/)?.[1] ?? '').matchAll(/([0-9A-F]{24})/g)].map(
      (m) => m[1],
    );

  const paths = new Map<string, string>();
  // A malformed project can name a group as its own descendant. Visiting each
  // id once keeps that a missing entry rather than a hang.
  const visited = new Set<string>();

  const walk = (id: string, prefix: string): void => {
    if (visited.has(id)) return;
    visited.add(id);

    const groupBody = groups.get(id);
    if (groupBody !== undefined) {
      const tree = pbxprojField(groupBody, 'sourceTree') ?? '<group>';
      if (tree === '<absolute>') return;
      const own = pbxprojField(groupBody, 'path');
      const base = tree === 'SOURCE_ROOT' ? (own ?? '') : own ? join(prefix, own) : prefix;
      for (const child of childIds(groupBody)) walk(child, base);
      return;
    }

    const fileBody = files.get(id);
    if (fileBody === undefined) return;
    const tree = pbxprojField(fileBody, 'sourceTree') ?? '<group>';
    if (tree === '<absolute>') return;
    const own = pbxprojField(fileBody, 'path');
    if (own === undefined) return;
    paths.set(id, tree === 'SOURCE_ROOT' ? own : join(prefix, own));
  };

  // Xcode writes the PBXGroup section sorted by object id, not by hierarchy, so
  // text order can put a child before its parent. Walking in that order would
  // reach the child with an empty prefix and, via `visited`, never revisit it.
  // The project's mainGroup is the real root; after it, only groups no other
  // group contains (detached roots), then anything left over from a cycle.
  for (const [, body] of extractPbxprojEntries(pbxproj, 'PBXProject')) {
    const main = pbxprojField(body, 'mainGroup');
    if (main) walk(main, '');
  }
  const contained = new Set<string>();
  for (const body of groups.values()) for (const child of childIds(body)) contained.add(child);
  for (const id of groups.keys()) {
    if (!contained.has(id)) walk(id, '');
  }
  for (const id of groups.keys()) walk(id, '');
  return paths;
}

/**
 * The target whose PBXSourcesBuildPhase compiles `filePath`, for a project that
 * records membership per file rather than per folder.
 *
 * This is the classic Xcode layout and still the common one: XcodeGen and Tuist
 * both generate it, and every project predating Xcode 16 uses it. A file
 * reaches a target through two hops — a PBXBuildFile wraps the file reference,
 * and the target's sources phase lists that build file — so both are followed
 * rather than guessed at.
 *
 * `filePath` is relative to the project directory.
 */
export function sourcesBuildPhaseOwner(pbxproj: string, filePath: string): string | undefined {
  const normalized = filePath.replace(/^\.\//, '');
  const paths = fileReferencePaths(pbxproj);

  let fileRefId: string | undefined;
  for (const [id, path] of paths) {
    if (path === normalized) {
      fileRefId = id;
      break;
    }
  }
  if (!fileRefId) return undefined;

  // One file reference can be compiled by several targets — an app and its
  // test target, a framework and the app embedding it — so every build file
  // pointing at it is a candidate.
  const buildFileIds = new Set<string>();
  for (const [id, body] of extractPbxprojEntries(pbxproj, 'PBXBuildFile')) {
    if (pbxprojField(body, 'fileRef') === fileRefId) buildFileIds.add(id);
  }
  if (buildFileIds.size === 0) return undefined;

  const sourcePhases = extractPbxprojEntries(pbxproj, 'PBXSourcesBuildPhase');
  for (const [targetId, targetBody] of extractPbxprojEntries(pbxproj, 'PBXNativeTarget')) {
    const phaseIds = [
      ...(targetBody.match(/buildPhases = \(([\s\S]*?)\);/)?.[1] ?? '').matchAll(
        /([0-9A-F]{24})/g,
      ),
    ].map((m) => m[1]);
    for (const phaseId of phaseIds) {
      const phaseBody = sourcePhases.get(phaseId);
      if (!phaseBody) continue;
      const compiled = [
        ...(phaseBody.match(/files = \(([\s\S]*?)\);/)?.[1] ?? '').matchAll(/([0-9A-F]{24})/g),
      ].map((m) => m[1]);
      if (!compiled.some((id) => buildFileIds.has(id))) continue;
      return pbxprojField(targetBody, 'name') ?? targetId;
    }
  }
  return undefined;
}

/**
 * The Swift module name a source file compiles into, or undefined when the
 * project structure cannot say which target compiles it. Build-settings failures
 * are errors, carrying the actual command output rather than an absent module.
 *
 * The module name is the first half of a #Preview's synthesized fileID
 * ("<Module>/<File>.swift"), which is what SnapshotPreviews matches its filter
 * patterns against. `cache` retains one Test-action configuration query, one
 * module query per project/target/configuration, and one read of each workspace
 * project file for the requested files.
 */
export async function moduleForFile(
  pbxproj: string,
  projectDir: string,
  filePath: string,
  xcodebuildTarget: { project?: string; workspace?: string; scheme?: string },
  cache?: Map<string, string | undefined>,
): Promise<string | undefined> {
  const withinConfiguredProject = xcodebuildTarget.project && !xcodebuildTarget.workspace
    ? relative(dirname(resolve(projectDir, xcodebuildTarget.project)), resolve(projectDir, filePath))
    : filePath;
  // Checked first, and returned directly with no xcodebuild round trip: a
  // local package's module name is read off its own directory layout, not
  // asked of a target xcodebuild does not build itself. Trying the Xcode-target
  // path first would mean treating "SnapshottingTests" as if it were a target
  // in the .xcodeproj, which it is not, and getting a wrong or missing answer
  // from a query that was never going to apply.
  const packageModule = localSwiftPackageModule(pbxproj, withinConfiguredProject);
  if (packageModule) return packageModule;

  // Workspace scheme settings contain only that scheme's build entries. A
  // framework linked by the app can be absent, as SignalUI is from Signal's
  // settings. Resolve the file's project first, then query that exact target.
  const owner = xcodebuildTarget.workspace
    ? await workspaceOwner(projectDir, filePath, xcodebuildTarget.workspace, cache)
    : {
        project: xcodebuildTarget.project,
        target: targetForFile(pbxproj, withinConfiguredProject),
      };
  if (!owner?.target) return undefined;
  const configurationKey = JSON.stringify(['test-configuration', xcodebuildTarget]);
  let configuration = cache?.get(configurationKey);
  if (xcodebuildTarget.scheme && !configuration) {
    configuration = await testConfiguration(projectDir, xcodebuildTarget);
    cache?.set(configurationKey, configuration);
  }
  const cacheKey = JSON.stringify([owner.project, owner.target, configuration]);
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const module = await productModuleName(projectDir, owner.target, owner.project, configuration);
  cache?.set(cacheKey, module);
  return module;
}

function xmlAttribute(value: string): string {
  return value.replace(/&(?:#x([\da-f]+)|#(\d+)|amp|quot|apos|lt|gt);/gi, (entity, hex, decimal) => {
    if (hex || decimal) return String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10));
    return ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' } as Record<string, string>)[entity] ?? entity;
  });
}

/** Project references retain their workspace group path; no directory-name guesses. */
export function workspaceProjects(contents: string, workspaceDir: string): string[] {
  const projects = new Set<string>();
  const groups = [workspaceDir];
  const tags = contents.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/)?(Group|FileRef)\b([^>]*?)(\/?)>/g);
  for (const [, closing, kind, attributes, selfClosing] of tags) {
    if (closing) {
      if (kind === 'Group') groups.pop();
      continue;
    }
    const attribute = attributes.match(/\blocation\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    const location = attribute ? xmlAttribute(attribute[1] ?? attribute[2]) : 'group:';
    const separator = location.indexOf(':');
    const base = location.slice(0, separator);
    const path = location.slice(separator + 1);
    let absolute: string;
    if (base === 'group') absolute = resolve(groups.at(-1)!, path);
    else if (base === 'container') absolute = resolve(workspaceDir, path);
    else if (base === 'absolute') absolute = resolve(path);
    else throw new Error(`Unsupported Xcode workspace reference: ${location}`);
    if (kind === 'Group' && !selfClosing) groups.push(absolute);
    if (kind === 'FileRef' && absolute.endsWith('.xcodeproj')) projects.add(absolute);
  }
  return [...projects];
}

async function workspaceOwner(
  projectDir: string,
  filePath: string,
  workspace: string,
  cache?: Map<string, string | undefined>,
): Promise<{ project: string; target: string } | undefined> {
  const root = await realpath(projectDir);
  async function readWorkspaceFile(path: string): Promise<string> {
    const key = JSON.stringify(['workspace-file', path]);
    const cached = cache?.get(key);
    if (cached !== undefined) return cached;
    const canonical = await realpath(path);
    const withinRoot = relative(root, canonical);
    if (withinRoot === '..' || withinRoot.startsWith('../') || isAbsolute(withinRoot)) {
      throw new Error(`Xcode workspace metadata is outside the selected project directory: ${path}`);
    }
    const text = await readFile(canonical, 'utf8');
    cache?.set(key, text);
    return text;
  }
  const workspacePath = resolve(projectDir, workspace);
  const contents = await readWorkspaceFile(join(workspacePath, 'contents.xcworkspacedata'));
  const owners: { project: string; target: string }[] = [];
  const unreadable: { project: string; error: unknown }[] = [];
  for (const project of workspaceProjects(contents, dirname(workspacePath))) {
    let text: string;
    try {
      text = await readWorkspaceFile(join(project, 'project.pbxproj'));
    } catch (error) {
      // A project that is missing (a Pods project not generated yet) or outside the
      // root must not hide the files the other projects own. It is never queried.
      unreadable.push({ project, error });
      continue;
    }
    const withinProject = relative(dirname(project), resolve(projectDir, filePath));
    const target = targetForFile(text, withinProject);
    if (target) owners.push({ project, target });
  }
  if (owners.length > 1) {
    throw new Error(`More than one workspace project compiles ${filePath}: ${owners.map((o) => `${o.project} (${o.target})`).join(', ')}`);
  }
  // Nothing readable owns the file, so an unreadable project may. Say why we
  // cannot tell rather than report the file as unowned.
  if (owners.length === 0 && unreadable.length > 0) throw unreadable[0].error;
  for (const { project, error } of unreadable) {
    const key = JSON.stringify(['skipped-project', project]);
    if (cache?.has(key)) continue;
    cache?.set(key, undefined);
    console.warn(`warning: skipping Xcode workspace project ${project}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return owners[0];
}

export type BuildSettingsFailure = 'command-failed' | 'invalid-response' | 'target-not-found' | 'ambiguous-target' | 'module-name-missing' | 'configuration-not-found' | 'ambiguous-configuration';

const MESSAGE_OUTPUT_LIMIT = 4000;

/** Keeps the head and tail of long command output; the error's properties hold it whole. */
function excerpt(text: string): string {
  if (text.length <= MESSAGE_OUTPUT_LIMIT) return text;
  const half = MESSAGE_OUTPUT_LIMIT / 2;
  return `${text.slice(0, half)}\n… ${text.length - MESSAGE_OUTPUT_LIMIT} characters omitted; the full output is on the error's stdout and stderr …\n${text.slice(-half)}`;
}

/**
 * Diagnostics are retained for callers and also printed by the CLI's Error handler.
 * The message abridges long output (a settings dump runs to megabytes).
 */
export class BuildSettingsError extends Error {
  readonly command = 'xcodebuild';

  constructor(
    readonly reason: BuildSettingsFailure,
    readonly target: string,
    readonly args: string[],
    readonly cwd: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode?: string | number | null,
    options?: ErrorOptions,
  ) {
    super([
      `Phonebook build-settings lookup failed [${reason}] for target ${JSON.stringify(target)}.`,
      `Command: xcodebuild ${args.map((arg) => JSON.stringify(arg)).join(' ')}`,
      `Directory: ${cwd}`,
      ...(exitCode !== undefined ? [`Exit: ${exitCode}`] : []),
      ...(stdout ? [`stdout:\n${excerpt(stdout)}`] : []),
      ...(stderr ? [`stderr:\n${excerpt(stderr)}`] : []),
    ].join('\n'), options);
    this.name = 'BuildSettingsError';
  }
}

type TargetSettings = { target?: string; buildSettings?: Record<string, unknown> };

async function buildSettings(
  projectDir: string,
  targetName: string,
  args: string[],
): Promise<{ settings: TargetSettings[]; stdout: string; stderr: string }> {
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await run('xcodebuild', args, { cwd: projectDir, maxBuffer: 32 * 1024 * 1024 }));
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; code?: string | number | null };
    throw new BuildSettingsError('command-failed', targetName, args, projectDir, error.stdout ?? '', error.stderr ?? '', error.code, { cause });
  }
  let settings: unknown;
  try {
    settings = JSON.parse(stdout);
    if (!Array.isArray(settings)) throw new Error('Expected an array of target settings');
  } catch (cause) {
    throw new BuildSettingsError('invalid-response', targetName, args, projectDir, stdout, stderr, 0, { cause });
  }
  const entries = (settings as unknown[]).filter((entry): entry is TargetSettings =>
    typeof entry === 'object' && entry !== null,
  );
  return { settings: entries, stdout, stderr };
}

async function testConfiguration(
  projectDir: string,
  selection: { project?: string; workspace?: string; scheme?: string },
): Promise<string> {
  // `test -showBuildSettings` inspects the Test action without running tests.
  // A direct target query would otherwise use the project's default (often
  // Release), which can have a different PRODUCT_MODULE_NAME from Test/Debug.
  const args = ['test', '-showBuildSettings', '-json', '-sdk', 'iphonesimulator'];
  if (selection.workspace) args.push('-workspace', selection.workspace);
  else if (selection.project) args.push('-project', selection.project);
  args.push('-scheme', selection.scheme!);
  const target = `scheme ${selection.scheme}`;
  const { settings, stdout, stderr } = await buildSettings(projectDir, target, args);
  const configurations = new Set(settings.map((entry) => entry.buildSettings?.CONFIGURATION)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
  const failure = configurations.size === 0 ? 'configuration-not-found' : configurations.size > 1 ? 'ambiguous-configuration' : undefined;
  if (failure) throw new BuildSettingsError(failure, target, args, projectDir, stdout, stderr, 0);
  return [...configurations][0];
}

async function productModuleName(
  projectDir: string,
  targetName: string,
  project?: string,
  configuration?: string,
): Promise<string> {
  // Match the renderer's iOS Simulator SDK, including SDK-conditional module names.
  const args = ['-showBuildSettings', '-json', '-sdk', 'iphonesimulator'];
  if (project) args.push('-project', project);
  args.push('-target', targetName);
  if (configuration) args.push('-configuration', configuration);
  const { settings, stdout, stderr } = await buildSettings(projectDir, targetName, args);
  const targets = settings.filter((entry) => entry.target === targetName);
  const failure = targets.length === 0 ? 'target-not-found' : targets.length > 1 ? 'ambiguous-target' : undefined;
  if (failure) throw new BuildSettingsError(failure, targetName, args, projectDir, stdout, stderr, 0);
  const module = targets[0].buildSettings?.PRODUCT_MODULE_NAME;
  if (typeof module !== 'string' || !module.trim()) {
    throw new BuildSettingsError('module-name-missing', targetName, args, projectDir, stdout, stderr, 0);
  }
  return module.trim();
}
