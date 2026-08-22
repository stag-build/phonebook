import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accessorFor,
  findLibrary,
  findPlugin,
  loadVersionCatalog,
  parseCatalogDeclarations,
  parseVersionCatalogText,
  pluginAccessorFor,
  UNIT_TEST_CONFIGURATIONS,
} from './catalog.js';

describe('accessorFor', () => {
  it('replaces - and _ with . and prefixes libs.', () => {
    expect(accessorFor('androidx-compose-ui-test-junit4')).toBe('libs.androidx.compose.ui.test.junit4');
    expect(accessorFor('some_alias-name')).toBe('libs.some.alias.name');
  });
});

describe('pluginAccessorFor', () => {
  it('replaces - and _ with . and prefixes libs.plugins.', () => {
    expect(pluginAccessorFor('roborazzi')).toBe('libs.plugins.roborazzi');
    expect(pluginAccessorFor('kotlin-android')).toBe('libs.plugins.kotlin.android');
  });
});

describe('parseVersionCatalogText', () => {
  it('parses [versions]', () => {
    const toml = `
[versions]
roborazzi = "1.72.0"
# a comment
kotlin = "2.1.0"
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.versions.get('roborazzi')).toBe('1.72.0');
    expect(catalog.versions.get('kotlin')).toBe('2.1.0');
  });

  it('parses library string form "group:name:version"', () => {
    const toml = `
[libraries]
roborazzi = "io.github.takahirom.roborazzi:roborazzi:1.72.0"
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.libraries).toEqual([
      {
        alias: 'roborazzi',
        accessor: 'libs.roborazzi',
        group: 'io.github.takahirom.roborazzi',
        name: 'roborazzi',
        version: '1.72.0',
      },
    ]);
  });

  it('parses library object form with module + version', () => {
    const toml = `
[libraries]
roborazzi = { module = "io.github.takahirom.roborazzi:roborazzi", version = "1.72.0" }
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.libraries[0]).toMatchObject({
      group: 'io.github.takahirom.roborazzi',
      name: 'roborazzi',
      version: '1.72.0',
    });
  });

  it('parses library object form with module + version.ref, resolving against [versions]', () => {
    const toml = `
[versions]
roborazzi = "1.72.0"

[libraries]
roborazzi = { module = "io.github.takahirom.roborazzi:roborazzi", version.ref = "roborazzi" }
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.libraries[0].version).toBe('1.72.0');
  });

  it('parses library object form with group + name + version', () => {
    const toml = `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4", version = "1.7.0" }
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.libraries[0]).toMatchObject({
      alias: 'androidx-compose-ui-test-junit4',
      accessor: 'libs.androidx.compose.ui.test.junit4',
      group: 'androidx.compose.ui',
      name: 'ui-test-junit4',
      version: '1.7.0',
    });
  });

  it('parses library object form with group + name + version.ref', () => {
    const toml = `
[versions]
composeUiTest = "1.7.0"

[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4", version.ref = "composeUiTest" }
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.libraries[0].version).toBe('1.7.0');
  });

  it('parses library object form with group + name and no version (BOM-managed)', () => {
    const toml = `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.libraries[0]).toMatchObject({
      group: 'androidx.compose.ui',
      name: 'ui-test-junit4',
      version: undefined,
    });
  });

  it('parses the nested "version = { ref = ... }" form', () => {
    const toml = `
[versions]
roborazzi = "1.72.0"

[libraries]
roborazzi = { module = "io.github.takahirom.roborazzi:roborazzi", version = { ref = "roborazzi" } }
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.libraries[0].version).toBe('1.72.0');
  });

  it('parses plugin object form with id + version.ref', () => {
    const toml = `
[versions]
roborazzi = "1.72.0"

[plugins]
roborazzi = { id = "io.github.takahirom.roborazzi", version.ref = "roborazzi" }
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.plugins).toEqual([
      { alias: 'roborazzi', accessor: 'libs.plugins.roborazzi', id: 'io.github.takahirom.roborazzi', version: '1.72.0' },
    ]);
  });

  it('parses plugin object form with id + version', () => {
    const toml = `
[plugins]
roborazzi = { id = "io.github.takahirom.roborazzi", version = "1.72.0" }
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.plugins[0]).toMatchObject({ id: 'io.github.takahirom.roborazzi', version: '1.72.0' });
  });

  it('parses plugin string form "id:version"', () => {
    const toml = `
[plugins]
roborazzi = "io.github.takahirom.roborazzi:1.72.0"
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.plugins[0]).toMatchObject({ id: 'io.github.takahirom.roborazzi', version: '1.72.0' });
  });

  it('ignores comments and blank lines', () => {
    const toml = `
# top comment
[versions] # section comment
roborazzi = "1.72.0" # trailing comment

[libraries]
# another comment
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.versions.get('roborazzi')).toBe('1.72.0');
    expect(catalog.libraries).toEqual([]);
  });
});

describe('findLibrary', () => {
  it('finds a literal coordinate with a version', () => {
    const gradleText = 'testImplementation("androidx.compose.ui:ui-test-junit4:1.7.0")';
    const result = findLibrary(gradleText, undefined, 'androidx.compose.ui', 'ui-test-junit4');
    expect(result).toEqual({ found: true, version: '1.7.0', via: 'literal' });
  });

  it('finds a literal coordinate with no version', () => {
    const gradleText = 'testImplementation("androidx.compose.ui:ui-test-junit4")';
    const result = findLibrary(gradleText, undefined, 'androidx.compose.ui', 'ui-test-junit4');
    expect(result).toEqual({ found: true, version: undefined, via: 'literal' });
  });

  it('finds via a version catalog accessor', () => {
    const gradleText = 'testImplementation(libs.androidx.compose.ui.test.junit4)';
    const toml = `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'androidx.compose.ui', 'ui-test-junit4');
    expect(result).toEqual({ found: true, version: undefined, via: 'catalog' });
  });

  it('reports the catalog-declared version when present', () => {
    const gradleText = 'testImplementation(libs.roborazzi)';
    const toml = `
[libraries]
roborazzi = { module = "io.github.takahirom.roborazzi:roborazzi", version = "1.72.0" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'io.github.takahirom.roborazzi', 'roborazzi');
    expect(result).toEqual({ found: true, version: '1.72.0', via: 'catalog' });
  });

  it('returns not-found when neither literal nor catalog match', () => {
    const result = findLibrary('implementation("junit:junit:4.13.2")', undefined, 'androidx.compose.ui', 'ui-test-junit4');
    expect(result).toEqual({ found: false, via: 'none' });
  });

  it('does not falsely match a longer neighbouring accessor (whole-token guard)', () => {
    // libs.roborazzi.compose must not satisfy a lookup for the "roborazzi" alias's accessor.
    const gradleText = 'testImplementation(libs.roborazzi.compose)';
    const toml = `
[libraries]
roborazzi = { module = "io.github.takahirom.roborazzi:roborazzi" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'io.github.takahirom.roborazzi', 'roborazzi');
    expect(result).toEqual({ found: false, via: 'none' });
  });

  it('does not falsely match a shorter neighbouring accessor prefix', () => {
    // libs.roborazzi must not satisfy a lookup for the "roborazzi-compose" alias's accessor.
    const gradleText = 'testImplementation(libs.roborazzi)';
    const toml = `
[libraries]
roborazzi-compose = { module = "io.github.takahirom.roborazzi:roborazzi-compose" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'io.github.takahirom.roborazzi', 'roborazzi-compose');
    expect(result).toEqual({ found: false, via: 'none' });
  });

  it('reproduces the real false-negative case: catalog accessor with group/name object entry', () => {
    const gradleText = `
dependencies {
    testImplementation(libs.androidx.compose.ui.test.junit4)
}
`;
    const toml = `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'androidx.compose.ui', 'ui-test-junit4');
    expect(result.found).toBe(true);
    expect(result.via).toBe('catalog');
  });
});

describe('findPlugin', () => {
  it('finds id("x") with a version on the same line', () => {
    const gradleText = 'id("io.github.takahirom.roborazzi") version "1.72.0"';
    const result = findPlugin(gradleText, undefined, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: true, version: '1.72.0', via: 'literal' });
  });

  it("finds id 'x' groovy form", () => {
    const gradleText = "id 'io.github.takahirom.roborazzi' version '1.72.0'";
    const result = findPlugin(gradleText, undefined, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: true, version: '1.72.0', via: 'literal' });
  });

  it('finds id("x") applied without a version', () => {
    const gradleText = 'id("io.github.takahirom.roborazzi")';
    const result = findPlugin(gradleText, undefined, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: true, version: undefined, via: 'literal' });
  });

  it('finds the plugin marker dependency coordinate', () => {
    const gradleText =
      'classpath("io.github.takahirom.roborazzi:io.github.takahirom.roborazzi.gradle.plugin:1.72.0")';
    const result = findPlugin(gradleText, undefined, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: true, version: '1.72.0', via: 'literal' });
  });

  it('finds via a version catalog plugin accessor', () => {
    const gradleText = 'alias(libs.plugins.roborazzi)';
    const toml = `
[plugins]
roborazzi = { id = "io.github.takahirom.roborazzi", version = "1.72.0" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findPlugin(gradleText, catalog, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: true, version: '1.72.0', via: 'catalog' });
  });

  it('returns not-found when neither literal nor catalog match', () => {
    const result = findPlugin('id("com.android.application")', undefined, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: false, via: 'none' });
  });

  it('does not falsely match a longer neighbouring plugin accessor (whole-token guard)', () => {
    const gradleText = 'alias(libs.plugins.roborazzi.extra)';
    const toml = `
[plugins]
roborazzi = { id = "io.github.takahirom.roborazzi" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findPlugin(gradleText, catalog, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: false, via: 'none' });
  });
});

// ---------------------------------------------------------------------------
// Configuration-aware matching
// ---------------------------------------------------------------------------

describe('findLibrary configuration awareness', () => {
  it('reports wrong-configuration for the real androidTest-only false-green case', () => {
    // androidTestImplementation is always present in this fixture; testImplementation is what a user
    // is expected to add. Without configuration awareness, "does the accessor appear anywhere" would
    // report ok even though the unit-test compile classpath never sees this dependency.
    const gradleText = `
dependencies {
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
`;
    const toml = `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'androidx.compose.ui', 'ui-test-junit4', {
      configurations: UNIT_TEST_CONFIGURATIONS,
    });
    expect(result).toEqual({
      found: false,
      via: 'wrong-configuration',
      version: undefined,
      foundConfiguration: 'androidTestImplementation',
    });
  });

  it('finds it once a qualifying testImplementation line is also present', () => {
    const gradleText = `
dependencies {
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.androidx.compose.ui.test.junit4)
}
`;
    const toml = `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'androidx.compose.ui', 'ui-test-junit4', {
      configurations: UNIT_TEST_CONFIGURATIONS,
    });
    expect(result.found).toBe(true);
    expect(result.via).toBe('catalog');
  });

  it('accepts a literal coordinate under testImplementation and rejects one under debugImplementation', () => {
    const okText = 'testImplementation("androidx.compose.ui:ui-test-junit4:1.7.0")';
    expect(
      findLibrary(okText, undefined, 'androidx.compose.ui', 'ui-test-junit4', { configurations: UNIT_TEST_CONFIGURATIONS })
        .found,
    ).toBe(true);

    const wrongText = 'debugImplementation("androidx.compose.ui:ui-test-junit4:1.7.0")';
    const wrongResult = findLibrary(wrongText, undefined, 'androidx.compose.ui', 'ui-test-junit4', {
      configurations: UNIT_TEST_CONFIGURATIONS,
    });
    expect(wrongResult.via).toBe('wrong-configuration');
    expect(wrongResult.foundConfiguration).toBe('debugImplementation');
  });

  it('handles a multi-line statement (accessor on its own line)', () => {
    const gradleText = `
dependencies {
    androidTestImplementation(
        libs.androidx.compose.ui.test.junit4
    )
}
`;
    const toml = `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'androidx.compose.ui', 'ui-test-junit4', {
      configurations: UNIT_TEST_CONFIGURATIONS,
    });
    expect(result.via).toBe('wrong-configuration');
    expect(result.foundConfiguration).toBe('androidTestImplementation');
  });
});

// ---------------------------------------------------------------------------
// Groovy DSL parity
// ---------------------------------------------------------------------------

describe('Groovy DSL support', () => {
  it('finds a literal coordinate in single-quote, no-parens Groovy style', () => {
    const gradleText = "testImplementation 'androidx.compose.ui:ui-test-junit4:1.7.0'";
    const result = findLibrary(gradleText, undefined, 'androidx.compose.ui', 'ui-test-junit4');
    expect(result).toEqual({ found: true, version: '1.7.0', via: 'literal' });
  });

  it('finds the Groovy map-form dependency declaration', () => {
    const gradleText = "testImplementation group: 'androidx.compose.ui', name: 'ui-test-junit4', version: '1.7.0'";
    const result = findLibrary(gradleText, undefined, 'androidx.compose.ui', 'ui-test-junit4');
    expect(result).toEqual({ found: true, version: '1.7.0', via: 'literal' });
  });

  it('reports wrong-configuration for a Groovy map-form declaration under androidTestImplementation', () => {
    const gradleText = "androidTestImplementation group: 'androidx.compose.ui', name: 'ui-test-junit4'";
    const result = findLibrary(gradleText, undefined, 'androidx.compose.ui', 'ui-test-junit4', {
      configurations: UNIT_TEST_CONFIGURATIONS,
    });
    expect(result.via).toBe('wrong-configuration');
    expect(result.foundConfiguration).toBe('androidTestImplementation');
  });

  it('finds "apply plugin:" (legacy Groovy application), single and double quotes', () => {
    expect(findPlugin("apply plugin: 'io.github.takahirom.roborazzi'", undefined, 'io.github.takahirom.roborazzi')).toEqual({
      found: true,
      version: undefined,
      via: 'literal',
    });
    expect(
      findPlugin('apply plugin: "io.github.takahirom.roborazzi"', undefined, 'io.github.takahirom.roborazzi'),
    ).toEqual({ found: true, version: undefined, via: 'literal' });
  });

  it('finds a buildscript classpath coordinate and extracts its version, matching on group only', () => {
    const gradleText = `
buildscript {
    dependencies {
        classpath "io.github.takahirom.roborazzi:roborazzi-gradle-plugin:1.60.0"
    }
}
`;
    const result = findPlugin(gradleText, undefined, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: true, version: '1.60.0', via: 'literal' });
  });

  it('finds a plugin via its version-catalog accessor used from Groovy (alias(...))', () => {
    const gradleText = "plugins {\n    alias(libs.plugins.roborazzi)\n}";
    const toml = `
[plugins]
roborazzi = { id = "io.github.takahirom.roborazzi", version = "1.72.0" }
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findPlugin(gradleText, catalog, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: true, version: '1.72.0', via: 'catalog' });
  });
});

// ---------------------------------------------------------------------------
// Catalog bundles
// ---------------------------------------------------------------------------

describe('bundles', () => {
  it('parses [bundles] into alias -> member aliases', () => {
    const toml = `
[bundles]
compose-test = ["androidx-compose-ui-test-junit4", "androidx-compose-ui-test-manifest"]
`;
    const catalog = parseVersionCatalogText(toml);
    expect(catalog.bundles).toEqual([
      { alias: 'compose-test', accessor: 'libs.bundles.compose.test', members: ['androidx-compose-ui-test-junit4', 'androidx-compose-ui-test-manifest'] },
    ]);
  });

  it('findLibrary succeeds via a bundle accessor referencing a matching member library', () => {
    const gradleText = 'testImplementation(libs.bundles.compose.test)';
    const toml = `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4", version = "1.7.0" }
androidx-compose-ui-test-manifest = { group = "androidx.compose.ui", name = "ui-test-manifest", version = "1.7.0" }

[bundles]
compose-test = ["androidx-compose-ui-test-junit4", "androidx-compose-ui-test-manifest"]
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'androidx.compose.ui', 'ui-test-junit4', {
      configurations: UNIT_TEST_CONFIGURATIONS,
    });
    expect(result).toEqual({ found: true, version: '1.7.0', via: 'catalog' });
  });

  it('reports wrong-configuration when a bundle is referenced under a disqualifying configuration', () => {
    const gradleText = 'androidTestImplementation(libs.bundles.compose.test)';
    const toml = `
[libraries]
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }

[bundles]
compose-test = ["androidx-compose-ui-test-junit4"]
`;
    const catalog = parseVersionCatalogText(toml);
    const result = findLibrary(gradleText, catalog, 'androidx.compose.ui', 'ui-test-junit4', {
      configurations: UNIT_TEST_CONFIGURATIONS,
    });
    expect(result.via).toBe('wrong-configuration');
    expect(result.foundConfiguration).toBe('androidTestImplementation');
  });
});

// ---------------------------------------------------------------------------
// Custom-named catalogs (versionCatalogs { create("name") { ... } })
// ---------------------------------------------------------------------------

describe('parseCatalogDeclarations', () => {
  it('extracts a custom catalog name and its declared toml path', () => {
    const settingsText = `
dependencyResolutionManagement {
    versionCatalogs {
        create("deps") {
            from(files("gradle/deps.versions.toml"))
        }
    }
}
`;
    expect(parseCatalogDeclarations(settingsText)).toEqual([{ prefix: 'deps', tomlPath: 'gradle/deps.versions.toml' }]);
  });

  it('defaults the toml path by convention when "from" is absent', () => {
    const settingsText = 'versionCatalogs {\n    create("deps") {\n    }\n}';
    expect(parseCatalogDeclarations(settingsText)).toEqual([{ prefix: 'deps', tomlPath: 'gradle/deps.versions.toml' }]);
  });

  it('returns an empty array when there are no custom catalog declarations', () => {
    expect(parseCatalogDeclarations('rootProject.name = "app"')).toEqual([]);
  });
});

describe('loadVersionCatalog with a custom-named catalog', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loads a custom catalog declared in settings.gradle.kts and resolves its prefix in accessors', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-catalog-'));
    await mkdir(join(dir, 'gradle'), { recursive: true });
    await writeFile(
      join(dir, 'settings.gradle.kts'),
      `
dependencyResolutionManagement {
    versionCatalogs {
        create("deps") {
            from(files("gradle/deps.versions.toml"))
        }
    }
}
`,
    );
    await writeFile(
      join(dir, 'gradle', 'deps.versions.toml'),
      `
[plugins]
roborazzi = { id = "io.github.takahirom.roborazzi", version = "1.72.0" }
`,
    );

    const catalogs = await loadVersionCatalog(dir);
    expect([...catalogs.keys()]).toEqual(['deps']);
    const depsCatalog = catalogs.get('deps')!;
    expect(depsCatalog.plugins[0].accessor).toBe('deps.plugins.roborazzi');

    const gradleText = 'plugins {\n    alias(deps.plugins.roborazzi)\n}';
    const result = findPlugin(gradleText, depsCatalog, 'io.github.takahirom.roborazzi');
    expect(result).toEqual({ found: true, version: '1.72.0', via: 'catalog' });
  });

  it('loads both the default libs catalog and a custom one together', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-catalog-'));
    await mkdir(join(dir, 'gradle'), { recursive: true });
    await writeFile(join(dir, 'gradle', 'libs.versions.toml'), '[versions]\nkotlin = "2.1.0"\n');
    await writeFile(
      join(dir, 'settings.gradle.kts'),
      'versionCatalogs {\n    create("deps") {\n        from(files("gradle/deps.versions.toml"))\n    }\n}',
    );
    await writeFile(join(dir, 'gradle', 'deps.versions.toml'), '[versions]\nfoo = "1.0"\n');

    const catalogs = await loadVersionCatalog(dir);
    expect(new Set(catalogs.keys())).toEqual(new Set(['libs', 'deps']));
  });
});
