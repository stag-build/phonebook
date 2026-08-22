import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectAndroidPackage } from './init.js';

describe('detectAndroidPackage', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('detects the package from namespace = "..." in build.gradle.kts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(
      join(dir, 'app', 'build.gradle.kts'),
      'android {\n  namespace = "dev.stag.sample"\n  applicationId = "dev.stag.other"\n}\n',
    );

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.sample');
  });

  it('detects the package from Groovy-style namespace \'...\' (no equals sign)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, 'app', 'build.gradle'), "android {\n  namespace 'dev.stag.groovy'\n}\n");

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.groovy');
  });

  it('falls back to applicationId = "..." when namespace is absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(
      join(dir, 'app', 'build.gradle.kts'),
      'android {\n  defaultConfig {\n    applicationId = "dev.stag.appid"\n  }\n}\n',
    );

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.appid');
  });

  it('falls back to the AndroidManifest.xml package attribute', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app', 'src', 'main'), { recursive: true });
    await writeFile(join(dir, 'app', 'build.gradle.kts'), 'android {\n  compileSdk = 35\n}\n');
    await writeFile(
      join(dir, 'app', 'src', 'main', 'AndroidManifest.xml'),
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.stag.manifest">\n</manifest>\n',
    );

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.manifest');
  });

  it('falls back to the longest common directory-structure prefix under src/main/java', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    const srcDir = join(dir, 'app', 'src', 'main', 'java', 'dev', 'stag', 'sample');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'MainActivity.kt'), 'package dev.stag.sample\n');

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag.sample');
  });

  it('stops walking the directory structure at the first branch (multiple subdirectories)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app', 'src', 'main', 'java', 'dev', 'stag', 'featureone'), { recursive: true });
    await mkdir(join(dir, 'app', 'src', 'main', 'java', 'dev', 'stag', 'featuretwo'), { recursive: true });

    expect(await detectAndroidPackage(dir, ':app')).toBe('dev.stag');
  });

  it('returns undefined when nothing can be detected', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-init-'));
    await mkdir(join(dir, 'app'), { recursive: true });

    expect(await detectAndroidPackage(dir, ':app')).toBeUndefined();
  });
});
