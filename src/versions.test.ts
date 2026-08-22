import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { canRead, detectKotlinVersion, parseKotlinVersion, readZipEntry } from './versions.js';

describe('parseKotlinVersion', () => {
  it('parses a full X.Y.Z version', () => {
    expect(parseKotlinVersion('2.3.0')).toEqual({ major: 2, minor: 3, patch: 0 });
  });

  it('parses a version with extra trailing text', () => {
    expect(parseKotlinVersion('2.0.21-RC')).toEqual({ major: 2, minor: 0, patch: 21 });
  });

  it('defaults patch to 0 when omitted', () => {
    expect(parseKotlinVersion('2.4')).toEqual({ major: 2, minor: 4, patch: 0 });
  });

  it('returns undefined for unparseable input', () => {
    expect(parseKotlinVersion('not-a-version')).toBeUndefined();
  });
});

describe('canRead', () => {
  it('cannot read metadata one minor version too new (the real Roborazzi 1.72.0 case)', () => {
    // Roborazzi 1.72.0's POM claims kotlin-stdlib 2.0.21, but its real
    // bytecode metadata is (2,3,0) - a Kotlin 2.0 compiler cannot read it.
    expect(canRead({ major: 2, minor: 0 }, [2, 3, 0])).toBe(false);
  });

  it('can read metadata once the compiler catches up (Kotlin 2.2+)', () => {
    expect(canRead({ major: 2, minor: 2 }, [2, 3, 0])).toBe(true);
  });

  it('cannot read metadata one minor further ahead', () => {
    expect(canRead({ major: 2, minor: 1 }, [2, 3, 0])).toBe(false);
  });

  it('treats (1,9,9999) as readable by any compiler >= 1.9', () => {
    expect(canRead({ major: 1, minor: 9 }, [1, 9, 9999])).toBe(true);
    expect(canRead({ major: 2, minor: 0 }, [1, 9, 9999])).toBe(true);
    expect(canRead({ major: 2, minor: 4 }, [1, 9, 9999])).toBe(true);
  });

  it('treats (1,9,9999) as unreadable below 1.9', () => {
    expect(canRead({ major: 1, minor: 8 }, [1, 9, 9999])).toBe(false);
  });

  it('handles a strictly lower major version as always readable', () => {
    expect(canRead({ major: 2, minor: 0 }, [1, 9, 0])).toBe(true);
  });

  it('handles a strictly higher major version as unreadable', () => {
    expect(canRead({ major: 1, minor: 9 }, [2, 0, 0])).toBe(false);
  });
});

describe('detectKotlinVersion', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('detects from gradle/libs.versions.toml [versions] kotlin key', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-versions-'));
    await mkdir(join(dir, 'gradle'), { recursive: true });
    await writeFile(
      join(dir, 'gradle', 'libs.versions.toml'),
      '[versions]\nkotlin = "2.4.10"\nagp = "8.13.2"\n\n[libraries]\n',
    );
    const result = await detectKotlinVersion(dir);
    expect(result).toEqual({ version: { major: 2, minor: 4, patch: 10 }, source: join('gradle', 'libs.versions.toml') });
  });

  it('detects from a kotlin-prefixed alias key in the version catalog', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-versions-'));
    await mkdir(join(dir, 'gradle'), { recursive: true });
    await writeFile(
      join(dir, 'gradle', 'libs.versions.toml'),
      '[versions]\nkotlinx-coroutines = "1.9.0"\nkotlin-gradlePlugin = "2.1.0"\n',
    );
    const result = await detectKotlinVersion(dir);
    expect(result?.version).toEqual({ major: 2, minor: 1, patch: 0 });
  });

  it('detects kotlin("android") version "X" in build.gradle.kts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-versions-'));
    await writeFile(join(dir, 'build.gradle.kts'), 'plugins {\n  kotlin("android") version "1.9.24" apply false\n}\n');
    const result = await detectKotlinVersion(dir);
    expect(result).toEqual({ version: { major: 1, minor: 9, patch: 24 }, source: 'build.gradle.kts' });
  });

  it('detects id("org.jetbrains.kotlin.android") version "X" in build.gradle.kts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-versions-'));
    await writeFile(
      join(dir, 'build.gradle.kts'),
      'plugins {\n  id("org.jetbrains.kotlin.android") version "2.4.10" apply false\n}\n',
    );
    const result = await detectKotlinVersion(dir);
    expect(result?.version).toEqual({ major: 2, minor: 4, patch: 10 });
    expect(result?.source).toBe('build.gradle.kts');
  });

  it('detects Groovy-style id \'x\' version \'y\' in build.gradle', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-versions-'));
    await writeFile(
      join(dir, 'build.gradle'),
      "buildscript {\n  dependencies {\n    classpath \"org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.0\"\n  }\n}\n" +
        "plugins {\n  id 'org.jetbrains.kotlin.android' version '2.0.0'\n}\n",
    );
    const result = await detectKotlinVersion(dir);
    expect(result?.version).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(result?.source).toBe('build.gradle');
  });

  it('detects ext.kotlin_version = "X"', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-versions-'));
    await writeFile(join(dir, 'build.gradle'), "buildscript {\n  ext.kotlin_version = '1.9.10'\n}\n");
    const result = await detectKotlinVersion(dir);
    expect(result?.version).toEqual({ major: 1, minor: 9, patch: 10 });
  });

  it('detects a plugin version in settings.gradle.kts pluginManagement block', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-versions-'));
    await writeFile(
      join(dir, 'settings.gradle.kts'),
      'pluginManagement {\n  plugins {\n    id("org.jetbrains.kotlin.android") version "2.2.0"\n  }\n}\n',
    );
    const result = await detectKotlinVersion(dir);
    expect(result).toEqual({ version: { major: 2, minor: 2, patch: 0 }, source: 'settings.gradle.kts' });
  });

  it('prefers gradle/libs.versions.toml over build.gradle.kts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-versions-'));
    await mkdir(join(dir, 'gradle'), { recursive: true });
    await writeFile(join(dir, 'gradle', 'libs.versions.toml'), '[versions]\nkotlin = "2.1.0"\n');
    await writeFile(join(dir, 'build.gradle.kts'), 'kotlin("android") version "1.9.0"\n');
    const result = await detectKotlinVersion(dir);
    expect(result?.version).toEqual({ major: 2, minor: 1, patch: 0 });
    expect(result?.source).toBe(join('gradle', 'libs.versions.toml'));
  });

  it('returns undefined when nothing matches', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-versions-'));
    await writeFile(join(dir, 'build.gradle.kts'), 'plugins {\n  id("com.android.application")\n}\n');
    const result = await detectKotlinVersion(dir);
    expect(result).toBeUndefined();
  });
});

// --- minimal zip construction, for readZipEntry --------------------------

function buildZip(entries: { name: string; data: Buffer; method: 0 | 8 }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compData = entry.method === 8 ? deflateRawSync(entry.data) : entry.data;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(entry.method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (unused by readZipEntry)
    localHeader.writeUInt32LE(compData.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length
    const local = Buffer.concat([localHeader, nameBuf, compData]);
    localParts.push(local);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(entry.method, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(compData.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));

    offset += local.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

describe('readZipEntry', () => {
  it('reads a stored (uncompressed) entry', () => {
    const zip = buildZip([{ name: 'hello.txt', data: Buffer.from('hello world'), method: 0 }]);
    const result = readZipEntry(zip, (name) => name === 'hello.txt');
    expect(result?.toString('utf8')).toBe('hello world');
  });

  it('reads a deflated entry', () => {
    const payload = Buffer.from('the quick brown fox jumps over the lazy dog '.repeat(5));
    const zip = buildZip([{ name: 'data.bin', data: payload, method: 8 }]);
    const result = readZipEntry(zip, (name) => name === 'data.bin');
    expect(result).toEqual(payload);
  });

  it('finds the right entry among several, by predicate', () => {
    const zip = buildZip([
      { name: 'META-INF/other.txt', data: Buffer.from('nope'), method: 0 },
      { name: 'META-INF/app_release.kotlin_module', data: Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]), method: 8 },
    ]);
    const result = readZipEntry(zip, (name) => name.startsWith('META-INF/') && name.endsWith('.kotlin_module'));
    expect(result).toEqual(Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]));
  });

  it('returns undefined when no entry matches', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x'), method: 0 }]);
    expect(readZipEntry(zip, (name) => name === 'missing.txt')).toBeUndefined();
  });

  it('returns undefined for a non-zip buffer', () => {
    expect(readZipEntry(Buffer.from('not a zip file'), () => true)).toBeUndefined();
  });
});
