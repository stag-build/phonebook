import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, type PhonebookConfig } from '../config.js';

interface CheckResult {
  ok: boolean;
  /** Present for non-failing informational output; printed as "note" instead of "ok"/"FAIL". */
  note?: string;
  detail: string;
}

/** Runs a command and captures stdout+stderr, never throwing on a non-zero exit. */
function runCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) => res({ code: null, stdout, stderr: String(err.message) }));
    child.on('close', (code) => res({ code, stdout, stderr }));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parses the major version number out of `java -version`'s output (printed to stderr). */
export function parseJavaMajorVersion(versionOutput: string): number | undefined {
  const match = versionOutput.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  const first = Number(match[1]);
  // Old scheme: "1.8.0_292" -> major is the second component.
  if (first === 1 && match[2] !== undefined) return Number(match[2]);
  return first;
}

/** Parses the "Schemes:" section out of `xcodebuild -list` output. */
export function parseXcodeSchemes(listOutput: string): string[] {
  const lines = listOutput.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'Schemes:');
  if (start === -1) return [];
  const schemes: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    schemes.push(line.trim());
  }
  return schemes;
}

/** Parses device names out of `xcrun simctl list devices available` output. */
export function parseAvailableSimulatorNames(simctlOutput: string): string[] {
  const names: string[] = [];
  for (const line of simctlOutput.split('\n')) {
    // e.g. "    iPhone 17 Pro (3D3E4A9B-...) (Shutdown)"
    const match = line.match(/^\s{4}(.+?) \([0-9A-F-]{36}\) \((?:Shutdown|Booted)\)\s*$/i);
    if (match) names.push(match[1]);
  }
  return names;
}

function print(name: string, result: CheckResult): boolean {
  if (result.note !== undefined) {
    console.log(`note ${name}: ${result.note}`);
    return true;
  }
  console.log(`${result.ok ? 'ok' : 'FAIL'} ${name}: ${result.detail}`);
  return result.ok;
}

export async function runDoctor(dir: string): Promise<boolean> {
  const projectDir = resolve(dir);
  let config: PhonebookConfig;
  try {
    const loaded = await loadConfig(projectDir);
    config = loaded.config;
  } catch (err) {
    print('config', { ok: false, detail: `${(err as Error).message}` });
    return false;
  }
  print('config', { ok: true, detail: 'phonebook.config.json is valid' });

  if (config.platform === 'android') {
    return runAndroidChecks(config, projectDir);
  }
  return runIosChecks(config, projectDir);
}

async function gradleFileTexts(projectDir: string, modules: string[]): Promise<string> {
  const candidates = new Set<string>([join(projectDir, 'build.gradle'), join(projectDir, 'build.gradle.kts')]);
  for (const module of modules) {
    const moduleDir = join(projectDir, ...module.split(':').filter(Boolean));
    candidates.add(join(moduleDir, 'build.gradle'));
    candidates.add(join(moduleDir, 'build.gradle.kts'));
  }
  const texts: string[] = [];
  for (const path of candidates) {
    try {
      texts.push(await readFile(path, 'utf8'));
    } catch {
      // File doesn't exist under this name; that's fine.
    }
  }
  return texts.join('\n');
}

async function runAndroidChecks(config: PhonebookConfig, projectDir: string): Promise<boolean> {
  let allOk = true;

  const gradlewName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const hasGradlew = await exists(join(projectDir, gradlewName));
  allOk = print('gradlew', hasGradlew ? { ok: true, detail: `found ${gradlewName}` } : {
    ok: false,
    detail: `${gradlewName} not found in ${projectDir}`,
  }) && allOk;

  const javaHome = process.env.JAVA_HOME;
  const javaBin = javaHome ? join(javaHome, 'bin', 'java') : 'java';
  const javaResult = await runCapture(javaBin, ['-version']);
  const versionOutput = javaResult.stderr || javaResult.stdout;
  const majorVersion = javaResult.code === 0 ? parseJavaMajorVersion(versionOutput) : undefined;
  if (majorVersion !== undefined && majorVersion >= 17) {
    allOk = print('java', { ok: true, detail: `JDK ${majorVersion} (${javaBin})` }) && allOk;
  } else {
    allOk = print('java', {
      ok: false,
      detail:
        (majorVersion !== undefined ? `JDK ${majorVersion} found, need 17+` : `could not run ${javaBin} -version`) +
        '. AGP requires JDK 17+; set JAVA_HOME (note: /usr/libexec/java_home may return an old JDK ' +
        'even when newer ones are installed via Homebrew)',
    }) && allOk;
  }

  const modules = config.android?.modules ?? [':app'];
  const gradleText = await gradleFileTexts(projectDir, modules);

  const hasRoborazziPlugin = gradleText.includes('io.github.takahirom.roborazzi');
  allOk = print('roborazzi-plugin', hasRoborazziPlugin ? {
    ok: true,
    detail: 'io.github.takahirom.roborazzi plugin found',
  } : {
    ok: false,
    detail: 'io.github.takahirom.roborazzi plugin not found in build.gradle(.kts); run `phonebook init` for setup instructions',
  }) && allOk;

  const hasPreviewScanner =
    gradleText.includes('ComposablePreviewScanner') && gradleText.includes('generateComposePreviewRobolectricTests');
  allOk = print('preview-scanner', hasPreviewScanner ? {
    ok: true,
    detail: 'ComposablePreviewScanner + generateComposePreviewRobolectricTests configured',
  } : {
    ok: false,
    detail:
      'ComposablePreviewScanner / generateComposePreviewRobolectricTests not found; run `phonebook init` for setup instructions',
  }) && allOk;

  if (!gradleText.includes('includePrivatePreviews')) {
    print('private-previews', {
      ok: true,
      detail: '',
      note: 'includePrivatePreviews not set; private @Previews will be skipped unless includePrivatePreviews = true',
    });
  }

  return allOk;
}

async function runIosChecks(config: PhonebookConfig, projectDir: string): Promise<boolean> {
  let allOk = true;
  const ios = config.ios;
  if (!ios?.scheme || (!ios.project && !ios.workspace)) {
    print('config', { ok: false, detail: 'phonebook.config.json: ios.scheme and ios.project/workspace are required' });
    return false;
  }

  const xcodebuildResult = await runCapture('xcodebuild', ['-version']);
  const hasXcodebuild = xcodebuildResult.code === 0;
  allOk = print('xcodebuild', hasXcodebuild ? {
    ok: true,
    detail: xcodebuildResult.stdout.split('\n')[0] || 'available',
  } : {
    ok: false,
    detail: 'xcodebuild not found on PATH; install Xcode command line tools',
  }) && allOk;

  const projectPath = ios.project ? resolve(projectDir, ios.project) : undefined;
  const workspacePath = ios.workspace ? resolve(projectDir, ios.workspace) : undefined;
  const configuredPath = workspacePath ?? projectPath!;
  const pathExists = await exists(configuredPath);
  allOk = print('project-path', pathExists ? {
    ok: true,
    detail: configuredPath,
  } : {
    ok: false,
    detail: `${configuredPath} does not exist`,
  }) && allOk;

  if (hasXcodebuild && pathExists) {
    const listArgs = workspacePath
      ? ['-list', '-workspace', workspacePath]
      : ['-list', '-project', projectPath!];
    const listResult = await runCapture('xcodebuild', listArgs, { cwd: projectDir });
    const schemes = parseXcodeSchemes(listResult.stdout);
    const hasScheme = schemes.includes(ios.scheme);
    allOk = print('scheme', hasScheme ? {
      ok: true,
      detail: `"${ios.scheme}" found`,
    } : {
      ok: false,
      detail: `"${ios.scheme}" not found; available schemes: ${schemes.join(', ') || '(none)'}`,
    }) && allOk;
  } else {
    print('scheme', { ok: false, detail: 'skipped (xcodebuild or project path unavailable)' });
    allOk = false;
  }

  const pbxprojTexts: string[] = [];
  if (projectPath && (await exists(projectPath))) {
    pbxprojTexts.push(await readTextIfExists(join(projectPath, 'project.pbxproj')));
  } else {
    try {
      for (const entry of await readdir(projectDir)) {
        if (entry.endsWith('.xcodeproj')) {
          pbxprojTexts.push(await readTextIfExists(join(projectDir, entry, 'project.pbxproj')));
        }
      }
    } catch {
      // projectDir unreadable; leave pbxprojTexts empty.
    }
  }
  const packageResolvedPaths = [
    projectPath ? join(projectPath, 'project.xcworkspace', 'xcshareddata', 'swiftpm', 'Package.resolved') : undefined,
    workspacePath ? join(workspacePath, 'xcshareddata', 'swiftpm', 'Package.resolved') : undefined,
  ].filter((p): p is string => Boolean(p));
  for (const p of packageResolvedPaths) {
    pbxprojTexts.push(await readTextIfExists(p));
  }
  const wiringText = pbxprojTexts.join('\n');
  const hasSnapshotPreviews = wiringText.includes('SnapshotPreviews') || wiringText.includes('SnapshottingTests');
  allOk = print('snapshot-previews', hasSnapshotPreviews ? {
    ok: true,
    detail: 'SnapshotPreviews / SnapshottingTests found in project wiring',
  } : {
    ok: false,
    detail: 'SnapshotPreviews / SnapshottingTests not found in .pbxproj or Package.resolved; run `phonebook init` for setup instructions',
  }) && allOk;

  const simulator = ios.simulator ?? 'iPhone 17 Pro';
  const simctlResult = await runCapture('xcrun', ['simctl', 'list', 'devices', 'available']);
  const availableNames = parseAvailableSimulatorNames(simctlResult.stdout);
  const hasSimulator = availableNames.includes(simulator);
  if (hasSimulator) {
    allOk = print('simulator', { ok: true, detail: `"${simulator}" available` }) && allOk;
  } else {
    const suggestions = availableNames.filter((n) => n.startsWith('iPhone')).slice(0, 3);
    allOk = print('simulator', {
      ok: false,
      detail: `"${simulator}" not found; available iPhone simulators include: ${suggestions.join(', ') || '(none)'}`,
    }) && allOk;
  }

  return allOk;
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}
