import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { PhonebookConfig } from '../config.js';
import { changedFiles } from '../scan/scope.js';
import { diagnoseGradleFailure } from '../errors.js';
import { SCHEMA_VERSION, type Manifest, type ManifestEntry } from '../manifest.js';
import { readPngSize } from '../png.js';
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
 * The single parameterized JUnit class Roborazzi's Gradle plugin generates for
 * `generateComposePreviewRobolectricTests`. Verified against
 * GenerateComposePreviewRobolectricTestsTask.generateTests, which hardcodes
 * `com.github.takahirom.roborazzi.RoborazziPreviewParameterizedTests` and, when
 * `generatedTestClassCount > 1`, suffixes it with the shard index (…Tests0,
 * …Tests1). There is no per-preview or per-file test class, so a file-scoped
 * filter has to select *parameters* of this one class.
 */
const GENERATED_TEST_CLASS = 'RoborazziPreviewParameterizedTests';

/**
 * A `--tests` pattern selecting every preview declared by one JVM class.
 *
 * The generated class has a single `@Test fun test()` run by
 * ParameterizedRobolectricTestRunner with `@Parameters(name = "{0}")`, so JUnit
 * reports each preview as the method `test[<parameter toString>]`. The
 * parameter's toString is
 * `JUnit4TestParameter(preview=<ComposablePreview>)`, and ComposablePreview's
 * toString (ProvideComposablePreview in ComposablePreviewScanner) is
 * `<declaringClass>_<methodName>[_<paramTypes>][_<previewIndex>]` — so the
 * declaring class, followed by an underscore, appears verbatim in the test name.
 *
 * Gradle matches `--tests` against `className + "." + methodName` as a full
 * regex with `*` → `.*` and everything else quoted (ClassTestSelectionMatcher),
 * so dots and brackets in the pattern are literal and a leading `*` disables the
 * class-scan pruning. That makes this pattern safe for both the sharded and
 * unsharded class names.
 */
export function testsPatternForClass(declaringClass: string): string {
  return `*${GENERATED_TEST_CLASS}*.test[*${declaringClass}_*]`;
}

/**
 * The JVM facade class Kotlin generates for top-level declarations in `file`:
 * `ui/PrimaryButton.kt` -> `PrimaryButtonKt`.
 */
export function kotlinFacadeClass(file: string): string {
  const base = file.split('/').pop()!.replace(/\.kt$/, '');
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}Kt`;
}

/** The directory a Gradle module path maps to, relative to the project dir. */
function moduleDir(module: string): string {
  return module.split(':').filter(Boolean).join('/');
}

/** The module owning `file`, preferring the deepest match (`:a:b` over `:a`). */
export function moduleOfFile(file: string, modules: string[]): string | undefined {
  let best: string | undefined;
  for (const module of modules) {
    const dir = moduleDir(module);
    if (dir !== '' && !file.startsWith(`${dir}/`)) continue;
    if (best === undefined || moduleDir(module).length > moduleDir(best).length) best = module;
  }
  return best;
}

export interface PreviewFilterPlan {
  /** Module -> `--tests` patterns. An empty array means "run this module unfiltered". */
  byModule: Map<string, string[]>;
  /** Human-readable reasons a file forced its module to run unfiltered. */
  warnings: string[];
}

/**
 * Maps changed source files onto Gradle `--tests` patterns, per module.
 *
 * `sources` carries each file's text (undefined when it could not be read).
 * Only Kotlin files can declare a Compose `@Preview`, so everything else is
 * ignored. A file whose declaring class cannot be predicted with confidence —
 * unreadable, or carrying a `@file:JvmName` that renames the facade class —
 * makes its whole module run unfiltered rather than silently dropping previews
 * from the manifest.
 */
export function planPreviewFilter(
  sources: { file: string; source?: string }[],
  modules: string[],
): PreviewFilterPlan {
  const byModule = new Map<string, string[]>();
  const unfiltered = new Set<string>();
  const warnings: string[] = [];

  for (const { file, source } of sources) {
    const normalized = file.replace(/\\/g, '/');
    if (!normalized.endsWith('.kt')) continue;
    const module = moduleOfFile(normalized, modules);
    if (module === undefined) continue;

    const forceFull = (reason: string) => {
      unfiltered.add(module);
      byModule.set(module, []);
      warnings.push(`${normalized}: ${reason}; recording all of ${module} instead`);
    };

    if (source === undefined) {
      forceFull('could not be read, so its generated test name is unknown');
      continue;
    }
    if (/^\s*@file:\s*JvmName\s*\(/m.test(source)) {
      forceFull('uses @file:JvmName, so its Kotlin facade class name is not derivable');
      continue;
    }
    if (unfiltered.has(module)) continue;

    const pkg = source.match(/^\s*package\s+([A-Za-z_][\w.]*)/m)?.[1];
    const prefix = pkg ? `${pkg}.` : '';
    // Top-level classes/objects too: a @Preview declared inside one is reported
    // under that class, not under the file facade.
    const declared = [
      kotlinFacadeClass(normalized),
      ...[...source.matchAll(/^(?:\w+ )*(?:class|object) (\w+)/gm)].map((m) => m[1]),
    ];
    const patterns = byModule.get(module) ?? [];
    for (const name of declared) {
      const pattern = testsPatternForClass(`${prefix}${name}`);
      if (!patterns.includes(pattern)) patterns.push(pattern);
    }
    byModule.set(module, patterns);
  }

  return { byModule, warnings };
}

/** A module's build directory, e.g. ":app" -> "<projectDir>/app/build". */
function moduleBuildDir(projectDir: string, module: string): string {
  return join(projectDir, ...module.split(':').filter(Boolean), 'build');
}

/** Where `recordRoborazzi<Variant>` publishes a module's PNGs — what we harvest. */
export function roborazziOutputDir(projectDir: string, module: string): string {
  return join(moduleBuildDir(projectDir, module), 'outputs', 'roborazzi');
}

/**
 * Where the Robolectric test task actually writes PNGs; `finalizeTestRoborazzi
 * <Variant>` then copies this directory into `outputs/roborazzi`.
 *
 * Clearing only the output directory is not enough: `finalize` repopulates it
 * from here, so a stale PNG staged by an earlier run comes straight back — the
 * bug looks fixed for one run and returns on the next. Verified against
 * Roborazzi 1.72.0 on samples/android.
 *
 * Deliberately *not* `build/generated/roborazzi` (the generated test sources)
 * or `build/test-results/roborazzi` (the JSON result records) — neither is
 * harvested, and deleting the former would force a needless codegen rebuild.
 */
export function roborazziStagingDir(projectDir: string, module: string): string {
  return join(moduleBuildDir(projectDir, module), 'intermediates', 'roborazzi');
}

/**
 * Empties a module's Roborazzi output directory *before* Gradle records into
 * it, so that whatever is there afterwards came from this invocation alone.
 *
 * Harvesting copies the whole directory (previews named "Component/State"
 * become real subdirectories, so there is no reliable name-based way to tell a
 * fresh PNG from an old one). Without this, a `--files` run — which narrows
 * Gradle to one file's test parameters, and therefore only rewrites that
 * file's PNGs — would still harvest every PNG a *previous* run left behind and
 * report them in the manifest as if they had just been rendered. The manifest
 * schema carries no timestamp or run id, so a consumer cannot tell the
 * difference.
 *
 * Clearing first rather than filtering afterwards is safe: this directory is
 * disposable Gradle build output, never a source of truth. Previews already
 * harvested into a completed bundle live in that bundle's `images/` and are
 * untouched. Only modules this run actually records are cleared — a module
 * skipped by `--files`/`--changed` keeps its PNGs, which is what lets the
 * bundle still describe the whole app.
 */
async function clearRoborazziOutput(projectDir: string, module: string): Promise<void> {
  await rm(roborazziStagingDir(projectDir, module), { recursive: true, force: true });
  await rm(roborazziOutputDir(projectDir, module), { recursive: true, force: true });
}

/** Whether a module's Roborazzi output directory holds at least one PNG. */
async function hasRecordedOutput(projectDir: string, module: string): Promise<boolean> {
  try {
    const files = await readdir(roborazziOutputDir(projectDir, module), { recursive: true });
    return files.map(String).some((f) => f.endsWith('.png'));
  } catch {
    return false;
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
  options: {
    quiet?: boolean;
    allowEmpty?: boolean;
    changedOnly?: boolean;
    files?: string[];
    /**
     * Test seam. Replaces the Gradle invocation so the clear-then-record-then-
     * harvest sequence can be exercised without an Android SDK: a fake can
     * stage exactly the PNGs a correctly narrowed run would produce. Not
     * reachable from the CLI. The real end-to-end path is covered by the
     * android-integration CI job against samples/android.
     */
    recordWith?: (module: string, extraArgs: string[]) => Promise<void>;
  } = {},
): Promise<Manifest> {
  const modules = config.android?.modules ?? [':app'];
  const variant = config.android?.variant ?? 'debug';
  const variantCap = variant[0].toUpperCase() + variant.slice(1);
  const quiet = options.quiet ?? false;
  const task = (module: string) => `${module}:recordRoborazzi${variantCap}`;
  const record =
    options.recordWith ??
    ((module: string, extraArgs: string[]) =>
      runGradle(projectDir, [task(module)], quiet, { extraArgs }));

  // Modules deliberately not recorded this run: their previously recorded PNGs
  // are still harvested, but a missing output directory is not an error.
  const skipped = new Set<string>();

  if (options.files || options.changedOnly) {
    const requested = options.files ?? (await changedFiles(projectDir));
    const files = requested.map((f) => relative(projectDir, resolve(projectDir, f)).replace(/\\/g, '/'));
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(join(projectDir, file), 'utf8').catch(() => undefined),
      })),
    );
    const plan = planPreviewFilter(sources, modules);
    for (const warning of plan.warnings) console.warn(`warning: ${warning}`);

    for (const module of modules) {
      const patterns = plan.byModule.get(module);
      if (patterns === undefined) {
        skipped.add(module);
        continue;
      }
      const extraArgs = patterns.flatMap((p) => ['--tests', p]);
      await clearRoborazziOutput(projectDir, module);
      await record(module, extraArgs);
      if (extraArgs.length > 0 && !(await hasRecordedOutput(projectDir, module))) {
        // Gradle's `--tests` can select this generated class (there is exactly
        // one per module) and its bare `test` method, but not the individual
        // parameterized previews inside it: ParameterizedRobolectricTestRunner
        // resolves parameter names (and therefore the `test[...]` display
        // names `testsPatternForClass` targets) at run time, after Gradle has
        // already decided which tests to run. A pattern narrower than the
        // class/method succeeds at zero cost by silently matching nothing —
        // confirmed empirically against samples/android and kiwix-android: no
        // variant of a parameter-scoped `--tests` pattern records anything,
        // while the unfiltered class always does. Re-recording the whole
        // module is the only reliable way to get this file's previews.
        console.warn(
          `warning: scoped Gradle test filter for ${module} matched no parameterized previews; ` +
            're-recording the whole module instead',
        );
        await clearRoborazziOutput(projectDir, module);
        await record(module, []);
      }
    }
    if (skipped.size === modules.length) {
      console.warn(
        'warning: none of the requested files declare previews in a configured module; ' +
          'nothing was re-recorded and the bundle reflects the previous run.',
      );
    }
  } else {
    for (const module of modules) await clearRoborazziOutput(projectDir, module);
    if (options.recordWith) {
      for (const module of modules) await options.recordWith(module, []);
    } else {
      // One invocation for all modules: without `--tests` there are no
      // task-scoped arguments to keep apart, so Gradle can schedule them together.
      await runGradle(projectDir, modules.map(task), quiet);
    }
  }

  const imagesDir = join(outputDir, 'images');
  await mkdir(imagesDir, { recursive: true });

  const entries: ManifestEntry[] = [];
  for (const module of modules) {
    const roborazziDir = roborazziOutputDir(projectDir, module);
    let files: string[] = [];
    try {
      // Recursive: previews named "Component/State" are written into subdirectories.
      files = (await readdir(roborazziDir, { recursive: true }))
        .map(String)
        .filter((f) => f.endsWith('.png'));
    } catch {
      // A module skipped by --changed/--files was never asked to record, so an
      // absent output directory says nothing about its Roborazzi setup.
      if (skipped.has(module)) continue;
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
      const size = await readPngSize(join(imagesDir, imageName));
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
        ...(size ?? {}),
        ...(meta.theme ? { theme: meta.theme } : {}),
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

/**
 * Roborazzi's machine-generated marker chunks are ALL-CAPS alnum, except that
 * size markers carry a lowercase "dp" unit: WITH_BACKGROUND, UI_MODE_NIGHT_YES,
 * PIXEL_4_XL, but also W360dp / H96dp (from widthDp/heightDp attributes).
 * A user's name word like "Green" (initial cap + lowercase) never matches.
 */
const MARKER_CHUNK = '[A-Z0-9]+(?:dp)?';
const MACHINE_MARKER = new RegExp(`^${MARKER_CHUNK}(?:_${MARKER_CHUNK})+$`);

/**
 * Roborazzi sometimes glues a machine-generated marker run directly onto a
 * user-chosen display-name token within the same dot-segment, e.g.
 * "Landscape_WIDTH_891DP_HEIGHT_411DP_ORIENTATION_LANDSCAPE" (device-spec
 * annotation glued to the "Landscape" state). Unlike MACHINE_MARKER, this
 * only matches a *trailing* run, leaving a leading name intact.
 */
const GLUED_MARKER_SUFFIX = new RegExp(`(?:_${MARKER_CHUNK})+$`);

/**
 * Roborazzi writes the space in @Preview(name = "On Green") as an underscore.
 * Restore spaces in mixed-case name tokens; a deliberate all-caps state like
 * NIGHT_MODE has no lowercase and is left untouched.
 */
function restoreNameSpaces(token: string): string {
  return /[a-z]/.test(token) ? token.replace(/_/g, ' ') : token;
}

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
  return { name: restoreNameSpaces(remainder), tag: match[0].slice(1) };
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
          nameTokens.push(restoreNameSpaces(token));
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
  options: {
    dumpTailOnFailure?: boolean;
    onOutput?: (output: string) => void;
    /**
     * Gradle CLI arguments appended after the task names — task-scoped options
     * such as `--tests <pattern>` only bind to the task they follow, so callers
     * that filter pass one task at a time.
     */
    extraArgs?: string[];
  } = {},
): Promise<void> {
  return new Promise((res, rej) => {
    const gradlew = resolve(projectDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const child = spawn(gradlew, [...tasks, ...(options.extraArgs ?? []), '--stacktrace'], {
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

