import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PhonebookConfig } from '../config.js';
import { diagnoseXcodebuildFailure } from '../errors.js';
import { SCHEMA_VERSION, type Manifest, type ManifestEntry } from '../manifest.js';
import { parsePreviewName, spaceCamelCase } from '../naming.js';
import { gitInfo } from './git.js';
import { findSnapshotTestSubclass, findSnapshottingTestsTargets, readPbxprojText } from '../ios/snapshotTestClass.js';

/** Builds the error/warning text for a `generate` run that exported zero snapshots. Exported for tests. */
export function buildEmptySnapshotsMessage(exportDir: string, scheme: string): string {
  return (
    `xcodebuild succeeded but no snapshots were exported to ${exportDir}. ` +
    `Does the "${scheme}" scheme include a SnapshotPreviews test target, and are your #Preview macros not all ` +
    'filtered out (e.g. by a snapshotPreviews() override that excludes them)?'
  );
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
  options: { quiet?: boolean; allowEmpty?: boolean } = {},
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
    await runXcodebuild(
      projectDir,
      args,
      {
        TEST_RUNNER_SNAPSHOTS_EXPORT_DIR: exportDir,
        TEST_RUNNER_SNAPSHOTS_RUNNING_FOR_PREVIEWS: '1',
      },
      options.quiet ?? false,
    );

    const imagesDir = join(outputDir, 'images');
    await mkdir(imagesDir, { recursive: true });

    const pngs = (await readdir(exportDir)).filter((f) => f.endsWith('.png')).sort();
    if (pngs.length === 0) {
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
      entries.push({ ...meta, image: `images/${imageName}` });
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
    return manifest;
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
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
    previewName: rawName ?? png,
    theme: scheme === 'dark' ? 'dark' : scheme === 'light' ? 'light' : undefined,
    device: sidecar.context?.simulator?.device_name,
  };
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
 * On a non-zero exit, the tail is run through `diagnoseXcodebuildFailure` —
 * any matched diagnosis lines are printed to stderr (`phonebook: `-prefixed)
 * and folded into the rejected Error's message, mirroring `runGradle`.
 */
export function runXcodebuild(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  quiet: boolean,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('xcodebuild', args, {
      cwd: resolve(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    let tail: string[] = [];
    const onData = (target: NodeJS.WritableStream) => (data: Buffer) => {
      if (!quiet) target.write(data);
      tail.push(...data.toString('utf8').split('\n'));
      if (tail.length > 200) tail = tail.slice(-200);
    };
    child.stdout?.on('data', onData(process.stdout));
    child.stderr?.on('data', onData(process.stderr));

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const tailText = tail.join('\n');
      const diagnosis = diagnoseXcodebuildFailure(tailText);
      if (diagnosis.length > 0) {
        process.stderr.write(diagnosis.map((line) => `phonebook: ${line}`).join('\n') + '\n');
      }
      if (quiet && tail.length > 0) process.stderr.write(tailText + '\n');
      const message = [
        `xcodebuild failed (exit ${code}) running: xcodebuild ${args.join(' ')}`,
        ...diagnosis,
      ].join('\n');
      reject(new Error(message));
    });
  });
}
