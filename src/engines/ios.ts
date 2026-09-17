import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { PhonebookConfig } from '../config.js';
import { diagnoseXcodebuildFailure } from '../errors.js';
import { SCHEMA_VERSION, type Manifest, type ManifestEntry } from '../manifest.js';
import { readPngSize } from '../png.js';
import { parsePreviewName, spaceCamelCase } from '../naming.js';
import { gitInfo } from './git.js';
import { findSnapshotTestSubclass, findSnapshottingTestsTargets, moduleForFile, readPbxprojText } from '../ios/snapshotTestClass.js';
import { parseFailedPreviews } from '../ios/unrendered.js';
import { changedFiles } from '../scan/scope.js';

/** Builds the error/warning text for a `generate` run that exported zero snapshots. Exported for tests. */
export function buildEmptySnapshotsMessage(exportDir: string, scheme: string): string {
  return (
    `xcodebuild succeeded but no snapshots were exported to ${exportDir}. ` +
    `Does the "${scheme}" scheme include a SnapshotPreviews test target, and are your #Preview macros not all ` +
    'filtered out (e.g. by a snapshotPreviews() override that excludes them)?'
  );
}


/**
 * A run that rendered some previews and did not finish, usually because a
 * preview crashed. The bundle of what did render has been written.
 *
 * Thrown rather than returned so a caller that only knows the happy path — the
 * CLI — still exits non-zero, while one that can use the partial result catches
 * it. The crash list is worth more than a clean failure: every preview that traps
 * costs a host-app relaunch, so it is what makes the next run shorter.
 */
export class IncompleteRenderError extends Error {
  constructor(
    readonly manifest: Manifest,
    readonly outputDir: string,
    /** Container of each preview test the runner reported failed, one per test. */
    readonly failedPreviews: string[],
    readonly diagnosis: string[],
  ) {
    const crashed =
      failedPreviews.length > 0 ? `; ${failedPreviews.length} crashed (${[...new Set(failedPreviews)].join(', ')})` : '';
    super(
      [`Rendered ${manifest.entries.length} previews into ${outputDir}, but the run did not finish${crashed}.`, ...diagnosis].join(
        '\n',
      ),
    );
    this.name = 'IncompleteRenderError';
  }
}

/**
 * Resolves the -only-testing:Target/Class argument so `generate` runs just the
 * snapshot test class instead of the app's whole test suite — an unrelated
 * failing unit test must not kill screenshot generation (seen in a real repo
 * whose own tests were flaky). Explicit config wins; "" disables the filter.
 * Exported for tests.
 */
export async function resolveOnlyTesting(
  config: PhonebookConfig,
  projectDir: string,
): Promise<string | undefined> {
  const configured = config.ios?.onlyTesting;
  if (configured !== undefined) return configured === '' ? undefined : configured;
  try {
    const [subclass, pbxproj] = await Promise.all([
      findSnapshotTestSubclass(projectDir),
      readPbxprojText(projectDir, config.ios?.project ? join(projectDir, config.ios.project) : undefined),
    ]);
    if (!subclass || !pbxproj) return undefined;
    const targets = findSnapshottingTestsTargets(pbxproj);
    if (targets.length !== 1) return undefined;
    return `${targets[0].name}/${subclass.className}`;
  } catch {
    return undefined;
  }
}

/**
 * A SNAPSHOTS_ONLY_FILTER pattern that matches no preview at all.
 *
 * Patterns are anchored regular expressions matched against a preview's
 * synthesized fileID, and a fileID is never empty, so "^$" can match nothing.
 * It is what a narrowed render with nothing to narrow to asks for: an empty
 * bundle, rather than the whole project.
 */
const NEVER_MATCHES = '^$';

/** Escapes a literal so it matches itself inside a regular expression. Exported for tests. */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The SNAPSHOTS_ONLY_FILTER value that renders only the previews declared in
 * `files`.
 *
 * SnapshotPreviews filters before it creates a test method, so a pattern that
 * misses is a preview that never renders — which makes a half-resolved filter
 * worse than none. A file whose module cannot be read is therefore a failure
 * rather than a filter with a hole in it.
 *
 * It fails rather than widening, which is what it used to do. Dropping the
 * filter and rendering everything looked like the safe choice: no preview is
 * lost and the caller still gets a bundle. What it actually does is answer a
 * different question than the one asked, at a cost that scales with the project
 * rather than the request — one file becomes every preview in the repository
 * and every simulator boot that takes, and nothing in the result says so. A
 * warning on stderr is not consent. A caller that wants the whole project can
 * already say so, by leaving --files and --changed off.
 *
 * Each pattern is anchored against the preview's synthesized fileID,
 * "<Module>/<File>.swift", because the match is a substring search: unanchored,
 * "Card.swift" would also claim UserCard.swift.
 */
export async function buildSnapshotsOnlyFilter(
  files: string[],
  moduleOf: (file: string) => Promise<string | undefined>,
): Promise<string> {
  const swift = files.filter((file) => file.endsWith('.swift'));
  if (swift.length === 0) {
    // A well-formed narrow request whose answer is empty: the caller named
    // files, none of them can hold a #Preview, so nothing matches. That is a
    // result, not a failure — the same call Android's --tests filtering makes
    // when a module has none of the requested previews. It is emphatically not
    // a reason to render everything, which is the one answer the caller can be
    // sure they did not ask for.
    console.warn('warning: none of the files given are Swift sources; nothing to render.');
    return NEVER_MATCHES;
  }

  const patterns: string[] = [];
  const unresolved: string[] = [];
  for (const file of swift) {
    const module = await moduleOf(file);
    if (!module) {
      unresolved.push(file);
      continue;
    }
    patterns.push(`^${escapeRegex(module)}/${escapeRegex(basename(file))}$`);
  }

  if (unresolved.length > 0) {
    throw new Error(
      `Could not work out which target compiles ${unresolved.join(', ')}, so the previews for those ` +
        'files cannot be singled out. No filesystem-synchronized folder covers them and no target\'s ' +
        'build phase lists them — check they are part of the Xcode project, and that ' +
        '`xcodebuild -showBuildSettings` works for their target. Drop --files to render the whole project.',
    );
  }
  return patterns.join('\n');
}

/**
 * Runs the SnapshotPreviews-backed XCTest target via xcodebuild on a simulator
 * and harvests the exported PNG + JSON sidecar pairs into a Phonebook bundle.
 *
 * SnapshotPreviews exports to the directory given by the SNAPSHOTS_EXPORT_DIR
 * env var in the test-runner process; xcodebuild forwards any TEST_RUNNER_-
 * prefixed variable (prefix stripped) into that process.
 */
export async function generateIos(
  config: PhonebookConfig,
  projectDir: string,
  outputDir: string,
  options: {
    quiet?: boolean;
    allowEmpty?: boolean;
    /** Render only the previews declared in files with uncommitted changes. */
    changedOnly?: boolean;
    /** Render only the previews declared in these files (relative to projectDir). */
    files?: string[];
  } = {},
): Promise<Manifest> {
  const ios = config.ios;
  if (!ios?.scheme) throw new Error('phonebook.config.json: "ios.scheme" is required');
  if (!ios.project && !ios.workspace) {
    throw new Error('phonebook.config.json: one of "ios.project" or "ios.workspace" is required');
  }
  const simulator = ios.simulator ?? 'iPhone 17 Pro';

  const exportDir = await mkdtemp(join(tmpdir(), 'phonebook-snapshots-'));
  try {
    const args = [
      'test',
      ...(ios.workspace ? ['-workspace', ios.workspace] : ['-project', ios.project!]),
      '-scheme',
      ios.scheme,
      '-destination',
      `platform=iOS Simulator,name=${simulator}`,
    ];
    const onlyTesting = await resolveOnlyTesting(config, projectDir);
    if (onlyTesting) args.push(`-only-testing:${onlyTesting}`);
    const onlyFilter = await resolveSnapshotsOnlyFilter(config, projectDir, options);
    const run = await runXcodebuild(
      projectDir,
      args,
      {
        TEST_RUNNER_SNAPSHOTS_EXPORT_DIR: exportDir,
        TEST_RUNNER_SNAPSHOTS_RUNNING_FOR_PREVIEWS: '1',
        ...(onlyFilter ? { TEST_RUNNER_SNAPSHOTS_ONLY_FILTER: onlyFilter } : {}),
      },
      options.quiet ?? false,
    );
    const finished = run.exitCode === 0;

    // Read before deciding anything: a run that failed may still have rendered
    // most of the gallery, and the export directory is deleted on the way out.
    const pngs = (await readdir(exportDir)).filter((f) => f.endsWith('.png')).sort();
    if (!finished && pngs.length === 0 && run.failedPreviews.length === 0) {
      throw new Error(
        [`xcodebuild failed (exit ${run.exitCode}) running: xcodebuild ${args.join(' ')}`, ...run.diagnosis].join('\n'),
      );
    }

    const imagesDir = join(outputDir, 'images');
    await mkdir(imagesDir, { recursive: true });

    if (finished && pngs.length === 0) {
      const message = buildEmptySnapshotsMessage(exportDir, ios.scheme);
      if (!(options.allowEmpty ?? false)) {
        throw new Error(message);
      }
      console.warn(`warning: ${message}`);
    }

    const entries: ManifestEntry[] = [];
    for (const png of pngs) {
      const sidecar = await readSidecar(join(exportDir, png.replace(/\.png$/, '.json')));
      const meta = mapSidecar(png, sidecar);
      const hash = createHash('sha256');
      hash.update(png);
      const imageName = `${hash.digest('hex').slice(0, 16)}.png`;
      await copyFile(join(exportDir, png), join(imagesDir, imageName));
      const size = await readPngSize(join(imagesDir, imageName));
      entries.push({ ...meta, image: `images/${imageName}`, ...(size ?? {}) });
    }

    entries.sort(
      (a, b) => a.component.localeCompare(b.component) || a.state.localeCompare(b.state),
    );

    const manifest: Manifest = {
      schemaVersion: SCHEMA_VERSION,
      platform: 'ios',
      app: {
        name: config.appName,
        generatedAt: new Date().toISOString(),
        ...(await gitInfo(projectDir)),
      },
      entries,
    };
    await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (!finished) {
      throw new IncompleteRenderError(manifest, outputDir, run.failedPreviews, run.diagnosis);
    }
    return manifest;
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
}

/**
 * Turns the `--changed`/`--files` options into a SNAPSHOTS_ONLY_FILTER value,
 * reading the pbxproj once and resolving each file's module through it.
 */
async function resolveSnapshotsOnlyFilter(
  config: PhonebookConfig,
  projectDir: string,
  options: { changedOnly?: boolean; files?: string[] },
): Promise<string | undefined> {
  if (!options.changedOnly && !options.files) return undefined;
  const ios = config.ios!;
  const files = options.files ?? (await changedFiles(projectDir));
  const pbxproj = await readPbxprojText(projectDir, ios.project ? join(projectDir, ios.project) : undefined);
  const cache = new Map<string, string | undefined>();
  return buildSnapshotsOnlyFilter(files, (file) =>
    moduleForFile(pbxproj, projectDir, file, { project: ios.project, workspace: ios.workspace, scheme: ios.scheme }, cache),
  );
}

/** Shape of the JSON sidecar SnapshotPreviews writes next to each PNG. */
interface SnapshotSidecar {
  display_name?: string;
  group?: string;
  context?: {
    preview?: {
      container_display_name?: string;
      preferred_color_scheme?: string;
    };
    simulator?: {
      device_name?: string;
    };
  };
}

async function readSidecar(path: string): Promise<SnapshotSidecar> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SnapshotSidecar;
  } catch {
    return {};
  }
}

/**
 * A stable, unique identifier for this preview within the project.
 *
 * Android has a fully qualified name to hand. iOS has nothing equivalent: the
 * sidecar's `display_name` is a label, it usually repeats what `component` and
 * `state` already say, and for an unnamed preview Xcode substitutes the
 * placeholder "At line #14" — not a name, and identical for every unnamed
 * preview in every other file. Qualifying whatever the sidecar gives with the
 * source file makes the result unique across the project and stable between
 * runs; it changes when the preview is renamed or moved, which is when its
 * identity genuinely changed.
 */
function previewIdentity(png: string, sidecar: SnapshotSidecar): string {
  const label = sidecar.display_name?.trim() || png.replace(/\.png$/, '');
  const group = sidecar.group?.trim();
  return group ? `${group}:${label}` : label;
}

/** Exported for tests. Maps one PNG + sidecar to a manifest entry (minus image path). */
export function mapSidecar(png: string, sidecar: SnapshotSidecar): Omit<ManifestEntry, 'image'> {
  const container = sidecar.context?.preview?.container_display_name;
  // Unnamed previews get an auto display name like "At line #14" — not a state.
  const rawName = sidecar.display_name?.trim();
  const displayName = rawName && !/^At line #\d+$/.test(rawName) ? rawName : undefined;

  const fallback = container ? container.replace(/\s+/g, '') : png.replace(/\.png$/, '');
  const { component, state } = parsePreviewName(fallback, displayName);

  const scheme = sidecar.context?.preview?.preferred_color_scheme;
  const group = sidecar.group; // e.g. "PhonebookSample/UserCard.swift"
  const module = group?.includes('/') ? group.slice(0, group.indexOf('/')) : undefined;

  return {
    component: component || spaceCamelCase(fallback),
    state,
    module: module ?? 'app',
    sourceFile: group,
    previewName: previewIdentity(png, sidecar),
    theme: scheme === 'dark' ? 'dark' : scheme === 'light' ? 'light' : undefined,
    device: sidecar.context?.simulator?.device_name,
  };
}

/** How an xcodebuild run ended. */
export interface XcodebuildRun {
  exitCode: number | null;
  /** Container of each preview test the runner reported failed, one per test. */
  failedPreviews: string[];
  /** Known failure signatures found in the output; empty on success. */
  diagnosis: string[];
}

/**
 * Runs xcodebuild. When `quiet` is false (the CLI default), output streams
 * straight to this process's stdout/stderr as it arrives (so a human can
 * watch the build) while a rolling ~200-line tail is kept alongside it for
 * error translation. When `quiet` is true (used by the MCP server, whose
 * stdout is the JSON-RPC channel and must never carry build output), only the
 * tail is kept and nothing is echoed live; the tail is written to stderr once
 * if the build fails.
 *
 * Resolves however the run ends, and rejects only when xcodebuild cannot be
 * started: a failed run can still have rendered previews, and that is for the
 * caller to judge. Failed preview tests are read from the whole stream rather
 * than the tail, and line by line, since a chunk can end mid-line.
 */
export function runXcodebuild(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  quiet: boolean,
): Promise<XcodebuildRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('xcodebuild', args, {
      cwd: resolve(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    let tail: string[] = [];
    const failedPreviews: string[] = [];
    const partial = { stdout: '', stderr: '' };
    const takeLines = (lines: string[]) => {
      failedPreviews.push(...parseFailedPreviews(lines.join('\n')));
      tail.push(...lines);
      if (tail.length > 200) tail = tail.slice(-200);
    };
    const onData = (stream: 'stdout' | 'stderr', target: NodeJS.WritableStream) => (data: Buffer) => {
      if (!quiet) target.write(data);
      const lines = (partial[stream] + data.toString('utf8')).split('\n');
      partial[stream] = lines.pop() ?? '';
      takeLines(lines);
    };
    child.stdout?.on('data', onData('stdout', process.stdout));
    child.stderr?.on('data', onData('stderr', process.stderr));

    child.on('error', reject);
    child.on('close', (code) => {
      takeLines([partial.stdout, partial.stderr].filter((l) => l.length > 0));
      const tailText = tail.join('\n');
      const diagnosis = code === 0 ? [] : diagnoseXcodebuildFailure(tailText);
      if (diagnosis.length > 0) {
        process.stderr.write(diagnosis.map((line) => `phonebook: ${line}`).join('\n') + '\n');
      }
      if (quiet && code !== 0 && tail.length > 0) process.stderr.write(tailText + '\n');
      resolvePromise({ exitCode: code, failedPreviews, diagnosis });
    });
  });
}
