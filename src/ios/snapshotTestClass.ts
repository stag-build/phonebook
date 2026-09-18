import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

  for (const id of groups.keys()) {
    if (!visited.has(id)) walk(id, '');
  }
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
 * project structure cannot say (no synchronized folder covers it, or xcodebuild
 * cannot report the target's settings).
 *
 * The module name is the first half of a #Preview's synthesized fileID
 * ("<Module>/<File>.swift"), which is what SnapshotPreviews matches its filter
 * patterns against. `cache` is keyed by target name so a run that filters a
 * dozen files still shells out to xcodebuild once per target.
 */
export async function moduleForFile(
  pbxproj: string,
  projectDir: string,
  filePath: string,
  xcodebuildTarget: { project?: string; workspace?: string; scheme?: string },
  cache?: Map<string, string | undefined>,
): Promise<string | undefined> {
  // Checked first, and returned directly with no xcodebuild round trip: a
  // local package's module name is read off its own directory layout, not
  // asked of a target xcodebuild does not build itself. Trying the Xcode-target
  // path first would mean treating "SnapshottingTests" as if it were a target
  // in the .xcodeproj, which it is not, and getting a wrong or missing answer
  // from a query that was never going to apply.
  const packageModule = localSwiftPackageModule(pbxproj, filePath);
  if (packageModule) return packageModule;

  const targetName = targetForFile(pbxproj, filePath);
  if (!targetName) return undefined;
  if (cache?.has(targetName)) return cache.get(targetName);

  const module = await productModuleName(projectDir, targetName, xcodebuildTarget);
  cache?.set(targetName, module);
  return module;
}

async function productModuleName(
  projectDir: string,
  targetName: string,
  xcodebuildTarget: { project?: string; workspace?: string; scheme?: string },
): Promise<string | undefined> {
  const args = ['-showBuildSettings'];
  if (xcodebuildTarget.workspace) {
    args.push('-workspace', xcodebuildTarget.workspace);
    if (xcodebuildTarget.scheme) args.push('-scheme', xcodebuildTarget.scheme);
  } else if (xcodebuildTarget.project) {
    args.push('-project', xcodebuildTarget.project);
  }
  args.push('-target', targetName);
  try {
    const { stdout } = await run('xcodebuild', args, { cwd: projectDir, maxBuffer: 32 * 1024 * 1024 });
    const match = stdout.match(/^\s*PRODUCT_MODULE_NAME = (.+)$/m);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}
