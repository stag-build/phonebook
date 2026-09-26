import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkEmptyEntries,
  EMPTY_PREVIEWS_MESSAGE,
  generateAndroid,
  kotlinFacadeClass,
  moduleOfFile,
  planPreviewFilter,
  previewSizeQualifiers,
  roborazziOutputDir,
  roborazziStagingDir,
  testsPatternForClass,
} from './android.js';

describe('previewSizeQualifiers', () => {
  it('infers orientation from dimensions', () => {
    expect(previewSizeQualifiers({ widthDp: 393, heightDp: 852 })).toBe('w393dp-h852dp-port');
    expect(previewSizeQualifiers({ widthDp: 852, heightDp: 393 })).toBe('w852dp-h393dp-land');
    expect(previewSizeQualifiers({ widthDp: 500, heightDp: 500 })).toBe('w500dp-h500dp-port');
  });
});

describe('checkEmptyEntries', () => {
  it('throws with the diagnostic message when there are zero entries and allowEmpty is false', () => {
    expect(() => checkEmptyEntries(0, false)).toThrow(EMPTY_PREVIEWS_MESSAGE);
  });

  it('does not throw when there are zero entries but allowEmpty is true', () => {
    expect(() => checkEmptyEntries(0, true)).not.toThrow();
  });

  it('does not throw when there are entries, regardless of allowEmpty', () => {
    expect(() => checkEmptyEntries(3, false)).not.toThrow();
    expect(() => checkEmptyEntries(3, true)).not.toThrow();
  });
});

const kt = (pkg: string, body = '@Preview @Composable fun FooPreview() {}') =>
  `package ${pkg}\n\nimport androidx.compose.runtime.Composable\n\n${body}\n`;

describe('kotlinFacadeClass', () => {
  it('appends Kt to the capitalized file name', () => {
    expect(kotlinFacadeClass('app/src/main/java/dev/stag/PrimaryButton.kt')).toBe('PrimaryButtonKt');
    expect(kotlinFacadeClass('userCard.kt')).toBe('UserCardKt');
  });
});

describe('moduleOfFile', () => {
  it('maps a file onto its Gradle module directory', () => {
    expect(moduleOfFile('app/src/main/A.kt', [':app', ':core'])).toBe(':app');
    expect(moduleOfFile('core/src/main/A.kt', [':app', ':core'])).toBe(':core');
  });

  it('prefers the deepest module when one nests inside another', () => {
    expect(moduleOfFile('features/home/src/A.kt', [':features', ':features:home'])).toBe(':features:home');
  });

  it('returns undefined for a file outside every module', () => {
    expect(moduleOfFile('docs/README.kt', [':app'])).toBeUndefined();
  });
});

describe('planPreviewFilter', () => {
  it('turns a Kotlin file into a --tests pattern for its facade class', () => {
    const plan = planPreviewFilter(
      [{ file: 'app/src/main/java/dev/stag/PrimaryButton.kt', source: kt('dev.stag') }],
      [':app'],
    );
    expect(plan.warnings).toEqual([]);
    expect(plan.byModule.get(':app')).toEqual([testsPatternForClass('dev.stag.PrimaryButtonKt')]);
  });

  it('produces a pattern Gradle matches against the generated parameterized test name', () => {
    const pattern = testsPatternForClass('dev.stag.PrimaryButtonKt');
    // Gradle compiles `--tests` by quoting everything and turning * into .*,
    // then full-matching against "className.methodName".
    const regex = new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    const name =
      'com.github.takahirom.roborazzi.RoborazziPreviewParameterizedTests' +
      '.test[JUnit4TestParameter(preview=dev.stag.PrimaryButtonKt_PrimaryButtonEnabledPreview)]';
    expect(regex.test(name)).toBe(true);
    // The sharded class name (generatedTestClassCount > 1) matches too.
    expect(regex.test(name.replace('Tests.test', 'Tests3.test'))).toBe(true);
    // A preview from another file does not.
    expect(regex.test(name.replace('PrimaryButtonKt_', 'UserCardKt_'))).toBe(false);
  });

  it('also covers previews declared inside a top-level class or object in the file', () => {
    const plan = planPreviewFilter(
      [
        {
          file: 'app/src/main/java/dev/stag/Cards.kt',
          source: kt('dev.stag', 'class CardPreviews {\n  @Preview @Composable fun Foo() {}\n}'),
        },
      ],
      [':app'],
    );
    expect(plan.byModule.get(':app')).toEqual([
      testsPatternForClass('dev.stag.CardsKt'),
      testsPatternForClass('dev.stag.CardPreviews'),
    ]);
  });

  it('groups patterns per module and leaves untouched modules out of the plan', () => {
    const plan = planPreviewFilter(
      [
        { file: 'app/src/main/java/dev/stag/A.kt', source: kt('dev.stag') },
        { file: 'app/src/main/java/dev/stag/B.kt', source: kt('dev.stag') },
      ],
      [':app', ':core'],
    );
    expect(plan.byModule.get(':app')).toHaveLength(2);
    expect(plan.byModule.has(':core')).toBe(false);
  });

  it('ignores files that cannot declare a Compose preview', () => {
    const plan = planPreviewFilter(
      [
        { file: 'app/build.gradle.kts', source: 'plugins {}' },
        { file: 'app/src/main/res/values/strings.xml', source: '<resources/>' },
      ],
      [':app'],
    );
    expect(plan.byModule.size).toBe(0);
  });

  it('falls back to the whole module, with a warning, when the facade class is renamed', () => {
    const plan = planPreviewFilter(
      [{ file: 'app/src/main/java/dev/stag/A.kt', source: `@file:JvmName("Widgets")\n${kt('dev.stag')}` }],
      [':app'],
    );
    expect(plan.byModule.get(':app')).toEqual([]);
    expect(plan.warnings[0]).toContain('@file:JvmName');
  });

  it('falls back to the whole module when a file could not be read', () => {
    const plan = planPreviewFilter([{ file: 'app/src/main/java/dev/stag/A.kt' }], [':app']);
    expect(plan.byModule.get(':app')).toEqual([]);
    expect(plan.warnings[0]).toContain('app/src/main/java/dev/stag/A.kt');
  });

  it('keeps the unfiltered fallback even when a later file in the module resolves', () => {
    const plan = planPreviewFilter(
      [
        { file: 'app/src/main/java/dev/stag/A.kt' },
        { file: 'app/src/main/java/dev/stag/B.kt', source: kt('dev.stag') },
      ],
      [':app'],
    );
    expect(plan.byModule.get(':app')).toEqual([]);
  });

  it('handles a file with no package declaration', () => {
    const plan = planPreviewFilter(
      [{ file: 'app/src/main/java/A.kt', source: '@Preview @Composable fun FooPreview() {}' }],
      [':app'],
    );
    expect(plan.byModule.get(':app')).toEqual([testsPatternForClass('AKt')]);
  });
});

/**
 * Regression: a `--files` run must harvest only what *this* invocation
 * rendered.
 *
 * Harvesting copies the module's whole Roborazzi output directory, so PNGs a
 * previous `generate` left there were reported in the new manifest as if they
 * had just been rendered — byte-identical stale images, indistinguishable to a
 * consumer because the manifest schema carries no timestamp or run id.
 *
 * The real Gradle build is out of scope for `npm test` (it needs an Android
 * SDK); the android-integration CI job covers that end to end against
 * samples/android. Here the Gradle invocation is replaced by a fake that
 * stages exactly what a correctly narrowed run produces, which is enough to
 * pin the behaviour under test: what the harvest step can still see once the
 * recording step has run.
 */
describe('generateAndroid harvesting', () => {
  const sampleDir = resolve(import.meta.dirname, '../../samples/android');
  const config = { appName: 'Sample', platform: 'android' as const, android: { modules: [':app'] } };
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A PNG whose IHDR readPngSize can parse. `tint` varies the bytes. */
  function png(tint: number): Buffer {
    const header = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
      4, 0, 0, 0, 2, 8, 6, 0, 0, 0,
    ]);
    return Buffer.concat([header, Buffer.from([tint])]);
  }

  /** samples/android's real sources + config, in a scratch copy we may dirty. */
  async function sampleProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'phonebook-android-'));
    tmpDirs.push(dir);
    await mkdir(join(dir, 'app'), { recursive: true });
    await cp(join(sampleDir, 'app', 'src'), join(dir, 'app', 'src'), { recursive: true });
    await cp(join(sampleDir, 'phonebook.config.json'), join(dir, 'phonebook.config.json'));
    return dir;
  }

  /** `name` may contain "/" — Roborazzi turns a display name's "/" into a real subdirectory. */
  async function writePng(dir: string, name: string, tint: number): Promise<void> {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, png(tint));
  }

  const PRIMARY_BUTTON = 'app/src/main/java/dev/stag/phonebook/sample/PrimaryButton.kt';
  // Exactly the names Roborazzi 1.72.0 writes for samples/android, verified
  // against a real `recordRoborazziDebug` run.
  const STALE = 'dev.stag.phonebook.sample.UserCardKt.UserCardPreview.png';
  const FRESH =
    'dev.stag.phonebook.sample.PrimaryButtonKt.PrimaryButtonEnabledPreview.Button/Enabled.png';

  it('drops PNGs left in the output directory by an earlier run', async () => {
    const projectDir = await sampleProject();
    const outputDir = join(projectDir, 'phonebook-out');
    const outDir = roborazziOutputDir(projectDir, ':app');

    // A previous `generate --files UserCard.kt` left this behind.
    await writePng(outDir, STALE, 1);

    let sawTestsFilter: string[] = [];
    const manifest = await generateAndroid(config, projectDir, outputDir, {
      quiet: true,
      files: [PRIMARY_BUTTON],
      // A correctly narrowed Gradle run renders PrimaryButton's previews only.
      recordWith: async (_module, extraArgs) => {
        sawTestsFilter = extraArgs;
        await writePng(outDir, FRESH, 2);
      },
    });

    // The filter is still narrowed to the requested file — this fix must not
    // widen what Gradle runs, only what the harvest can see afterwards.
    expect(sawTestsFilter).toContain('--tests');
    expect(sawTestsFilter.join(' ')).toContain('PrimaryButtonKt');

    expect(manifest.entries.map((e) => `${e.component}/${e.state}`)).toEqual(['Button/Enabled']);
    expect(manifest.entries.some((e) => e.previewName.includes('UserCard'))).toBe(false);
  });

  it('clears the staging directory too, so finalize cannot restore a stale PNG', async () => {
    const projectDir = await sampleProject();
    const outputDir = join(projectDir, 'phonebook-out');

    // Roborazzi's test task writes here and `finalizeTestRoborazzi<Variant>`
    // copies it into outputs/. Clearing only outputs/ lets the stale PNG come
    // straight back on the next run — the bug appears fixed exactly once.
    await writePng(roborazziStagingDir(projectDir, ':app'), STALE, 1);
    await writePng(roborazziOutputDir(projectDir, ':app'), STALE, 1);

    const manifest = await generateAndroid(config, projectDir, outputDir, {
      quiet: true,
      files: [PRIMARY_BUTTON],
      recordWith: async () => {
        // Stand in for finalize: copy whatever is staged into outputs/.
        await writePng(roborazziStagingDir(projectDir, ':app'), FRESH, 2);
        await cp(roborazziStagingDir(projectDir, ':app'), roborazziOutputDir(projectDir, ':app'), {
          recursive: true,
        });
      },
    });

    expect(manifest.entries.map((e) => `${e.component}/${e.state}`)).toEqual(['Button/Enabled']);
  });

  it('still harvests a module this run deliberately skipped', async () => {
    const projectDir = await sampleProject();
    const outputDir = join(projectDir, 'phonebook-out');

    // No configured module owns this path, so :app is skipped and its previous
    // PNGs are what the bundle reports — the documented `--files` behaviour.
    await writePng(roborazziOutputDir(projectDir, ':app'), STALE, 1);

    let recorded = false;
    const manifest = await generateAndroid(config, projectDir, outputDir, {
      quiet: true,
      files: ['docs/README.md'],
      recordWith: async () => {
        recorded = true;
      },
    });

    expect(recorded).toBe(false);
    expect(manifest.entries.map((e) => `${e.component}/${e.state}`)).toEqual(['User Card/Default']);
  });

  it('retries unfiltered when a scoped --tests run records nothing', async () => {
    const projectDir = await sampleProject();
    const outputDir = join(projectDir, 'phonebook-out');
    const outDir = roborazziOutputDir(projectDir, ':app');

    // Reproduces the real failure: Gradle's `--tests` can select the shared
    // generated class, but not an individual parameterized preview inside it
    // (its display name is resolved at run time, after Gradle has already
    // picked which tests to run) — so the scoped invocation builds nothing,
    // even though the file genuinely declares previews.
    const seenExtraArgs: string[][] = [];
    const manifest = await generateAndroid(config, projectDir, outputDir, {
      quiet: true,
      files: [PRIMARY_BUTTON],
      recordWith: async (_module, extraArgs) => {
        seenExtraArgs.push(extraArgs);
        if (extraArgs.length > 0) return; // scoped call: records nothing
        await writePng(outDir, FRESH, 2); // unfiltered retry: records for real
      },
    });

    expect(seenExtraArgs).toHaveLength(2);
    expect(seenExtraArgs[0]).toContain('--tests');
    expect(seenExtraArgs[1]).toEqual([]);
    expect(manifest.entries.map((e) => `${e.component}/${e.state}`)).toEqual(['Button/Enabled']);
  });
});
