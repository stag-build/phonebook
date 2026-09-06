import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPngSize } from './png.js';

// A real 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** A synthetic PNG header declaring an arbitrary size; only the first 24 bytes are read. */
function pngWithSize(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('readPngSize', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phonebook-png-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, contents: Buffer): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, contents);
    return path;
  }

  it('reads the dimensions of a real PNG', async () => {
    const path = await write('tiny.png', Buffer.from(TINY_PNG_BASE64, 'base64'));
    expect(await readPngSize(path)).toEqual({ width: 1, height: 1 });
  });

  it('reads dimensions spanning the range real previews produce', async () => {
    const badge = await write('badge.png', pngWithSize(161, 79));
    const screen = await write('screen.png', pngWithSize(1206, 2622));
    expect(await readPngSize(badge)).toEqual({ width: 161, height: 79 });
    expect(await readPngSize(screen)).toEqual({ width: 1206, height: 2622 });
  });

  it('returns undefined for a missing file', async () => {
    expect(await readPngSize(join(dir, 'nope.png'))).toBeUndefined();
  });

  it('returns undefined for a file that is not a PNG', async () => {
    const path = await write('not.png', Buffer.from('this is plainly not a png at all'));
    expect(await readPngSize(path)).toBeUndefined();
  });

  it('returns undefined for a file too short to hold a header', async () => {
    const path = await write('truncated.png', Buffer.from(TINY_PNG_BASE64, 'base64').subarray(0, 12));
    expect(await readPngSize(path)).toBeUndefined();
  });

  it('returns undefined when the second chunk is not IHDR', async () => {
    const buffer = pngWithSize(10, 10);
    buffer.write('IDAT', 12, 'latin1');
    const path = await write('noihdr.png', buffer);
    expect(await readPngSize(path)).toBeUndefined();
  });

  it('returns undefined for a zero dimension', async () => {
    const path = await write('zero.png', pngWithSize(0, 100));
    expect(await readPngSize(path)).toBeUndefined();
  });
});
