import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, type PhonebookConfig } from '../config.js';
import { diagnoseGradleFailure, diagnoseXcodebuildFailure } from '../errors.js';
import { runGradle } from '../engines/android.js';
import {
  canRead,
  detectKotlinVersion,
  fetchKotlinMetadataVersion,
  lookupFallbackMetadata,
  resolveMaxCompatible,
} from '../versions.js';
import {
  findLibrary,
  findPlugin,
  loadVersionCatalog,
  UNIT_TEST_CONFIGURATIONS,
  type VersionCatalog,
} from '../gradle/catalog.js';
import { detectAndroidPackage, IOS_SNAPSHOT_TEST_CLASS_SNIPPET } from './init.js';
import {
  findMissingTestHostNote,
  findSnapshotTestClassLocation,
  findSnapshotTestSubclass,
} from '../ios/snapshotTestClass.js';

export { findMissingTestHostNote, findSnapshotTestClassLocation, findSnapshotTestSubclass };

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

/**
 * A single doctor check line plus whether the check passed. Collected instead of
 * printed directly so the same core logic can back both the CLI command
 * (byte-identical console output) and the MCP `check_setup` tool.
 */
function formatLine(name: string, result: CheckResult): { line: string; ok: boolean } {
  if (result.note !== undefined) {
    return { line: `note ${name}: ${result.note}`, ok: true };
  }
  return { line: `${result.ok ? 'ok' : 'FAIL'} ${name}: ${result.detail}`, ok: result.ok };
}

/**
 * Runs the same checks as `phonebook doctor` and returns the printed lines plus
 * overall pass/fail, without writing to stdout. Shared by the CLI command and
 * the MCP `check_setup` tool.
 */
export async function collectDoctorChecks(
  dir: string,
  options: { deep?: boolean } = {},
): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  const print = (name: string, result: CheckResult): boolean => {
    const { line, ok } = formatLine(name, result);
    lines.push(line);
    return ok;
  };

  const projectDir = resolve(dir);
  let config: PhonebookConfig;
  try {
    const loaded = await loadConfig(projectDir);
    config = loaded.config;
  } catch (err) {
    print('config', { ok: false, detail: `${(err as Error).message}` });
    return { lines, ok: false };
  }
  print('config', { ok: true, detail: 'phonebook.config.json is valid' });

  const deep = options.deep ?? false;
  const ok =
    config.platform === 'android'
      ? await runAndroidChecks(config, projectDir, print, deep)
      : await runIosChecks(config, projectDir, print, deep);
  return { lines, ok };
}

export async function runDoctor(dir: string, options: { deep?: boolean } = {}): Promise<boolean> {
  const { lines, ok } = await collectDoctorChecks(dir, options);
  for (const line of lines) console.log(line);
  return ok;
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

type PrintFn = (name: string, result: CheckResult) => boolean;

const ROBORAZZI_DEP_PATTERN = /io\.github\.takahirom\.roborazzi["']?(?:roborazzi[^:]*)?:?([0-9]+\.[0-9]+\.[0-9]+)/;
const ROBORAZZI_PLUGIN_PATTERN =
  /(?:id\(\s*["']io\.github\.takahirom\.roborazzi["']\s*\)|id\s+["']io\.github\.takahirom\.roborazzi["'])\s+version\s+["']([0-9]+\.[0-9]+\.[0-9]+)["']/;
const ROBORAZZI_GROUP = 'io.github.takahirom.roborazzi';
const ROBORAZZI_ARTIFACT = 'roborazzi';
const CPS_GROUP = 'io.github.sergio-sastre.ComposablePreviewScanner';
const CPS_ARTIFACT = 'android';

/**
 * Message used when a dependency/plugin check can't find its coordinate in
 * the module build files but the project has a build-logic/buildSrc
 * convention-plugin setup — in that case a FAIL would likely be a false
 * negative (the dependency may be applied by a convention plugin we can't
 * see), so the check degrades to a note pointing at `doctor --deep` instead.
 */
function indirectionNote(coordinate: string): string {
  return (
    `could not find ${coordinate} in the module build files; this repo has build-logic/buildSrc, ` +
    'so it may be applied by a convention plugin — run `phonebook doctor --deep` to verify by compiling'
  );
}

/** Message for a dependency found, but declared under a configuration that never reaches the unit-test compile classpath. */
function wrongConfigurationDetail(group: string, name: string, foundConfiguration: string): string {
  return `${group}:${name} is declared as ${foundConfiguration}, which is not on the unit-test compile classpath — add it as testImplementation`;
}

async function runAndroidChecks(
  config: PhonebookConfig,
  projectDir: string,
  print: PrintFn,
  deep: boolean,
): Promise<boolean> {
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
  const catalogs = await loadVersionCatalog(projectDir);
  const catalogList = [...catalogs.values()];
  const hasIndirection = (await exists(join(projectDir, 'build-logic'))) || (await exists(join(projectDir, 'buildSrc')));

  const roborazziPlugin = findPlugin(gradleText, catalogList, ROBORAZZI_GROUP);
  if (roborazziPlugin.found) {
    allOk = print('roborazzi-plugin', {
      ok: true,
      detail: `io.github.takahirom.roborazzi plugin found${roborazziPlugin.via === 'catalog' ? ' (via version catalog)' : ''}`,
    }) && allOk;
  } else if (hasIndirection) {
    print('roborazzi-plugin', { ok: true, detail: '', note: indirectionNote(ROBORAZZI_GROUP) });
  } else {
    allOk = print('roborazzi-plugin', {
      ok: false,
      detail: 'io.github.takahirom.roborazzi plugin not found in build.gradle(.kts); run `phonebook init` for setup instructions',
    }) && allOk;
  }

  const cpsLib = findLibrary(gradleText, catalogList, CPS_GROUP, CPS_ARTIFACT, {
    configurations: UNIT_TEST_CONFIGURATIONS,
  });
  const hasGenerateBlock = gradleText.includes('generateComposePreviewRobolectricTests');
  const hasPreviewScanner = cpsLib.found && hasGenerateBlock;
  if (hasPreviewScanner) {
    allOk = print('preview-scanner', {
      ok: true,
      detail: `ComposablePreviewScanner + generateComposePreviewRobolectricTests configured${cpsLib.via === 'catalog' ? ' (via version catalog)' : ''}`,
    }) && allOk;
  } else if (cpsLib.via === 'wrong-configuration' && cpsLib.foundConfiguration) {
    allOk = print('preview-scanner', {
      ok: false,
      detail: wrongConfigurationDetail(CPS_GROUP, CPS_ARTIFACT, cpsLib.foundConfiguration),
    }) && allOk;
  } else if (hasIndirection) {
    print('preview-scanner', { ok: true, detail: '', note: indirectionNote(`${CPS_GROUP}:${CPS_ARTIFACT}`) });
  } else {
    allOk = print('preview-scanner', {
      ok: false,
      detail:
        'ComposablePreviewScanner / generateComposePreviewRobolectricTests not found; run `phonebook init` for setup instructions',
    }) && allOk;
  }

  if (hasGenerateBlock) {
    allOk = (await runPreviewPackagesCheck(projectDir, modules, print)) && allOk;
  }

  if (hasGenerateBlock) {
    const uiTestJunit4 = findLibrary(gradleText, catalogList, 'androidx.compose.ui', 'ui-test-junit4', {
      configurations: UNIT_TEST_CONFIGURATIONS,
    });
    if (uiTestJunit4.found) {
      allOk = print('compose-test-deps', {
        ok: true,
        detail: `testImplementation("androidx.compose.ui:ui-test-junit4") found${uiTestJunit4.via === 'catalog' ? ' (via version catalog)' : ''}`,
      }) && allOk;
    } else if (uiTestJunit4.via === 'wrong-configuration' && uiTestJunit4.foundConfiguration) {
      allOk = print('compose-test-deps', {
        ok: false,
        detail: wrongConfigurationDetail('androidx.compose.ui', 'ui-test-junit4', uiTestJunit4.foundConfiguration),
      }) && allOk;
    } else if (hasIndirection) {
      print('compose-test-deps', { ok: true, detail: '', note: indirectionNote('androidx.compose.ui:ui-test-junit4') });
    } else {
      allOk = print('compose-test-deps', {
        ok: false,
        detail:
          'missing testImplementation("androidx.compose.ui:ui-test-junit4") — the generated Roborazzi test ' +
          'requires it (add testImplementation(platform("androidx.compose:compose-bom:<version>")) too if the ' +
          'version comes from the BOM)',
      }) && allOk;
    }
  }

  if (!gradleText.includes('includePrivatePreviews')) {
    print('private-previews', {
      ok: true,
      detail: '',
      note: 'includePrivatePreviews not set; private @Previews will be skipped unless includePrivatePreviews = true',
    });
  }

  allOk = (await runKotlinCompatCheck(projectDir, gradleText, catalogList, print)) && allOk;

  if (deep) {
    allOk = (await runAndroidDeepCheck(config, projectDir, modules, print)) && allOk;
  }

  return allOk;
}

/**
 * Extracts the values configured in a `packages = listOf(...)` (Kotlin DSL)
 * or `packages = ["a", "b"]` (Groovy) block. Returns undefined if no
 * `packages = ...` assignment is present at all (as opposed to an empty list).
 */
export function extractConfiguredPackages(gradleText: string): string[] | undefined {
  const match = gradleText.match(/\bpackages\s*=\s*(?:listOf\(([^)]*)\)|\[([^\]]*)\])/);
  if (!match) return undefined;
  const body = match[1] ?? match[2] ?? '';
  return [...body.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
}

/** True for placeholder package values left over from the `phonebook init` setup instructions. */
function isPlaceholderPackage(pkg: string): boolean {
  return /^<.*>$/.test(pkg) || pkg.includes('REPLACE_ME') || pkg === 'your.package' || pkg === '<your package>';
}

interface ModuleSourceScan {
  packages: Set<string>;
  previewCountByPackage: Map<string, number>;
}

/** Recursively scans a module's src/main/java + src/main/kotlin trees for `package ...` declarations and @Preview annotations. */
async function scanModuleSources(projectDir: string, module: string): Promise<ModuleSourceScan> {
  const moduleDir = join(projectDir, ...module.split(':').filter(Boolean));
  const packages = new Set<string>();
  const previewCountByPackage = new Map<string, number>();

  async function scanDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(full);
        continue;
      }
      if (!entry.isFile() || !(entry.name.endsWith('.kt') || entry.name.endsWith('.java'))) continue;
      const text = await readTextIfExists(full);
      const packageMatch = text.match(/^\s*package\s+([\w.]+)/m);
      if (!packageMatch) continue;
      const pkg = packageMatch[1];
      packages.add(pkg);
      const previewMatches = text.match(/@Preview\b/g);
      if (previewMatches) {
        previewCountByPackage.set(pkg, (previewCountByPackage.get(pkg) ?? 0) + previewMatches.length);
      }
    }
  }

  for (const srcRoot of ['java', 'kotlin']) {
    await scanDir(join(moduleDir, 'src', 'main', srcRoot));
  }

  return { packages, previewCountByPackage };
}

/**
 * Checks the `packages = listOf(...)` values configured for
 * `generateComposePreviewRobolectricTests`, per module: flags a missing
 * packages list, a leftover setup-instructions placeholder, and a configured
 * package that doesn't actually exist in the module's sources — the three
 * ways `packages = listOf("<your package>")` silently records zero previews.
 */
async function runPreviewPackagesCheck(projectDir: string, modules: string[], print: PrintFn): Promise<boolean> {
  let allOk = true;

  for (const module of modules) {
    const moduleText = await gradleFileTexts(projectDir, [module]);
    if (!moduleText.includes('generateComposePreviewRobolectricTests')) continue;

    const packages = extractConfiguredPackages(moduleText);
    if (!packages || packages.length === 0) {
      allOk =
        print('preview-packages', {
          ok: false,
          detail:
            'generateComposePreviewRobolectricTests has no packages = listOf(...) — the scanner will find no previews',
        }) && allOk;
      continue;
    }

    const placeholder = packages.find(isPlaceholderPackage);
    if (placeholder !== undefined) {
      const detected = await detectAndroidPackage(projectDir, module);
      allOk =
        print('preview-packages', {
          ok: false,
          detail:
            `packages = listOf("${placeholder}") is a placeholder from the setup instructions — replace it with ` +
            `your app package (detected: ${detected ?? 'unknown'})`,
        }) && allOk;
      continue;
    }

    const scan = await scanModuleSources(projectDir, module);
    const sourcePackages = [...scan.packages];
    const missing = packages.find(
      (pkg) => !sourcePackages.some((p) => p === pkg || p.startsWith(`${pkg}.`)),
    );
    if (missing !== undefined) {
      const detected = await detectAndroidPackage(projectDir, module);
      allOk =
        print('preview-packages', {
          ok: false,
          detail: `package "${missing}" was not found in ${module} sources (detected: ${detected ?? 'unknown'})`,
        }) && allOk;
      continue;
    }

    let previewCount = 0;
    for (const pkg of packages) {
      for (const p of sourcePackages) {
        if (p === pkg || p.startsWith(`${pkg}.`)) previewCount += scan.previewCountByPackage.get(p) ?? 0;
      }
    }

    allOk =
      print('preview-packages', {
        ok: true,
        detail:
          `packages = listOf(${packages.map((p) => `"${p}"`).join(', ')})` +
          (previewCount > 0 ? ` — ${previewCount} @Preview annotation(s) found` : ''),
      }) && allOk;
  }

  return allOk;
}

/**
 * Checks that the project's detected Kotlin compiler can read the declared
 * Roborazzi version's real (bytecode) metadata. A library's POM understates
 * its Kotlin requirement, so this uses FALLBACK / fetchKotlinMetadataVersion
 * instead of trusting the POM.
 */
async function runKotlinCompatCheck(
  projectDir: string,
  gradleText: string,
  catalogList: VersionCatalog[],
  print: PrintFn,
): Promise<boolean> {
  const detected = await detectKotlinVersion(projectDir);
  let declaredVersion =
    gradleText.match(ROBORAZZI_DEP_PATTERN)?.[1] ?? gradleText.match(ROBORAZZI_PLUGIN_PATTERN)?.[1];

  if (!declaredVersion) {
    // Catalog library version: io.github.takahirom.roborazzi:roborazzi or any roborazzi-* artifact
    // (roborazzi-compose, roborazzi-compose-preview-scanner-support, ...), actually referenced from
    // a unit-test-reaching configuration.
    outer: for (const cat of catalogList) {
      for (const lib of cat.libraries) {
        if (lib.group !== ROBORAZZI_GROUP || !lib.version) continue;
        if (lib.name !== ROBORAZZI_ARTIFACT && !lib.name.startsWith('roborazzi')) continue;
        const result = findLibrary(gradleText, cat, lib.group, lib.name, { configurations: UNIT_TEST_CONFIGURATIONS });
        if (result.found) {
          declaredVersion = lib.version;
          break outer;
        }
      }
    }
  }

  if (!declaredVersion) {
    // Catalog plugin version for the roborazzi plugin id.
    const pluginResult = findPlugin(gradleText, catalogList, ROBORAZZI_GROUP);
    if (pluginResult.found && pluginResult.via === 'catalog' && pluginResult.version) {
      declaredVersion = pluginResult.version;
    }
  }

  if (!declaredVersion) {
    print('kotlin-compat', {
      ok: true,
      detail: '',
      note:
        'could not determine the declared Roborazzi version from a literal coordinate, the version catalog ' +
        'library, or the version catalog plugin; skipping compatibility check',
    });
    return true;
  }

  if (!detected) {
    print('kotlin-compat', {
      ok: true,
      detail: '',
      note: 'could not detect the project Kotlin version; skipping compatibility check',
    });
    return true;
  }

  let metadata = lookupFallbackMetadata(ROBORAZZI_GROUP, ROBORAZZI_ARTIFACT, declaredVersion);
  if (!metadata) {
    metadata = await fetchKotlinMetadataVersion(ROBORAZZI_GROUP, ROBORAZZI_ARTIFACT, declaredVersion);
  }

  if (!metadata) {
    print('kotlin-compat', {
      ok: true,
      detail: '',
      note: `could not determine Roborazzi ${declaredVersion}'s Kotlin metadata version (network unavailable); skipping compatibility check`,
    });
    return true;
  }

  if (canRead(detected.version, metadata)) {
    return print('kotlin-compat', {
      ok: true,
      detail: `Kotlin ${detected.version.major}.${detected.version.minor} can read Roborazzi ${declaredVersion}`,
    });
  }

  const { best } = await resolveMaxCompatible(ROBORAZZI_GROUP, ROBORAZZI_ARTIFACT, detected.version);
  const metaLabel = `${metadata[0]}.${metadata[1]}.${metadata[2]}`;
  const needed = metadata[0] === 1 && metadata[1] === 9 && metadata[2] === 9999 ? '1.9' : `${metadata[0]}.${Math.max(0, metadata[1] - 1)}`;
  return print('kotlin-compat', {
    ok: false,
    detail:
      `Kotlin ${detected.version.major}.${detected.version.minor} cannot read Roborazzi ${declaredVersion} ` +
      `(compiled with Kotlin ${metaLabel} metadata). Use Roborazzi ${best ?? '(unknown)'} or upgrade Kotlin to >= ${needed}.`,
  });
}

/**
 * Extracts compiler `e:` error lines from raw build output, dropping
 * stack-frame continuation lines (indented, starting with "at ").
 */
export function extractCompilerErrors(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.trimStart().startsWith('e:') && !/^\s*at\s/.test(line));
}

/** Writes the full captured output of a `doctor --deep` compile to a log file, returning its path. */
async function writeDeepCompileLog(projectDir: string, output: string): Promise<string> {
  const logsDir = join(projectDir, 'phonebook-out', 'logs');
  await mkdir(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(logsDir, `deep-compile-${timestamp}.log`);
  await writeFile(logPath, output);
  return logPath;
}

/** `doctor --deep`: actually compiles the unit test sources via Gradle. */
async function runAndroidDeepCheck(
  config: PhonebookConfig,
  projectDir: string,
  modules: string[],
  print: PrintFn,
): Promise<boolean> {
  const variant = config.android?.variant ?? 'debug';
  const variantCap = variant[0].toUpperCase() + variant.slice(1);
  const tasks = modules.map((m) => `${m}:compile${variantCap}UnitTestKotlin`);

  console.log('deep: compiling test sources (this may take a while)...');
  let fullOutput = '';
  try {
    await runGradle(projectDir, tasks, true, {
      dumpTailOnFailure: false,
      onOutput: (output) => {
        fullOutput = output;
      },
    });
    const logPath = await writeDeepCompileLog(projectDir, fullOutput);
    return print('deep-compile', { ok: true, detail: `compiled: ${tasks.join(', ')} (full log: ${logPath})` });
  } catch {
    const logPath = await writeDeepCompileLog(projectDir, fullOutput);
    const compilerErrors = extractCompilerErrors(fullOutput).slice(0, 3);
    const diagnosis = diagnoseGradleFailure(fullOutput);
    const detailLines = [
      `Gradle failed compiling: ${tasks.join(', ')}`,
      ...compilerErrors,
      ...diagnosis,
      `full log: ${logPath}`,
    ];
    return print('deep-compile', { ok: false, detail: detailLines.join('\n') });
  }
}

async function runIosChecks(
  config: PhonebookConfig,
  projectDir: string,
  print: PrintFn,
  deep: boolean,
): Promise<boolean> {
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
  const pbxprojOnlyText = pbxprojTexts.join('\n');
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

  if (hasSnapshotPreviews) {
    const subclass = await findSnapshotTestSubclass(projectDir);
    if (subclass && !subclass.importsSnapshottingTests) {
      allOk = print('snapshot-test-class', {
        ok: false,
        detail:
          `${subclass.relativePath} subclasses SnapshotTest but does not import SnapshottingTests — ` +
          'the base class lives in that module, so the file will not compile. ' +
          'Change its import line to: import SnapshottingTests',
      }) && allOk;
    } else if (subclass) {
      allOk = print('snapshot-test-class', {
        ok: true,
        detail: `SnapshotTest subclass found: ${subclass.className} (${subclass.relativePath})`,
      }) && allOk;
    } else {
      const preamble =
        'SnapshotPreviews is linked but no SnapshotTest subclass exists — without it the test target records nothing. ';
      const location = findSnapshotTestClassLocation(pbxprojOnlyText);
      let detail: string;
      if (location?.synchronizedFolder) {
        detail =
          preamble +
          `Add the file ${location.synchronizedFolder}/PhonebookSnapshots.swift (this project uses synchronized ` +
          `groups, so creating the file is enough):\n\n${IOS_SNAPSHOT_TEST_CLASS_SNIPPET}\n\n` +
          `or run: phonebook init --write-snapshot-class -C ${projectDir}`;
      } else if (location) {
        detail =
          preamble +
          `Create the file and add it to the ${location.targetName} target in Xcode (File > Add Files, check ` +
          `the ${location.targetName} box):\n\n${IOS_SNAPSHOT_TEST_CLASS_SNIPPET}`;
      } else {
        detail = preamble + `Add to your test target:\n\n${IOS_SNAPSHOT_TEST_CLASS_SNIPPET}`;
      }
      allOk = print('snapshot-test-class', { ok: false, detail }) && allOk;
    }

    const testHostNote = findMissingTestHostNote(pbxprojOnlyText);
    if (testHostNote) {
      print('test-host', { ok: true, detail: '', note: testHostNote });
    }
  }

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

  if (deep && hasXcodebuild && pathExists) {
    allOk = (await runIosDeepCheck(projectDir, ios, projectPath, workspacePath, simulator, print)) && allOk;
  }

  return allOk;
}

/** `doctor --deep`: actually builds-for-testing via xcodebuild. */
async function runIosDeepCheck(
  projectDir: string,
  ios: NonNullable<PhonebookConfig['ios']>,
  projectPath: string | undefined,
  workspacePath: string | undefined,
  simulator: string,
  print: PrintFn,
): Promise<boolean> {
  console.log('deep: compiling test sources (this may take a while)...');
  const args = [
    'build-for-testing',
    ...(workspacePath ? ['-workspace', workspacePath] : ['-project', projectPath!]),
    '-scheme',
    ios.scheme!,
    '-destination',
    `platform=iOS Simulator,name=${simulator}`,
  ];
  const result = await runCapture('xcodebuild', args, { cwd: projectDir });
  const output = `${result.stdout}\n${result.stderr}`;
  const logPath = await writeDeepCompileLog(projectDir, output);
  if (result.code === 0) {
    return print('deep-compile', {
      ok: true,
      detail: `build-for-testing succeeded for scheme "${ios.scheme}" (full log: ${logPath})`,
    });
  }
  const compilerErrors = extractCompilerErrors(output).slice(0, 3);
  const diagnosis = diagnoseXcodebuildFailure(output);
  const detailLines = [
    `xcodebuild build-for-testing failed (exit ${result.code}) for scheme "${ios.scheme}"`,
    ...compilerErrors,
    ...diagnosis,
    `full log: ${logPath}`,
  ];
  return print('deep-compile', { ok: false, detail: detailLines.join('\n') });
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}
