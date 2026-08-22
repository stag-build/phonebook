import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PhonebookConfig } from '../config.js';
import { diagnoseGradleFailure } from '../errors.js';
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
  options: { quiet?: boolean } = {},
): Promise<Manifest> {
  const modules = config.android?.modules ?? [':app'];
  const variant = config.android?.variant ?? 'debug';
  const variantCap = variant[0].toUpperCase() + variant.slice(1);

  const tasks = modules.map((m) => `${m}:recordRoborazzi${variantCap}`);
  await runGradle(projectDir, tasks, options.quiet ?? false);

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
        ...(meta.sourceFile ? { sourceFile: meta.sourceFile } : {}),
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
  /** Derived from the package + file-class segments, e.g. "dev/stag/sample/PrimaryButton.kt" */
  sourceFile?: string;
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
  const fileClass = dotParts[fnIndex - 1];
  const sourceFile =
    fileClass?.endsWith('Kt') && fnIndex >= 1
      ? [...dotParts.slice(0, fnIndex - 1), `${fileClass.slice(0, -2)}.kt`].join('/')
      : undefined;
  const nameParts = [...dotParts.slice(fnIndex + 1), ...restPath];
  let displayName: string | undefined = nameParts.length > 0 ? nameParts.join('/') : undefined;

  let theme: 'light' | 'dark' | undefined;
  if (displayName === 'NIGHT') {
    theme = 'dark';
    displayName = undefined;
  }

  return { fqn, functionName, displayName, theme, sourceFile };
}

/**
 * Runs Gradle. When `quiet` is false (the CLI default), output streams
 * straight through to this process's stdout/stderr as it arrives (so a human
 * can watch the build) while a rolling tail is kept alongside it for error
 * translation. When `quiet` is true (used by the MCP server, whose stdout is
 * the JSON-RPC channel and must never carry build output), only the tail is
 * kept and nothing is echoed live; the tail is written to stderr once if the
 * build fails.
 */
export function runGradle(projectDir: string, tasks: string[], quiet: boolean): Promise<void> {
  return new Promise((res, rej) => {
    const gradlew = resolve(projectDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const child = spawn(gradlew, [...tasks, '--stacktrace'], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let tail: string[] = [];
    const onData = (target: NodeJS.WritableStream) => (data: Buffer) => {
      if (!quiet) target.write(data);
      tail.push(...data.toString('utf8').split('\n'));
      if (tail.length > 200) tail = tail.slice(-200);
    };
    child.stdout?.on('data', onData(process.stdout));
    child.stderr?.on('data', onData(process.stderr));

    child.on('error', (err) => rej(new Error(`Failed to run ${gradlew}: ${err.message}`)));
    child.on('exit', (code) => {
      if (code === 0) {
        res();
        return;
      }
      const tailText = tail.join('\n');
      const diagnosis = diagnoseGradleFailure(tailText);
      if (diagnosis.length > 0) {
        process.stderr.write(diagnosis.map((line) => `phonebook: ${line}`).join('\n') + '\n');
      }
      if (quiet && tail.length > 0) process.stderr.write(tailText + '\n');
      const message = [`Gradle failed (exit ${code}) running: ${tasks.join(' ')}`, ...diagnosis].join('\n');
      rej(new Error(message));
    });
  });
}

