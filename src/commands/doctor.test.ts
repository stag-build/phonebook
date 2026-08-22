import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectDoctorChecks,
  extractCompilerErrors,
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
