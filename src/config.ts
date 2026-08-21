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
  };
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
  return { config, projectDir };
}
