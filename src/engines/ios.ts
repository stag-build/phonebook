import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PhonebookConfig } from '../config.js';
import { SCHEMA_VERSION, type Manifest, type ManifestEntry } from '../manifest.js';
import { parsePreviewName, spaceCamelCase } from '../naming.js';
import { gitInfo } from './git.js';

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
  options: { quiet?: boolean } = {},
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
      throw new Error(
        `xcodebuild succeeded but no snapshots were exported to ${exportDir}. ` +
          `Does the "${ios.scheme}" scheme include a SnapshotPreviews test target?`,
      );
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
 * straight to this process's stdout/stderr so a human can watch the build.
 * When `quiet` is true (used by the MCP server, whose stdout is the JSON-RPC
 * channel and must never carry build output), output is captured instead and
 * only the last ~50 lines are written to stderr if the build fails.
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
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...env },
    });

    let tail: string[] = [];
    if (quiet) {
      const capture = (data: Buffer) => {
        tail.push(...data.toString('utf8').split('\n'));
        if (tail.length > 50) tail = tail.slice(-50);
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      if (quiet && tail.length > 0) process.stderr.write(tail.join('\n') + '\n');
      reject(new Error(`xcodebuild failed (exit ${code}) running: xcodebuild ${args.join(' ')}`));
    });
  });
}
