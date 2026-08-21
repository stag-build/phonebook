import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from './build.js';
import type { Manifest } from '../manifest.js';

// Smallest possible valid 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('buildSite', () => {
  let bundleDir: string;
  let outDir: string;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'phonebook-site-test-'));
    bundleDir = join(root, 'bundle');
    outDir = join(root, 'site');

    await mkdir(join(bundleDir, 'images'), { recursive: true });

    const pngBuffer = Buffer.from(TINY_PNG_BASE64, 'base64');
    await writeFile(join(bundleDir, 'images', 'button-default.png'), pngBuffer);
    await writeFile(join(bundleDir, 'images', 'button-disabled.png'), pngBuffer);
    await writeFile(join(bundleDir, 'images', 'card.png'), pngBuffer);
    await writeFile(join(bundleDir, 'images', 'weird.png'), pngBuffer);

    const manifest: Manifest = {
      schemaVersion: 1,
      platform: 'android',
      app: {
        name: 'Sample App',
        commit: 'abcdef1234567890',
        generatedAt: '2026-08-21T00:00:00.000Z',
      },
      entries: [
        {
          component: 'Button',
          state: 'Default',
          module: 'ui',
          previewName: 'ButtonDefaultPreview',
          image: 'images/button-default.png',
          theme: 'light',
        },
        {
          component: 'Button',
          state: 'Disabled',
          module: 'ui',
          previewName: 'ButtonDisabledPreview',
          image: 'images/button-disabled.png',
          theme: 'dark',
          device: 'Pixel 6',
        },
        {
          component: 'Card',
          state: 'Default',
          module: 'ui',
          previewName: 'CardDefaultPreview',
          image: 'images/card.png',
        },
        {
          component: '<Weird & "Tricky">',
          state: 'Odd',
          module: 'weird-module',
          previewName: 'WeirdOddPreview',
          image: 'images/weird.png',
        },
      ],
    };

    await writeFile(join(bundleDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  });

  afterAll(async () => {
    await rm(join(bundleDir, '..'), { recursive: true, force: true });
  });

  it('returns the number of screenshot entries', async () => {
    const count = await buildSite(bundleDir, outDir);
    expect(count).toBe(4);
  });

  it('writes an index.html containing component names', async () => {
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(html).toContain('Button');
    expect(html).toContain('Card');
    expect(html).toContain('Sample App');
    expect(html).toContain('Pixel 6');
  });

  it('escapes manifest-derived strings containing HTML-sensitive characters', async () => {
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(html).not.toContain('<Weird & "Tricky">');
    expect(html).toContain('&lt;Weird &amp; &quot;Tricky&quot;&gt;');
  });

  it('copies images into the output directory', async () => {
    const files = await readdir(join(outDir, 'images'));
    expect(files.sort()).toEqual(['button-default.png', 'button-disabled.png', 'card.png', 'weird.png'].sort());
  });
});
