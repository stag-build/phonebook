import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Platform } from './manifest.js';

export interface PhonebookConfig {
  /** App display name shown in the gallery header */
  appName: string;
  platform: Platform;
  /** Bundle output directory, relative to the config file. Default: "phonebook-out" */
  output?: string;
  android?: {
    /** Gradle modules to record, e.g. [":app"]. Default: [":app"] */
    modules?: string[];
    /** Gradle build variant used for recording. Default: "debug" */
    variant?: string;
    /** Default viewport for previews without an explicit device or size. */
    defaultPreviewSize?: { widthDp: number; heightDp: number };
  };
  ios?: {
    /** Xcode project (.xcodeproj) or workspace path, relative to the config file. */
    project?: string;
    workspace?: string;
    /** Scheme containing the SnapshotPreviews test target. Required for iOS. */
    scheme?: string;
    /** Simulator destination name. Default: "iPhone 17 Pro" */
    simulator?: string;
    /**
     * -only-testing target[/class] passed to xcodebuild, so generate runs just
     * the snapshot tests instead of the whole suite. Auto-detected from the
     * SnapshotTest subclass when omitted; set to "" to force the full suite.
     */
    onlyTesting?: string;
  };
}

export function validateAndroidPreviewSize(size: unknown): asserts size is { widthDp: number; heightDp: number } {
  const label = 'phonebook.config.json: "android.defaultPreviewSize"';
  if (size === null || typeof size !== 'object' || Array.isArray(size)) {
    throw new Error(`${label} must be an object with widthDp and heightDp`);
  }
  const value = size as Record<string, unknown>;
  for (const key of ['widthDp', 'heightDp']) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1 || (value[key] as number) > 10000) {
      throw new Error(`${label}.${key} must be an integer from 1 to 10000`);
    }
  }
}

export async function loadConfig(dir: string): Promise<{ config: PhonebookConfig; projectDir: string }> {
  const projectDir = resolve(dir);
  const path = resolve(projectDir, 'phonebook.config.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`No phonebook.config.json found in ${projectDir}`);
  }
  const config = JSON.parse(raw) as PhonebookConfig;
  if (!config.appName) throw new Error('phonebook.config.json: "appName" is required');
  if (config.platform !== 'android' && config.platform !== 'ios') {
    throw new Error('phonebook.config.json: "platform" must be "android" or "ios"');
  }
  if (config.android?.defaultPreviewSize !== undefined) {
    validateAndroidPreviewSize(config.android.defaultPreviewSize);
  }
  return { config, projectDir };
}
