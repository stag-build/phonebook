import { describe, expect, it } from 'vitest';
import {
  checkEmptyEntries,
  EMPTY_PREVIEWS_MESSAGE,
  kotlinFacadeClass,
  moduleOfFile,
  planPreviewFilter,
  testsPatternForClass,
} from './android.js';

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
