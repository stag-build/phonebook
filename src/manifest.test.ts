import { describe, it, expect } from 'vitest';
import { validateManifest, assertContainedPath, type Manifest } from './manifest.js';

function manifestWith(overrides: Partial<Manifest['entries'][number]>): unknown {
  return {
    schemaVersion: 1,
    platform: 'android',
    app: { name: 'Sample App', generatedAt: '2026-08-21T00:00:00.000Z' },
    entries: [
      {
        component: 'Button',
        state: 'Default',
        module: 'ui',
        previewName: 'ButtonDefaultPreview',
        image: 'images/ab12cd.png',
        ...overrides,
      },
    ],
  };
}

describe('validateManifest', () => {
  it('accepts what the engines actually produce', () => {
    const m = validateManifest(manifestWith({ sourceFile: 'com/example/UserCard.kt' }));
    expect(m.entries).toHaveLength(1);
  });

  it('accepts a nested bundle-relative image path', () => {
    expect(() => validateManifest(manifestWith({ image: 'images/dark/ab12cd.png' }))).not.toThrow();
  });

  it('accepts an entry with no sourceFile', () => {
    expect(() => validateManifest(manifestWith({}))).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validateManifest(null)).toThrow(/not an object/);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(() => validateManifest({ ...(manifestWith({}) as object), schemaVersion: 2 })).toThrow(
      /schemaVersion/,
    );
  });

  it('rejects an unknown platform', () => {
    expect(() => validateManifest({ ...(manifestWith({}) as object), platform: 'web' })).toThrow(
      /Unknown platform/,
    );
  });

  it('rejects a missing required key', () => {
    expect(() => validateManifest(manifestWith({ component: '' }))).toThrow(/missing "component"/);
  });
});

// The corpus that the SB-213 spike fed to the previous validator, which accepted
// every one of them. Each must now be refused.
const HOSTILE_PATHS = [
  ['a parent-directory escape', '../../../../../../etc/passwd'],
  ['an absolute path', '/Users/orelzion/.ssh/id_rsa'],
  ['an http URL', 'https://evil.example.com/pixel.png'],
  ['a file URL', 'file:///etc/hosts'],
  ['an escape hidden mid-path', 'images/../../outside.png'],
  ['a quote breakout attempt', 'images/a.png" onerror="alert(1)'],
  ['a data URL', 'data:image/png;base64,AAAA'],
  ['a javascript URL', 'javascript:alert(1)'],
  ['a protocol-relative URL', '//evil.example.com/pixel.png'],
  ['a Windows drive path', 'C:/Windows/System32/config/SAM'],
  ['a UNC path', '\\\\server\\share\\secret.png'],
  ['a backslash escape', '..\\..\\etc\\passwd'],
  ['a home-relative path', '~/.ssh/id_rsa'],
  ['a bare parent reference', '..'],
  ['a NUL byte', 'images/a.png\u0000.txt'],
  ['a newline', 'images/a.png\nx'],
  ['an empty path', ''],
] as const;

describe('manifest paths are contained', () => {
  it.each(HOSTILE_PATHS)('rejects %s as image', (_label, path) => {
    expect(() => validateManifest(manifestWith({ image: path }))).toThrow();
  });

  it.each(HOSTILE_PATHS)('rejects %s as sourceFile', (_label, path) => {
    expect(() => validateManifest(manifestWith({ sourceFile: path }))).toThrow();
  });

  it('names the offending field and entry', () => {
    expect(() => validateManifest(manifestWith({ image: '../../etc/passwd' }))).toThrow(
      /manifest entry 0 "image"/,
    );
  });

  it('rejects a non-string sourceFile', () => {
    expect(() => validateManifest(manifestWith({ sourceFile: 42 as unknown as string }))).toThrow(
      /non-empty string/,
    );
  });

  it('allows a path that normalizes back inside the root', () => {
    expect(() => assertContainedPath('images/./ab12cd.png', 'image', 'entry 0')).not.toThrow();
    expect(() => assertContainedPath('images/dark/../ab12cd.png', 'image', 'entry 0')).not.toThrow();
  });
});
