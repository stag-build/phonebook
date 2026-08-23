import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

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
): Promise<{ className: string; relativePath: string } | undefined> {
  async function walk(dir: string): Promise<{ className: string; relativePath: string } | undefined> {
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
        return { className: match[1], relativePath: relative(projectDir, full) };
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
