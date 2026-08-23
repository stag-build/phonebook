import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { loadConfig, type PhonebookConfig } from '../config.js';
import { detectKotlinVersion, resolveMaxCompatible } from '../versions.js';
import { accessorFor, loadVersionCatalog, pluginAccessorFor } from '../gradle/catalog.js';
import {
  findSnapshotTestClassLocation,
  findSnapshotTestSubclass,
  readPbxprojText,
} from '../ios/snapshotTestClass.js';

const ROBORAZZI_GROUP = 'io.github.takahirom.roborazzi';
const ROBORAZZI_ARTIFACT = 'roborazzi';
const CPS_GROUP = 'io.github.sergio-sastre.ComposablePreviewScanner';
const CPS_ARTIFACT = 'android';

const DEFAULT_ROBORAZZI_VERSION = '1.72.0';
const DEFAULT_CPS_VERSION = '0.9.3';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Reads a module's own build.gradle(.kts) files (not the root project's), concatenated. */
async function readModuleGradleTexts(moduleDir: string): Promise<string> {
  const texts: string[] = [];
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const text = await readTextOrUndefined(join(moduleDir, name));
    if (text !== undefined) texts.push(text);
  }
  return texts.join('\n');
}

/**
 * Walks down single-child directories from `base` until reaching the first
 * level that contains .kt/.java files or branches into more than one
 * subdirectory, returning the dotted path walked as a package name. Returns
 * undefined if `base` doesn't exist or no package-like structure is found.
 */
async function detectPackageFromDirTree(base: string): Promise<string | undefined> {
  const segments: string[] = [];
  let current = base;
  for (;;) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const dirs = entries.filter((e) => e.isDirectory());
    const hasSources = entries.some((e) => e.isFile() && (e.name.endsWith('.kt') || e.name.endsWith('.java')));
    if (hasSources || dirs.length !== 1) {
      return segments.length > 0 ? segments.join('.') : undefined;
    }
    segments.push(dirs[0].name);
    current = join(current, dirs[0].name);
  }
}

/**
 * Detects an Android module's application package, trying (in order):
 * `namespace = "..."` in its build.gradle(.kts), `applicationId = "..."` in
 * the same file, the `package="..."` attribute in its AndroidManifest.xml,
 * and finally the directory structure under src/main/java or src/main/kotlin.
 */
export async function detectAndroidPackage(projectDir: string, module: string): Promise<string | undefined> {
  const moduleDir = join(projectDir, ...module.split(':').filter(Boolean));
  const gradleText = await readModuleGradleTexts(moduleDir);

  const namespaceMatch = gradleText.match(/\bnamespace\s*=?\s*['"]([^'"]+)['"]/);
  if (namespaceMatch) return namespaceMatch[1];

  const applicationIdMatch = gradleText.match(/\bapplicationId\s*=?\s*['"]([^'"]+)['"]/);
  if (applicationIdMatch) return applicationIdMatch[1];

  const manifestText = await readTextOrUndefined(join(moduleDir, 'src', 'main', 'AndroidManifest.xml'));
  if (manifestText) {
    const packageMatch = manifestText.match(/\bpackage\s*=\s*"([^"]+)"/);
    if (packageMatch) return packageMatch[1];
  }

  for (const srcRoot of ['java', 'kotlin']) {
    const pkg = await detectPackageFromDirTree(join(moduleDir, 'src', 'main', srcRoot));
    if (pkg) return pkg;
  }

  return undefined;
}

/** Detects the platform of a project directory from marker files. */
async function detectPlatform(
  projectDir: string,
): Promise<
  | { platform: 'android' }
  | { platform: 'ios'; project?: string; workspace?: string }
  | { platform: undefined }
> {
  const entries = await readdir(projectDir);

  const hasAndroid =
    entries.includes('settings.gradle') || entries.includes('settings.gradle.kts');

  const xcworkspace = entries.find((e) => extname(e) === '.xcworkspace');
  const xcodeproj = entries.find((e) => extname(e) === '.xcodeproj');
  const hasIos = Boolean(xcworkspace || xcodeproj);

  if (hasAndroid && hasIos) {
    throw new Error(
      'Detected both an Android (settings.gradle) and an iOS (.xcodeproj/.xcworkspace) project ' +
        'in this directory. Run `phonebook init` from a single-platform repo, or write ' +
        'phonebook.config.json by hand.',
    );
  }
  if (hasAndroid) return { platform: 'android' };
  if (hasIos) return { platform: 'ios', project: xcodeproj, workspace: xcworkspace };
  return { platform: undefined };
}

export async function runInit(dir: string, options: { writeSnapshotClass?: boolean } = {}): Promise<void> {
  const projectDir = resolve(dir);
  const configPath = resolve(projectDir, 'phonebook.config.json');
  const alreadyExists = await exists(configPath);

  const detected = await detectPlatform(projectDir);
  if (!detected.platform) {
    throw new Error(
      `Could not detect a platform in ${projectDir}: no settings.gradle(.kts), .xcodeproj, or ` +
        '.xcworkspace found.',
    );
  }

  if (alreadyExists) {
    console.log(`${configPath} already exists; leaving it untouched.`);
  } else {
    const appName = basename(projectDir);
    let config: PhonebookConfig;
    if (detected.platform === 'android') {
      config = {
        appName,
        platform: 'android',
        android: { modules: [':app'], variant: 'debug' },
      };
    } else {
      const projectName = basename(
        (detected.workspace ?? detected.project)!,
        extname((detected.workspace ?? detected.project)!),
      );
      config = {
        appName,
        platform: 'ios',
        ios: {
          ...(detected.workspace ? { workspace: detected.workspace } : { project: detected.project }),
          scheme: projectName,
          simulator: 'iPhone 17 Pro',
        },
      };
    }
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`Wrote ${configPath}`);
  }

  if (detected.platform === 'android') {
    let modules: string[] = [':app'];
    try {
      const loaded = await loadConfig(projectDir);
      if (loaded.config.platform === 'android') modules = loaded.config.android?.modules ?? [':app'];
    } catch {
      // Config unreadable/invalid; fall back to the default module.
    }
    await printAndroidInstructions(projectDir, modules);
    if (options.writeSnapshotClass) {
      console.log('\n--write-snapshot-class only applies to iOS projects; nothing was written.');
    }
  } else {
    printIosInstructions();
    if (options.writeSnapshotClass) {
      console.log('');
      const result = await tryWriteSnapshotClass(projectDir);
      console.log(result.message);
    }
  }
}

/**
 * The ONE exception to `init` never editing your project: writes the missing
 * SnapshotTest subclass to disk when — and only when — it's provably safe to
 * do so without touching project.pbxproj: SnapshotPreviews is wired in, the
 * linking target is identified, that target's source folder is a Xcode
 * filesystem-synchronized group (so a new file there is picked up
 * automatically), and no subclass already exists. Refuses with a clear
 * reason in every other case. Explicit opt-in via `--write-snapshot-class`;
 * default `init` behavior is unaffected.
 */
export async function tryWriteSnapshotClass(
  projectDir: string,
): Promise<{ ok: boolean; message: string; path?: string }> {
  let config: PhonebookConfig;
  try {
    const loaded = await loadConfig(projectDir);
    config = loaded.config;
  } catch (err) {
    return { ok: false, message: `--write-snapshot-class: ${(err as Error).message}` };
  }
  if (config.platform !== 'ios') {
    return { ok: false, message: '--write-snapshot-class only applies to iOS projects; nothing was written.' };
  }
  const ios = config.ios;
  if (!ios?.scheme || (!ios.project && !ios.workspace)) {
    return {
      ok: false,
      message:
        '--write-snapshot-class: phonebook.config.json: ios.scheme and ios.project/workspace are required; ' +
        'nothing was written.',
    };
  }

  const projectPath = ios.project ? resolve(projectDir, ios.project) : undefined;
  const pbxprojText = await readPbxprojText(projectDir, projectPath);
  if (!pbxprojText.includes('SnapshotPreviews') && !pbxprojText.includes('SnapshottingTests')) {
    return {
      ok: false,
      message:
        '--write-snapshot-class: SnapshotPreviews / SnapshottingTests is not wired into the project yet — see ' +
        'the setup steps above first; nothing was written.',
    };
  }

  const existing = await findSnapshotTestSubclass(projectDir);
  if (existing) {
    return {
      ok: false,
      message:
        `--write-snapshot-class: a SnapshotTest subclass already exists (${existing.className} at ` +
        `${existing.relativePath}); nothing was written.`,
    };
  }

  const location = findSnapshotTestClassLocation(pbxprojText);
  if (!location) {
    return {
      ok: false,
      message:
        '--write-snapshot-class: could not identify the target that links SnapshottingTests in the .pbxproj; ' +
        'add the SnapshotTest subclass manually (see the setup steps above). Nothing was written.',
    };
  }
  if (!location.synchronizedFolder) {
    return {
      ok: false,
      message:
        `--write-snapshot-class: the "${location.targetName}" target does not use Xcode's synchronized groups, ` +
        'so writing the file would require editing project.pbxproj — which this flag will not do. Create the ' +
        `file and add it to the ${location.targetName} target in Xcode (File > Add Files, check the ` +
        `${location.targetName} box). Nothing was written.`,
    };
  }

  const targetDir = resolve(projectDir, location.synchronizedFolder);
  const filePath = join(targetDir, 'PhonebookSnapshots.swift');
  const contents =
    IOS_SNAPSHOT_TEST_CLASS_SNIPPET.split('\n')
      .map((line) => line.replace(/^ {5}/, ''))
      .join('\n') + '\n';
  await mkdir(targetDir, { recursive: true });
  await writeFile(filePath, contents);
  return {
    ok: true,
    path: filePath,
    message:
      `Wrote ${filePath}.\nSafe because the "${location.targetName}" target uses a filesystem-synchronized ` +
      `group (${location.synchronizedFolder}/): Xcode picks up new files under it automatically, so no ` +
      'project.pbxproj edit was needed or made.',
  };
}

async function printAndroidInstructions(projectDir: string, modules: string[]): Promise<void> {
  const detected = await detectKotlinVersion(projectDir);

  let roborazziVersion = DEFAULT_ROBORAZZI_VERSION;
  let cpsVersion = DEFAULT_CPS_VERSION;
  let note: string | undefined;

  if (detected) {
    const [roborazzi, cps] = await Promise.all([
      resolveMaxCompatible(ROBORAZZI_GROUP, ROBORAZZI_ARTIFACT, detected.version),
      resolveMaxCompatible(CPS_GROUP, CPS_ARTIFACT, detected.version),
    ]);
    if (roborazzi.best) roborazziVersion = roborazzi.best;
    if (cps.best) cpsVersion = cps.best;

    const kotlinLabel = `${detected.version.major}.${detected.version.minor}.${detected.version.patch}`;
    if (roborazzi.best && roborazzi.latest && roborazzi.best !== roborazzi.latest) {
      note =
        `note: Roborazzi ${roborazzi.latest} is available but requires Kotlin >= ${roborazzi.latestNeedsKotlin}; ` +
        `your project uses ${kotlinLabel} (${detected.source}). Using ${roborazzi.best}. Upgrade Kotlin to use the latest.`;
    }
  } else {
    note = `note: could not detect this project's Kotlin version; using Roborazzi ${DEFAULT_ROBORAZZI_VERSION} / ` +
      `ComposablePreviewScanner ${DEFAULT_CPS_VERSION}. Verify these are compatible with your Kotlin version, or ` +
      'run `phonebook doctor` after wiring things up.';
  }

  const moduleBlocks = await Promise.all(
    modules.map(async (module) => {
      const pkg = await detectAndroidPackage(projectDir, module);
      return pkg
        ? { module, packagesLine: `packages = listOf("${pkg}")`, warning: undefined as string | undefined }
        : {
            module,
            packagesLine: 'packages = listOf("REPLACE_ME.your.app.package")',
            warning: `could not detect the package for ${module} — replace REPLACE_ME... before running generate`,
          };
    }),
  );

  const step2 = moduleBlocks
    .map(
      ({ module, packagesLine, warning }) => `
2. In ${module}'s build.gradle.kts, apply the plugin and add:

     plugins {
       id("io.github.takahirom.roborazzi")
     }

     dependencies {
       testImplementation("io.github.takahirom.roborazzi:roborazzi:${roborazziVersion}")
       testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:${roborazziVersion}")
       testImplementation("io.github.takahirom.roborazzi:roborazzi-compose-preview-scanner-support:${roborazziVersion}")
       testImplementation("io.github.sergio-sastre.ComposablePreviewScanner:android:${cpsVersion}")
       testImplementation("org.robolectric:robolectric:4.14.1")
       // version from your Compose BOM, or pin one
       testImplementation("androidx.compose.ui:ui-test-junit4")
     }

     @OptIn(ExperimentalRoborazziApi::class)
     roborazzi {
       generateComposePreviewRobolectricTests {
         enable = true
         ${packagesLine}
         includePrivatePreviews = true
       }
     }

     android {
       testOptions {
         unitTests {
           isIncludeAndroidResources = true
           all {
             it.systemProperties["robolectric.pixelCopyRenderMode"] = "hardware"
           }
         }
       }
     }
${warning ? `\n   note: ${warning}\n` : ''}`,
    )
    .join('\n');

  console.log(`
Next steps to wire up Roborazzi preview recording:

1. In the root build.gradle.kts, add the Roborazzi plugin:

     plugins {
       id("io.github.takahirom.roborazzi") version "${roborazziVersion}" apply false
     }
${step2}
3. Run \`phonebook doctor\` to verify the setup.
${note ? `\n${note}\n` : ''}`);

  const catalogs = await loadVersionCatalog(projectDir);
  if (catalogs.size > 0) {
    const prefix = catalogs.has('libs') ? 'libs' : [...catalogs.keys()][0];
    console.log(catalogInstructions(prefix, roborazziVersion, cpsVersion));
  }
}

/** Builds the version-catalog variant of the setup instructions, for projects that already use one. */
function catalogInstructions(prefix: string, roborazziVersion: string, cpsVersion: string): string {
  const roborazziAlias = 'roborazzi';
  const roborazziComposeAlias = 'roborazzi-compose';
  const roborazziScannerAlias = 'roborazzi-compose-preview-scanner-support';
  const cpsAlias = 'composable-preview-scanner';
  const robolectricAlias = 'robolectric';
  const uiTestJunit4Alias = 'androidx-compose-ui-test-junit4';
  const pluginAlias = 'roborazzi';

  return `
This project uses a Gradle version catalog ("${prefix}"). Equivalent additions using catalog accessors:

1. In gradle/${prefix === 'libs' ? 'libs' : prefix}.versions.toml:

     [versions]
     roborazzi = "${roborazziVersion}"
     composablePreviewScanner = "${cpsVersion}"

     [libraries]
     ${roborazziAlias} = { module = "io.github.takahirom.roborazzi:roborazzi", version.ref = "roborazzi" }
     ${roborazziComposeAlias} = { module = "io.github.takahirom.roborazzi:roborazzi-compose", version.ref = "roborazzi" }
     ${roborazziScannerAlias} = { module = "io.github.takahirom.roborazzi:roborazzi-compose-preview-scanner-support", version.ref = "roborazzi" }
     ${cpsAlias} = { module = "io.github.sergio-sastre.ComposablePreviewScanner:android", version.ref = "composablePreviewScanner" }
     ${robolectricAlias} = { module = "org.robolectric:robolectric", version = "4.14.1" }
     ${uiTestJunit4Alias} = { group = "androidx.compose.ui", name = "ui-test-junit4" }

     [plugins]
     ${pluginAlias} = { id = "io.github.takahirom.roborazzi", version.ref = "roborazzi" }

2. In each recorded module's build.gradle.kts, apply the plugin and add:

     plugins {
       alias(${pluginAccessorFor(pluginAlias, prefix)})
     }

     dependencies {
       testImplementation(${accessorFor(roborazziAlias, prefix)})
       testImplementation(${accessorFor(roborazziComposeAlias, prefix)})
       testImplementation(${accessorFor(roborazziScannerAlias, prefix)})
       testImplementation(${accessorFor(cpsAlias, prefix)})
       testImplementation(${accessorFor(robolectricAlias, prefix)})
       // version from your Compose BOM, or pin one in the catalog
       testImplementation(${accessorFor(uiTestJunit4Alias, prefix)})
     }
`;
}

/** The SnapshotTest subclass snippet printed by `init` and reused by `doctor`'s snapshot-test-class check. */
export const IOS_SNAPSHOT_TEST_CLASS_SNIPPET = `     import SnapshottingTests

     class Snapshots: SnapshotTest {
       override class func snapshotPreviews() -> [String]? { nil }
     }`;

function printIosInstructions(): void {
  console.log(`
Next steps to wire up SnapshotPreviews recording:

1. Add the Swift package https://github.com/getsentry/SnapshotPreviews to the project.

2. Link the SnapshottingTests product into a unit-test target that is hosted in the app
   (set TEST_HOST / BUNDLE_LOADER to the app target).

3. Add one test class to that target:

${IOS_SNAPSHOT_TEST_CLASS_SNIPPET}

4. Recommend applying \`.sizeThatFitsLayout\` traits on component-sized previews so they
   snapshot at their natural size rather than full-screen.

5. Run \`phonebook doctor\` to verify the setup.
`);
}
