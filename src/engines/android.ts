import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PhonebookConfig } from '../config.js';
import { SCHEMA_VERSION, type Manifest, type ManifestEntry } from '../manifest.js';
import { parsePreviewName } from '../naming.js';
import { gitInfo } from './git.js';

/**
 * Runs Roborazzi (with ComposablePreviewScanner-generated tests) via Gradle and
 * harvests the recorded PNGs into a Phonebook bundle.
 */
export async function generateAndroid(
  config: PhonebookConfig,
  projectDir: string,
  outputDir: string,
): Promise<Manifest> {
  const modules = config.android?.modules ?? [':app'];
  const variant = config.android?.variant ?? 'debug';
  const variantCap = variant[0].toUpperCase() + variant.slice(1);

  const tasks = modules.map((m) => `${m}:recordRoborazzi${variantCap}`);
  await runGradle(projectDir, tasks);

  const imagesDir = join(outputDir, 'images');
  await mkdir(imagesDir, { recursive: true });

  const entries: ManifestEntry[] = [];
  for (const module of modules) {
    const moduleDir = join(projectDir, ...module.split(':').filter(Boolean));
    const roborazziDir = join(moduleDir, 'build', 'outputs', 'roborazzi');
    let files: string[] = [];
    try {
      // Recursive: previews named "Component/State" are written into subdirectories.
      files = (await readdir(roborazziDir, { recursive: true }))
        .map(String)
        .filter((f) => f.endsWith('.png'));
    } catch {
      throw new Error(
        `No Roborazzi output at ${roborazziDir}. Is the Roborazzi plugin with ` +
          `generateComposePreviewRobolectricTests enabled in ${module}?`,
      );
    }
    for (const file of files) {
      const meta = parseRoborazziFileName(file);
      const hash = createHash('sha256');
      hash.update(module + file);
      const imageName = `${hash.digest('hex').slice(0, 16)}.png`;
      await copyFile(join(roborazziDir, file), join(imagesDir, imageName));
      // A dark-uiMode preview named e.g. UserCardDarkPreview is the Dark state
      // of UserCard, not a separate component.
      let functionName = meta.functionName;
      let displayName = meta.displayName;
      if (meta.theme === 'dark' && !displayName) {
        const stripped = functionName.replace(/(?:Dark|Night)(Preview)?$/, '$1');
        if (stripped !== functionName) functionName = stripped;
        displayName = 'Dark';
      }
      const { component, state } = parsePreviewName(functionName, displayName);
      entries.push({
        component,
        state,
        module,
        previewName: meta.fqn,
        image: `images/${imageName}`,
        ...(meta.theme ? { theme: meta.theme } : {}),
      });
    }
  }

  entries.sort((a, b) => a.component.localeCompare(b.component) || a.state.localeCompare(b.state));

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    platform: 'android',
    app: {
      name: config.appName,
      ...(await gitInfo(projectDir)),
      generatedAt: new Date().toISOString(),
    },
    entries,
  };
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

interface RoborazziImageMeta {
  fqn: string;
  functionName: string;
  displayName?: string;
  theme?: 'light' | 'dark';
}

/**
 * Roborazzi + ComposablePreviewScanner names recorded images
 * `<package>.<FileKt>.<PreviewFunction>[.<preview display name>].png`, where a
 * display name containing "/" becomes real subdirectories on disk (verified
 * against Roborazzi 1.72.0):
 *   dev.stag.sample.PrimaryButtonKt.PrimaryButtonEnabledPreview.Button/Enabled.png
 *   dev.stag.sample.UserCardKt.UserCardPreview.png
 *   dev.stag.sample.UserCardKt.UserCardDarkPreview.NIGHT.png   (uiMode night)
 *
 * `file` is the png path relative to the roborazzi output dir ("/"-separated).
 */
export function parseRoborazziFileName(file: string): RoborazziImageMeta {
  const base = file.replace(/\.png$/, '').replace(/\\/g, '/');
  const fqn = base;

  // Path segments beyond the first come from a "/" in the preview display name.
  const [head, ...restPath] = base.split('/');
  const dotParts = head.split('.');

  // The segment ending in "Kt" is the file class; the next one is the function.
  let fnIndex = dotParts.findIndex((p) => p.endsWith('Kt')) + 1;
  if (fnIndex <= 0 || fnIndex >= dotParts.length) fnIndex = dotParts.length - 1;
  const functionName = dotParts[fnIndex];
  const nameParts = [...dotParts.slice(fnIndex + 1), ...restPath];
  let displayName: string | undefined = nameParts.length > 0 ? nameParts.join('/') : undefined;

  let theme: 'light' | 'dark' | undefined;
  if (displayName === 'NIGHT') {
    theme = 'dark';
    displayName = undefined;
  }

  return { fqn, functionName, displayName, theme };
}

function runGradle(projectDir: string, tasks: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const gradlew = resolve(projectDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const child = spawn(gradlew, [...tasks, '--stacktrace'], {
      cwd: projectDir,
      stdio: 'inherit',
    });
    child.on('error', (err) => rej(new Error(`Failed to run ${gradlew}: ${err.message}`)));
    child.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`Gradle failed (exit ${code}) running: ${tasks.join(' ')}`)),
    );
  });
}

