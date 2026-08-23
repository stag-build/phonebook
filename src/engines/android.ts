import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PhonebookConfig } from '../config.js';
import { diagnoseGradleFailure } from '../errors.js';
import { SCHEMA_VERSION, type Manifest, type ManifestEntry } from '../manifest.js';
import { parsePreviewName } from '../naming.js';
import { gitInfo } from './git.js';

export const EMPTY_PREVIEWS_MESSAGE =
  'No previews were recorded. Common causes: (1) packages = listOf(...) in generateComposePreviewRobolectricTests ' +
  'does not match your app package; (2) includePrivatePreviews = true is missing and your @Preview functions are ' +
  'private; (3) the module has no @Preview functions. Run `phonebook doctor` to check 1 and 2.';

/**
 * Guards against `generate` silently succeeding with zero recorded previews.
 * Throws unless `allowEmpty` is set (the `--allow-empty` CLI flag), in which
 * case the caller downgrades this to a warning and still writes the manifest.
 * Pure/exported so it can be unit-tested without spawning Gradle.
 */
export function checkEmptyEntries(entryCount: number, allowEmpty: boolean): void {
  if (entryCount === 0 && !allowEmpty) {
    throw new Error(EMPTY_PREVIEWS_MESSAGE);
  }
}

/**
 * Runs Roborazzi (with ComposablePreviewScanner-generated tests) via Gradle and
 * harvests the recorded PNGs into a Phonebook bundle.
 */
export async function generateAndroid(
  config: PhonebookConfig,
  projectDir: string,
  outputDir: string,
  options: { quiet?: boolean; allowEmpty?: boolean } = {},
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
        ...(meta.tags && meta.tags.length > 0 ? { tags: meta.tags } : {}),
      });
    }
  }

  entries.sort((a, b) => a.component.localeCompare(b.component) || a.state.localeCompare(b.state));

  const allowEmpty = options.allowEmpty ?? false;
  checkEmptyEntries(entries.length, allowEmpty);
  if (entries.length === 0 && allowEmpty) {
    console.warn(`warning: ${EMPTY_PREVIEWS_MESSAGE}`);
  }

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
  /**
   * Machine-generated markers Roborazzi appends for @Preview attributes
   * (e.g. "WITH_BACKGROUND" for showBackground = true) that are not a
   * user-chosen display name. See parseRoborazziFileName for classification.
   */
  tags?: string[];
}

/** Roborazzi's machine-generated ALL-CAPS markers, e.g. WITH_BACKGROUND, UI_MODE_NIGHT_YES, PIXEL_4_XL. */
const MACHINE_MARKER = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

/**
 * Roborazzi sometimes glues a machine-generated marker run directly onto a
 * user-chosen display-name token within the same dot-segment, e.g.
 * "Landscape_WIDTH_891DP_HEIGHT_411DP_ORIENTATION_LANDSCAPE" (device-spec
 * annotation glued to the "Landscape" state). Unlike MACHINE_MARKER, this
 * only matches a *trailing* run, leaving a leading name intact.
 */
const GLUED_MARKER_SUFFIX = /(?:_[A-Z0-9]+)+$/;

/**
 * Strips a trailing glued marker run (see GLUED_MARKER_SUFFIX) off `token`,
 * returning the remaining name plus the stripped run as a single tag. Returns
 * undefined when there is no glued suffix, or when stripping it would leave
 * an empty or all-caps-only remainder (a deliberate state like "NIGHT_MODE"
 * has no lowercase to strip down to, so it is left intact).
 */
function stripGluedMarker(token: string): { name: string; tag: string } | undefined {
  const match = token.match(GLUED_MARKER_SUFFIX);
  if (!match || match.index === undefined) return undefined;
  const remainder = token.slice(0, match.index);
  if (remainder.length === 0 || !/[a-z]/.test(remainder)) return undefined;
  return { name: remainder, tag: match[0].slice(1) };
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
 * Roborazzi also appends machine-generated ALL-CAPS markers derived from
 * `@Preview` attributes (verified against a real app whose previews are all
 * `@Preview(showBackground = true)`, with no explicit name):
 *   com.om.spotifyuiapp...HomeContentKt.HomeContent.WITH_BACKGROUND.png
 * These are not a user-chosen display name and must not become the state;
 * they are collected into `tags` instead. NIGHT/NOTNIGHT (uiMode) become
 * `theme` rather than a tag, as before.
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

  // Each remaining "level" (the head's trailing dot segments, then one level
  // per "/" path segment) may itself carry multiple dot-separated tokens: a
  // real display-name token plus Roborazzi's machine-generated markers.
  const levels = [dotParts.slice(fnIndex + 1), ...restPath.map((p) => p.split('.'))];

  let theme: 'light' | 'dark' | undefined;
  const tags: string[] = [];
  const nameLevels: string[] = [];
  for (const level of levels) {
    const nameTokens: string[] = [];
    for (const token of level) {
      if (token === 'NIGHT') theme = 'dark';
      else if (token === 'NOTNIGHT') theme = 'light';
      else if (MACHINE_MARKER.test(token)) tags.push(token);
      else {
        const glued = stripGluedMarker(token);
        if (glued) {
          nameTokens.push(glued.name);
          tags.push(glued.tag);
        } else {
          nameTokens.push(token);
        }
      }
    }
    if (nameTokens.length > 0) nameLevels.push(nameTokens.join('.'));
  }

  const displayName = nameLevels.length > 0 ? nameLevels.join('/') : undefined;

  return {
    fqn,
    functionName,
    displayName,
    theme,
    sourceFile,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/**
 * Runs Gradle. When `quiet` is false (the CLI default), output streams
 * straight through to this process's stdout/stderr as it arrives (so a human
 * can watch the build) while a rolling tail is kept alongside it for error
 * translation. When `quiet` is true (used by the MCP server, whose stdout is
 * the JSON-RPC channel and must never carry build output), only the tail is
 * kept and nothing is echoed live; the tail is written to stderr once if the
 * build fails, unless `dumpTailOnFailure` is set to false.
 *
 * `onOutput`, when provided, is called once on exit (success or failure) with
 * the full, untruncated captured output — useful for callers that want to
 * write a complete log file rather than relying on the 200-line tail.
 */
export function runGradle(
  projectDir: string,
  tasks: string[],
  quiet: boolean,
  options: { dumpTailOnFailure?: boolean; onOutput?: (output: string) => void } = {},
): Promise<void> {
  return new Promise((res, rej) => {
    const gradlew = resolve(projectDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const child = spawn(gradlew, [...tasks, '--stacktrace'], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let tail: string[] = [];
    const full: string[] = [];
    const onData = (target: NodeJS.WritableStream) => (data: Buffer) => {
      if (!quiet) target.write(data);
      const chunkLines = data.toString('utf8').split('\n');
      tail.push(...chunkLines);
      if (tail.length > 200) tail = tail.slice(-200);
      full.push(...chunkLines);
    };
    child.stdout?.on('data', onData(process.stdout));
    child.stderr?.on('data', onData(process.stderr));

    child.on('error', (err) => rej(new Error(`Failed to run ${gradlew}: ${err.message}`)));
    child.on('exit', (code) => {
      options.onOutput?.(full.join('\n'));
      if (code === 0) {
        res();
        return;
      }
      const tailText = tail.join('\n');
      const diagnosis = diagnoseGradleFailure(tailText);
      if (diagnosis.length > 0) {
        process.stderr.write(diagnosis.map((line) => `phonebook: ${line}`).join('\n') + '\n');
      }
      const dumpTailOnFailure = options.dumpTailOnFailure ?? true;
      if (quiet && dumpTailOnFailure && tail.length > 0) process.stderr.write(tailText + '\n');
      const message = [`Gradle failed (exit ${code}) running: ${tasks.join(' ')}`, ...diagnosis].join('\n');
      rej(new Error(message));
    });
  });
}

