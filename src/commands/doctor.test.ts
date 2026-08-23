import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectDoctorChecks,
  extractCompilerErrors,
  findMissingTestHostNote,
  findSnapshotTestClassLocation,
  findSnapshotTestSubclass,
  parseAvailableSimulatorNames,
  parseJavaMajorVersion,
  parseXcodeSchemes,
} from './doctor.js';

describe('parseJavaMajorVersion', () => {
  it('parses modern version strings', () => {
    expect(
      parseJavaMajorVersion(
        'openjdk version "21.0.1" 2023-10-17\nOpenJDK Runtime Environment Homebrew (build 21.0.1)',
      ),
    ).toBe(21);
  });

  it('parses JDK 17', () => {
    expect(parseJavaMajorVersion('openjdk version "17.0.9" 2023-10-17')).toBe(17);
  });

  it('parses legacy 1.x version strings', () => {
    expect(parseJavaMajorVersion('java version "1.8.0_292"')).toBe(8);
  });

  it('returns undefined for unparseable output', () => {
    expect(parseJavaMajorVersion('command not found')).toBeUndefined();
  });
});

describe('parseXcodeSchemes', () => {
  it('extracts schemes from xcodebuild -list output', () => {
    const output = `
Information about project "PhonebookSample":
    Targets:
        PhonebookSample
        PhonebookSnapshotTests

    Build Configurations:
        Debug
        Release

    If no build configuration is specified and -scheme is not passed then "Release" is used.

    Schemes:
        PhonebookSample
`;
    expect(parseXcodeSchemes(output)).toEqual(['PhonebookSample']);
  });

  it('returns an empty array when no Schemes section is present', () => {
    expect(parseXcodeSchemes('no schemes here')).toEqual([]);
  });

  it('parses multiple schemes', () => {
    const output = 'Schemes:\n    App\n    AppTests\n\nOther section:\n    Foo\n';
    expect(parseXcodeSchemes(output)).toEqual(['App', 'AppTests']);
  });
});

describe('parseAvailableSimulatorNames', () => {
  it('extracts device names from simctl output', () => {
    const output = `== Devices ==
-- iOS 26.3 --
    iPhone 17 Pro (78B6627D-2763-4B81-8994-19C4611B7BED) (Shutdown)
    iPhone 17 Pro Max (9D737A69-3F3A-4CF3-8CCD-67CE302B307E) (Shutdown)
-- iOS 26.4 --
    iPhone 17 Pro (F6C0ECC9-355D-4D29-80A4-9758D4328144) (Booted)
`;
    expect(parseAvailableSimulatorNames(output)).toEqual([
      'iPhone 17 Pro',
      'iPhone 17 Pro Max',
      'iPhone 17 Pro',
    ]);
  });

  it('returns an empty array for no devices', () => {
    expect(parseAvailableSimulatorNames('== Devices ==\n')).toEqual([]);
  });
});

describe('extractCompilerErrors', () => {
  it('extracts "e:" lines and drops indented stack-frame lines', () => {
    const output = `
e: org.jetbrains.kotlin.util.FileAnalysisException: While analysing /project/Foo.kt:30:49: java.lang.IllegalStateException: Shouldn't be here
	at org.jetbrains.kotlin.foo.bar(Foo.kt:1)
	at org.jetbrains.kotlin.foo.baz(Foo.kt:2)
Caused by: java.lang.IllegalStateException: Shouldn't be here
	at org.jetbrains.kotlin.foo.qux(Foo.kt:3)

> Internal compiler error. See log for more details
`;
    expect(extractCompilerErrors(output)).toEqual([
      "e: org.jetbrains.kotlin.util.FileAnalysisException: While analysing /project/Foo.kt:30:49: java.lang.IllegalStateException: Shouldn't be here",
    ]);
  });

  it('returns multiple "e:" lines when present', () => {
    const output = "e: first error\nsome other line\ne: second error\n\tat some.Frame(File.kt:1)";
    expect(extractCompilerErrors(output)).toEqual(['e: first error', 'e: second error']);
  });

  it('returns an empty array when there are no "e:" lines', () => {
    expect(extractCompilerErrors('BUILD SUCCESSFUL\n0 tests completed')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runAndroidChecks: version-catalog awareness (via collectDoctorChecks, no gradle spawn)
// ---------------------------------------------------------------------------

async function writeAndroidProject(
  dir: string,
  files: { buildGradleKts?: string; libsVersionsToml?: string; buildSrc?: boolean; buildLogic?: boolean },
): Promise<void> {
  await writeFile(
    join(dir, 'phonebook.config.json'),
    JSON.stringify({ appName: 'test', platform: 'android', android: { modules: [], variant: 'debug' } }, null, 2),
  );
  if (files.buildGradleKts !== undefined) {
    await writeFile(join(dir, 'build.gradle.kts'), files.buildGradleKts);
  }
  if (files.libsVersionsToml !== undefined) {
    await mkdir(join(dir, 'gradle'), { recursive: true });
    await writeFile(join(dir, 'gradle', 'libs.versions.toml'), files.libsVersionsToml);
  }
  if (files.buildSrc) await mkdir(join(dir, 'buildSrc'), { recursive: true });
  if (files.buildLogic) await mkdir(join(dir, 'build-logic'), { recursive: true });
}

describe('collectDoctorChecks: android version-catalog + configuration awareness', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('does not report a false green when the catalog-declared dependency is only under androidTestImplementation', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidProject(dir, {
      buildGradleKts: `
plugins {
    id("io.github.takahirom.roborazzi") version "1.72.0"
}

roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
    }
}

dependencies {
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
`,
      libsVersionsToml: `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
`,
    });

    const { lines } = await collectDoctorChecks(dir);
    const composeTestDepsLine = lines.find((l) => l.startsWith('FAIL compose-test-deps') || l.startsWith('ok compose-test-deps'));
    expect(composeTestDepsLine).toContain('FAIL compose-test-deps');
    expect(composeTestDepsLine).toContain('androidTestImplementation');
    expect(composeTestDepsLine).toContain('not on the unit-test compile classpath');
  });

  it('passes compose-test-deps once a qualifying testImplementation line is present too', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidProject(dir, {
      buildGradleKts: `
plugins {
    id("io.github.takahirom.roborazzi") version "1.72.0"
}

roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
    }
}

dependencies {
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.androidx.compose.ui.test.junit4)
}
`,
      libsVersionsToml: `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
`,
    });

    const { lines } = await collectDoctorChecks(dir);
    const composeTestDepsLine = lines.find((l) => l.includes('compose-test-deps'));
    expect(composeTestDepsLine).toContain('ok compose-test-deps');
    expect(composeTestDepsLine).toContain('via version catalog');
  });

  it('downgrades a not-found roborazzi-plugin check to a note when buildSrc/ is present', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidProject(dir, {
      buildGradleKts: 'plugins {\n    id("com.android.application")\n}\n',
      buildSrc: true,
    });

    const { lines } = await collectDoctorChecks(dir);
    const roborazziLine = lines.find((l) => l.includes('roborazzi-plugin'));
    expect(roborazziLine).toContain('note roborazzi-plugin');
    expect(roborazziLine).toContain('build-logic/buildSrc');
    expect(roborazziLine).toContain('doctor --deep');
  });

  it('downgrades a not-found roborazzi-plugin check to a note when build-logic/ is present', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidProject(dir, {
      buildGradleKts: 'plugins {\n    id("com.android.application")\n}\n',
      buildLogic: true,
    });

    const { lines } = await collectDoctorChecks(dir);
    const roborazziLine = lines.find((l) => l.includes('roborazzi-plugin'));
    expect(roborazziLine).toContain('note roborazzi-plugin');
  });

  it('still FAILs the roborazzi-plugin check when there is no buildSrc/build-logic to blame', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidProject(dir, {
      buildGradleKts: 'plugins {\n    id("com.android.application")\n}\n',
    });

    const { lines } = await collectDoctorChecks(dir);
    const roborazziLine = lines.find((l) => l.includes('roborazzi-plugin'));
    expect(roborazziLine).toContain('FAIL roborazzi-plugin');
  });
});

// ---------------------------------------------------------------------------
// preview-packages check
// ---------------------------------------------------------------------------

async function writeAndroidAppModule(
  dir: string,
  opts: { buildGradleKts: string; sources?: Record<string, string> },
): Promise<void> {
  await writeFile(
    join(dir, 'phonebook.config.json'),
    JSON.stringify({ appName: 'test', platform: 'android', android: { modules: [':app'], variant: 'debug' } }, null, 2),
  );
  await mkdir(join(dir, 'app'), { recursive: true });
  await writeFile(join(dir, 'app', 'build.gradle.kts'), opts.buildGradleKts);
  for (const [relPath, content] of Object.entries(opts.sources ?? {})) {
    const full = join(dir, 'app', 'src', 'main', 'java', ...relPath.split('/'));
    await mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    await writeFile(full, content);
  }
}

describe('collectDoctorChecks: preview-packages', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const roborazziPlugin = `
plugins {
    id("io.github.takahirom.roborazzi") version "1.72.0"
}

dependencies {
    testImplementation("io.github.sergio-sastre.ComposablePreviewScanner:android:0.9.3")
}
`;

  it('FAILs when no packages = listOf(...) is present at all', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidAppModule(dir, {
      buildGradleKts: `${roborazziPlugin}
roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
    }
}
`,
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('preview-packages'));
    expect(line).toContain('FAIL preview-packages');
    expect(line).toContain('no packages = listOf(...)');
  });

  it('FAILs on a literal placeholder package left over from init instructions', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidAppModule(dir, {
      buildGradleKts: `${roborazziPlugin}
roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
        packages = listOf("<your package>")
    }
}
`,
      sources: { 'dev/stag/sample/MainActivity.kt': 'package dev.stag.sample\n' },
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('preview-packages'));
    expect(line).toContain('FAIL preview-packages');
    expect(line).toContain('is a placeholder from the setup instructions');
    expect(line).toContain('detected: dev.stag.sample');
  });

  it('FAILs on a REPLACE_ME placeholder package', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidAppModule(dir, {
      buildGradleKts: `${roborazziPlugin}
roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
        packages = listOf("REPLACE_ME.your.app.package")
    }
}
`,
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('preview-packages'));
    expect(line).toContain('FAIL preview-packages');
    expect(line).toContain('is a placeholder from the setup instructions');
  });

  it('FAILs when the configured package does not exist in the module sources', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidAppModule(dir, {
      buildGradleKts: `${roborazziPlugin}
roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
        packages = listOf("dev.stag.wrong")
    }
}
`,
      sources: { 'dev/stag/sample/MainActivity.kt': 'package dev.stag.sample\n' },
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('preview-packages'));
    expect(line).toContain('FAIL preview-packages');
    expect(line).toContain('package "dev.stag.wrong" was not found in :app sources');
    expect(line).toContain('detected: dev.stag.sample');
  });

  it('passes and counts @Preview annotations on the happy path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidAppModule(dir, {
      buildGradleKts: `${roborazziPlugin}
roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
        packages = listOf("dev.stag.sample")
    }
}
`,
      sources: {
        'dev/stag/sample/MainActivity.kt': 'package dev.stag.sample\n',
        'dev/stag/sample/UserCard.kt': 'package dev.stag.sample\n\n@Preview\nfun UserCardPreview() {}\n\n@Preview\nfun UserCardDarkPreview() {}\n',
      },
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('preview-packages'));
    expect(line).toContain('ok preview-packages');
    expect(line).toContain('packages = listOf("dev.stag.sample")');
    expect(line).toContain('2 @Preview annotation(s) found');
  });

  it('also accepts the Groovy packages = ["a", "b"] form', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-'));
    await writeAndroidAppModule(dir, {
      buildGradleKts: `${roborazziPlugin}
roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
        packages = ["dev.stag.sample"]
    }
}
`,
      sources: { 'dev/stag/sample/MainActivity.kt': 'package dev.stag.sample\n' },
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('preview-packages'));
    expect(line).toContain('ok preview-packages');
  });
});

// ---------------------------------------------------------------------------
// snapshot-test-class check (iOS)
// ---------------------------------------------------------------------------

async function writeIosProject(
  dir: string,
  opts: { pbxprojText?: string; sources?: Record<string, string> } = {},
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
  await writeFile(
    join(dir, 'App.xcodeproj', 'project.pbxproj'),
    opts.pbxprojText ?? '// !$*UTF8*$!\n{ /* SnapshottingTests wired in */ }\n',
  );
  for (const [relPath, content] of Object.entries(opts.sources ?? {})) {
    const full = join(dir, ...relPath.split('/'));
    await mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    await writeFile(full, content);
  }
}

const SNAPSHOT_TEST_CLASS_SOURCE = `import SnapshottingTests

class Snapshots: SnapshotTest {
  override class func snapshotPreviews() -> [String]? { nil }
}
`;

describe('collectDoctorChecks: snapshot-test-class (iOS)', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('passes when a SnapshotTest subclass exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-ios-'));
    await writeIosProject(dir, {
      sources: { 'App/Tests/Snapshots.swift': SNAPSHOT_TEST_CLASS_SOURCE },
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('snapshot-test-class'));
    expect(line).toContain('ok snapshot-test-class');
    expect(line).toContain('SnapshotTest subclass found: Snapshots');
    expect(line).toContain('App/Tests/Snapshots.swift');
  });

  it('FAILs with a setup snippet when wiring is present but no subclass exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-ios-'));
    await writeIosProject(dir);

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('snapshot-test-class'));
    expect(line).toContain('FAIL snapshot-test-class');
    expect(line).toContain('SnapshotTest subclass');
    expect(line).toContain('class Snapshots: SnapshotTest');
  });

  it('ignores a SnapshotTest subclass that exists only under a checkouts/ path, still FAILing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-ios-'));
    await writeIosProject(dir, {
      sources: {
        '.build/checkouts/SnapshotPreviews/Sources/SnapshotTest.swift': SNAPSHOT_TEST_CLASS_SOURCE,
        'checkouts/OtherPkg/Sources/Snapshots.swift': SNAPSHOT_TEST_CLASS_SOURCE,
      },
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('snapshot-test-class'));
    expect(line).toContain('FAIL snapshot-test-class');
    expect(line).toContain('SnapshotTest subclass');
  });
});

describe('findSnapshotTestSubclass', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('finds a subclass and reports its class name and relative path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-swift-scan-'));
    await mkdir(join(dir, 'Tests'), { recursive: true });
    await writeFile(join(dir, 'Tests', 'Snapshots.swift'), SNAPSHOT_TEST_CLASS_SOURCE);

    const result = await findSnapshotTestSubclass(dir);
    expect(result).toEqual({
      className: 'Snapshots',
      relativePath: join('Tests', 'Snapshots.swift'),
      importsSnapshottingTests: true,
    });
  });

  it('returns undefined when no subclass exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-swift-scan-'));
    await mkdir(join(dir, 'Tests'), { recursive: true });
    await writeFile(join(dir, 'Tests', 'Foo.swift'), 'struct Foo {}\n');

    expect(await findSnapshotTestSubclass(dir)).toBeUndefined();
  });

  it('skips .build, DerivedData, Pods, .git, and any checkouts directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-swift-scan-'));
    for (const skipped of ['.build/checkouts', 'DerivedData', 'Pods', '.git', 'Vendor/checkouts']) {
      const full = join(dir, skipped);
      await mkdir(full, { recursive: true });
      await writeFile(join(full, 'Snapshots.swift'), SNAPSHOT_TEST_CLASS_SOURCE);
    }

    expect(await findSnapshotTestSubclass(dir)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findMissingTestHostNote (iOS pbxproj heuristic)
// ---------------------------------------------------------------------------

function fakePbxprojTarget(opts: { testHost?: boolean; synchronizedFolder?: string; targetName?: string }): string {
  const targetName = opts.targetName ?? 'MyTests';
  const testHostLine = opts.testHost ? '\t\t\t\tTEST_HOST = "$(BUILT_PRODUCTS_DIR)/App.app/App";\n' : '';
  const syncGroupsLine = opts.synchronizedFolder
    ? `\t\t\tfileSystemSynchronizedGroups = (\n\t\t\t\tFFFFFFFFFFFFFFFFFFFFFFFF /* ${opts.synchronizedFolder} */,\n\t\t\t);\n`
    : '';
  const syncGroupSection = opts.synchronizedFolder
    ? `
/* Begin PBXFileSystemSynchronizedRootGroup section */
\t\tFFFFFFFFFFFFFFFFFFFFFFFF /* ${opts.synchronizedFolder} */ = {
\t\t\tisa = PBXFileSystemSynchronizedRootGroup;
\t\t\tpath = ${opts.synchronizedFolder};
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXFileSystemSynchronizedRootGroup section */
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
\t\t\t\tEEEEEEEEEEEEEEEEEEEEEEEE /* Release */,
\t\t\t);
\t\t};
\t\tDDDDDDDDDDDDDDDDDDDDDDDD /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${testHostLine}\t\t\t\tPRODUCT_NAME = ${targetName};
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\tEEEEEEEEEEEEEEEEEEEEEEEE /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tPRODUCT_NAME = ${targetName};
\t\t\t};
\t\t\tname = Release;
\t\t};
${syncGroupSection}}
`;
}

describe('findMissingTestHostNote', () => {
  it('returns undefined when SnapshottingTests is not referenced at all', () => {
    expect(findMissingTestHostNote('// !$*UTF8*$!\n{ /* nothing here */ }\n')).toBeUndefined();
  });

  it('notes a missing TEST_HOST when the target linking SnapshottingTests has none in any build configuration', () => {
    const note = findMissingTestHostNote(fakePbxprojTarget({ testHost: false }));
    expect(note).toContain('no TEST_HOST');
    expect(note).toContain('hosted in the app');
  });

  it('is silent when the target linking SnapshottingTests has a TEST_HOST in at least one build configuration', () => {
    expect(findMissingTestHostNote(fakePbxprojTarget({ testHost: true }))).toBeUndefined();
  });
});

describe('findSnapshotTestClassLocation', () => {
  it('returns undefined when the SnapshottingTests-linking target cannot be identified', () => {
    expect(findSnapshotTestClassLocation('// !$*UTF8*$!\n{ /* nothing here */ }\n')).toBeUndefined();
  });

  it('resolves the synchronized-group folder for a project using filesystem-synchronized groups', () => {
    const location = findSnapshotTestClassLocation(fakePbxprojTarget({ synchronizedFolder: 'UnitTests' }));
    expect(location).toEqual({ targetName: 'MyTests', synchronizedFolder: 'UnitTests' });
  });

  it('identifies the target name with no synchronizedFolder when the project has no synchronized groups', () => {
    const location = findSnapshotTestClassLocation(fakePbxprojTarget({}));
    expect(location).toEqual({ targetName: 'MyTests', synchronizedFolder: undefined });
  });
});

// ---------------------------------------------------------------------------
// snapshot-test-class FAIL message: location-aware wording
// ---------------------------------------------------------------------------

describe('collectDoctorChecks: snapshot-test-class location-aware FAIL message', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('names the synchronized-group folder and mentions --write-snapshot-class when the project uses one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-ios-'));
    await writeIosProject(dir, {
      pbxprojText: fakePbxprojTarget({ targetName: 'UnitTests', synchronizedFolder: 'UnitTests' }),
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('snapshot-test-class'));
    expect(line).toContain('FAIL snapshot-test-class');
    expect(line).toContain('Add the file UnitTests/PhonebookSnapshots.swift');
    expect(line).toContain('synchronized groups');
    expect(line).toContain('phonebook init --write-snapshot-class');
    expect(line).toContain('class Snapshots: SnapshotTest');
  });

  it('uses the Xcode-add-files wording and does not mention the flag when there is no synchronized group', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-ios-'));
    await writeIosProject(dir, {
      pbxprojText: fakePbxprojTarget({ targetName: 'MyTests' }),
    });

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('snapshot-test-class'));
    expect(line).toContain('FAIL snapshot-test-class');
    expect(line).toContain('add it to the MyTests target in Xcode');
    expect(line).toContain('File > Add Files');
    expect(line).not.toContain('--write-snapshot-class');
    expect(line).toContain('class Snapshots: SnapshotTest');
  });

  it('falls back to the generic wording when the linking target cannot be identified', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-doctor-ios-'));
    await writeIosProject(dir); // default pbxprojText has no PBXNativeTarget structure at all

    const { lines } = await collectDoctorChecks(dir);
    const line = lines.find((l) => l.includes('snapshot-test-class'));
    expect(line).toContain('FAIL snapshot-test-class');
    expect(line).toContain('Add to your test target');
    expect(line).not.toContain('--write-snapshot-class');
  });
});
