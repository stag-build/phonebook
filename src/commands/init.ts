import { access, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { PhonebookConfig } from '../config.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

export async function runInit(dir: string): Promise<void> {
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
    printAndroidInstructions();
  } else {
    printIosInstructions();
  }
}

function printAndroidInstructions(): void {
  console.log(`
Next steps to wire up Roborazzi preview recording:

1. In the root build.gradle.kts, add the Roborazzi plugin:

     plugins {
       id("io.github.takahirom.roborazzi") version "1.72.0" apply false
     }

2. In each recorded module's build.gradle.kts, apply the plugin and add:

     plugins {
       id("io.github.takahirom.roborazzi")
     }

     dependencies {
       testImplementation("io.github.takahirom.roborazzi:roborazzi:1.72.0")
       testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.72.0")
       testImplementation("io.github.takahirom.roborazzi:roborazzi-compose-preview-scanner-support:1.72.0")
       testImplementation("io.github.sergio-sastre.ComposablePreviewScanner:android:0.9.3")
       testImplementation("org.robolectric:robolectric:4.14.1")
     }

     @OptIn(ExperimentalRoborazziApi::class)
     roborazzi {
       generateComposePreviewRobolectricTests {
         enable = true
         packages = listOf("<your package>")
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

3. Run \`phonebook doctor\` to verify the setup.
`);
}

function printIosInstructions(): void {
  console.log(`
Next steps to wire up SnapshotPreviews recording:

1. Add the Swift package https://github.com/getsentry/SnapshotPreviews to the project.

2. Link the SnapshottingTests product into a unit-test target that is hosted in the app
   (set TEST_HOST / BUNDLE_LOADER to the app target).

3. Add one test class to that target:

     import SnapshotPreviews

     class Snapshots: SnapshotTest {
       override class func snapshotPreviews() -> [String]? { nil }
     }

4. Recommend applying \`.sizeThatFitsLayout\` traits on component-sized previews so they
   snapshot at their natural size rather than full-screen.

5. Run \`phonebook doctor\` to verify the setup.
`);
}
