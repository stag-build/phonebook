import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectAndroidPackage, tryWriteSnapshotClass } from './init.js';

describe('detectAndroidPackage', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('detects the package from namespace = "..." in build.gradle.kts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(
      join(dir, 'app', 'build.gradle.kts'),
      'android {\n  namespace = "dev.stag.sample"\n  applicationId = "dev.stag.other"\n}\n',
    );

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.sample');
  });

  it('detects the package from Groovy-style namespace \'...\' (no equals sign)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, 'app', 'build.gradle'), "android {\n  namespace 'dev.stag.groovy'\n}\n");

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.groovy');
  });

  it('falls back to applicationId = "..." when namespace is absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(
      join(dir, 'app', 'build.gradle.kts'),
      'android {\n  defaultConfig {\n    applicationId = "dev.stag.appid"\n  }\n}\n',
    );

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.appid');
  });

  it('falls back to the AndroidManifest.xml package attribute', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app', 'src', 'main'), { recursive: true });
    await writeFile(join(dir, 'app', 'build.gradle.kts'), 'android {\n  compileSdk = 35\n}\n');
    await writeFile(
      join(dir, 'app', 'src', 'main', 'AndroidManifest.xml'),
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.stag.manifest">\n</manifest>\n',
    );

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.manifest');
  });

  it('falls back to the longest common directory-structure prefix under src/main/java', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    const srcDir = join(dir, 'app', 'src', 'main', 'java', 'dev', 'stag', 'sample');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'MainActivity.kt'), 'package dev.stag.sample\n');

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.sample');
  });

  it('stops walking the directory structure at the first branch (multiple subdirectories)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app', 'src', 'main', 'java', 'dev', 'stag', 'featureone'), { recursive: true });
    await mkdir(join(dir, 'app', 'src', 'main', 'java', 'dev', 'stag', 'featuretwo'), { recursive: true });

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag');
  });

  it('returns undefined when nothing can be detected', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app'), { recursive: true });

    expect(await detectAndroidPackage(dir, ':app')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tryWriteSnapshotClass (`phonebook init --write-snapshot-class`)
// ---------------------------------------------------------------------------

/** A minimal fake .pbxproj with one PBXNativeTarget linking SnapshottingTests. */
function fakePbxprojTarget(opts: { targetName?: string; synchronizedFolder?: string }): string {
  const targetName = opts.targetName ?? 'MyTests';
  const syncGroupsLine = opts.synchronizedFolder
    ? `\t\t\tfileSystemSynchronizedGroups = (\n\t\t\t\tFFFFFFFFFFFFFFFFFFFFFFFF /* ${opts.synchronizedFolder} */,\n\t\t\t);\n`
    : '';
  const syncGroupSection = opts.synchronizedFolder
    ? `
\t\tFFFFFFFFFFFFFFFFFFFFFFFF /* ${opts.synchronizedFolder} */ = {
\t\t\tisa = PBXFileSystemSynchronizedRootGroup;
\t\t\tpath = ${opts.synchronizedFolder};
\t\t\tsourceTree = "<group>";
\t\t};
`
    : '';
  return `// !$*UTF8*$!
{
\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* ${targetName} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB /* Build configuration list for PBXNativeTarget "${targetName}" */;
\t\t\tname = ${targetName};
${syncGroupsLine}\t\t\tpackageProductDependencies = (
\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCCC /* SnapshottingTests */,
\t\t\t);
\t\t};
\t\tBBBBBBBBBBBBBBBBBBBBBBBB /* Build configuration list for PBXNativeTarget "${targetName}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\tDDDDDDDDDDDDDDDDDDDDDDDD /* Debug */,
\t\t\t);
\t\t};
\t\tDDDDDDDDDDDDDDDDDDDDDDDD /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tPRODUCT_NAME = ${targetName};
\t\t\t};
\t\t\tname = Debug;
\t\t};
${syncGroupSection}}
`;
}

async function writeIosFixture(
  dir: string,
  opts: { pbxprojText: string; existingSubclass?: string },
): Promise<void> {
  await writeFile(
    join(dir, 'phonebook.config.json'),
    JSON.stringify(
      { appName: 'test', platform: 'ios', ios: { project: 'App.xcodeproj', scheme: 'App' } },
      null,
      2,
    ),
  );
  await mkdir(join(dir, 'App.xcodeproj'), { recursive: true });
  await writeFile(join(dir, 'App.xcodeproj', 'project.pbxproj'), opts.pbxprojText);
  if (opts.existingSubclass) {
    await mkdir(join(dir, 'Tests'), { recursive: true });
    await writeFile(join(dir, 'Tests', 'ExistingSnapshots.swift'), opts.existingSubclass);
  }
}

const EXISTING_SUBCLASS_SOURCE = `import SnapshotPreviews

class ExistingSnapshots: SnapshotTest {
  override class func snapshotPreviews() -> [String]? { nil }
}
`;

describe('tryWriteSnapshotClass', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes <folder>/PhonebookSnapshots.swift when the target uses a synchronized group', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-write-'));
    await writeIosFixture(dir, {
      pbxprojText: fakePbxprojTarget({ targetName: 'UnitTests', synchronizedFolder: 'UnitTests' }),
    });

    const result = await tryWriteSnapshotClass(dir);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Safe because');
    expect(result.message).toContain('synchronized');
    expect(result.path).toBe(join(dir, 'UnitTests', 'PhonebookSnapshots.swift'));

    const written = await readFile(join(dir, 'UnitTests', 'PhonebookSnapshots.swift'), 'utf8');
    expect(written).toContain('import SnapshotPreviews');
    expect(written).toContain('class Snapshots: SnapshotTest {');
    expect(written).toContain('override class func snapshotPreviews() -> [String]? { nil }');
    // The instructions-snippet indentation must not leak into the written file.
    expect(written).not.toMatch(/^ {5}/m);
  });

  it('refuses when the target has no synchronized group (no project.pbxproj edit attempted)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-write-'));
    await writeIosFixture(dir, {
      pbxprojText: fakePbxprojTarget({ targetName: 'MyTests' }),
    });
    const pbxprojBefore = await readFile(join(dir, 'App.xcodeproj', 'project.pbxproj'), 'utf8');

    const result = await tryWriteSnapshotClass(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('does not use');
    expect(result.message).toContain('synchronized groups');
    expect(result.message).toContain('MyTests');
    expect(result.path).toBeUndefined();

    const pbxprojAfter = await readFile(join(dir, 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbxprojAfter).toBe(pbxprojBefore);
  });

  it('refuses when a SnapshotTest subclass already exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-write-'));
    await writeIosFixture(dir, {
      pbxprojText: fakePbxprojTarget({ targetName: 'UnitTests', synchronizedFolder: 'UnitTests' }),
      existingSubclass: EXISTING_SUBCLASS_SOURCE,
    });

    const result = await tryWriteSnapshotClass(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('already exists');
    expect(result.message).toContain('ExistingSnapshots');
    expect(result.path).toBeUndefined();
  });

  it('refuses when SnapshotPreviews is not wired into the project yet', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-write-'));
    await writeIosFixture(dir, { pbxprojText: '// !$*UTF8*$!\n{ /* no snapshot wiring */ }\n' });

    const result = await tryWriteSnapshotClass(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not wired into the project yet');
  });

  it('refuses for an Android project', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-write-'));
    await writeFile(
      join(dir, 'phonebook.config.json'),
      JSON.stringify({ appName: 'test', platform: 'android', android: { modules: [':app'], variant: 'debug' } }),
    );

    const result = await tryWriteSnapshotClass(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('only applies to iOS projects');
  });
});
