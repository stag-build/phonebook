import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('Android default preview size config', () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

  async function load(size?: unknown) {
    const dir = await mkdtemp(join(tmpdir(), 'phonebook-config-'));
    dirs.push(dir);
    await writeFile(join(dir, 'phonebook.config.json'), JSON.stringify({
      appName: 'Sample', platform: 'android', android: size === undefined ? {} : { defaultPreviewSize: size },
    }));
    return loadConfig(dir);
  }

  it('keeps existing Android configs valid', async () => {
    expect((await load()).config.android?.defaultPreviewSize).toBeUndefined();
  });

  it('accepts a size in dp', async () => {
    expect((await load({ widthDp: 393, heightDp: 852 })).config.android?.defaultPreviewSize)
      .toEqual({ widthDp: 393, heightDp: 852 });
  });

  it.each([{ widthDp: 852, heightDp: 393 }, { widthDp: 500, heightDp: 500 }])
    ('accepts landscape and square sizes %j', async (size) => {
      expect((await load(size)).config.android?.defaultPreviewSize).toEqual(size);
    });

  it.each([null, [], { widthDp: 0, heightDp: 852 }, { widthDp: 393.5, heightDp: 852 },
    { widthDp: 393, heightDp: '852' },
    { widthDp: 10001, heightDp: 10002 }, { widthDp: 393 }])('rejects invalid size %j', async (size) => {
    await expect(load(size)).rejects.toThrow('android.defaultPreviewSize');
  });
});
