import { posix } from 'node:path';

export const SCHEMA_VERSION = 1;

export type Platform = 'android' | 'ios';

export interface ManifestEntry {
  /** Display name of the component, e.g. "Button" */
  component: string;
  /** Display name of the state, e.g. "Disabled" */
  state: string;
  /** Gradle module / Xcode target the preview lives in */
  module: string;
  /** Path of the source file containing the preview, relative to the project root, when known */
  sourceFile?: string;
  /** Fully qualified original preview identifier (FQN of the preview function / test) */
  previewName: string;
  /** Image path relative to the bundle root, e.g. "images/ab12cd.png" */
  image: string;
  /** Pixel dimensions of `image`, read from its PNG header at generate time */
  width?: number;
  height?: number;
  theme?: 'light' | 'dark';
  device?: string;
}

export interface Manifest {
  schemaVersion: typeof SCHEMA_VERSION;
  platform: Platform;
  app: {
    name: string;
    commit?: string;
    generatedAt: string;
  };
  entries: ManifestEntry[];
}

/** Matches "http:", "file:", "data:", "javascript:", and a Windows drive like "C:". */
const URL_SCHEME_OR_DRIVE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * A manifest is untrusted input: it is JSON on disk, and a bundle can be moved,
 * hand-edited, or produced by something other than `phonebook generate`. Both
 * path-bearing fields are documented as relative — `image` to the bundle root,
 * `sourceFile` to the project root — but nothing enforced it, and `phonebook
 * build` renders `image` directly into `<img src>` and into the modal's "Open
 * file" link. An entry claiming `../../../../etc/passwd`, an absolute
 * `/Users/someone/.ssh/id_rsa`, or `file:///etc/hosts` was passed through
 * verbatim; HTML escaping stops markup injection but does nothing about the
 * path itself, and any consumer resolving it against the bundle root reads
 * outside the bundle.
 *
 * A manifest path must therefore be relative, forward-slash separated, and stay
 * inside the root it is resolved against. Both engines only ever emit
 * `images/<sha256-prefix>.png`, so this rejects nothing a real run produces.
 */
export function assertContainedPath(value: unknown, field: string, where: string): void {
  const at = `${where} "${field}"`;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${at} must be a non-empty string: ${JSON.stringify(value)}`);
  }
  // Control characters, quotes and angle brackets never appear in a path either
  // engine emits (`images/<sha256-prefix>.png`) or in a source filename, and
  // they are exactly what forces every downstream consumer to escape correctly.
  // Refusing them here means the path is safe to interpolate, not merely
  // contained.
  const unsafe = value.match(/[\u0000-\u001f\u007f"'<>`]/);
  if (unsafe) {
    throw new Error(
      `${at} contains an unsafe character ${JSON.stringify(unsafe[0])}: ${JSON.stringify(value)}`,
    );
  }
  if (value.includes('\\')) {
    throw new Error(`${at} must use forward slashes, not backslashes: ${JSON.stringify(value)}`);
  }
  if (URL_SCHEME_OR_DRIVE.test(value)) {
    throw new Error(`${at} must be a relative path, not a URL or drive-qualified path: ${JSON.stringify(value)}`);
  }
  if (value.startsWith('/')) {
    throw new Error(`${at} must be relative to the bundle root, not absolute: ${JSON.stringify(value)}`);
  }
  // Not an escape under posix join semantics, but a trap for any consumer that
  // expands "~" before resolving. No real bundle path starts with one.
  if (value === '~' || value.startsWith('~/')) {
    throw new Error(`${at} must not start with "~": ${JSON.stringify(value)}`);
  }
  const normalized = posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`${at} escapes the bundle root: ${JSON.stringify(value)}`);
  }
}

export function validateManifest(data: unknown): Manifest {
  const m = data as Manifest;
  if (!m || typeof m !== 'object') throw new Error('manifest.json is not an object');
  if (m.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported manifest schemaVersion ${m.schemaVersion}, expected ${SCHEMA_VERSION}`);
  }
  if (m.platform !== 'android' && m.platform !== 'ios') {
    throw new Error(`Unknown platform "${m.platform}"`);
  }
  if (!Array.isArray(m.entries)) throw new Error('manifest.entries is not an array');
  let index = 0;
  for (const e of m.entries) {
    for (const key of ['component', 'state', 'module', 'previewName', 'image'] as const) {
      if (typeof e[key] !== 'string' || e[key].length === 0) {
        throw new Error(`manifest entry missing "${key}": ${JSON.stringify(e)}`);
      }
    }
    const where = `manifest entry ${index}`;
    assertContainedPath(e.image, 'image', where);
    if (e.sourceFile !== undefined) assertContainedPath(e.sourceFile, 'sourceFile', where);
    index += 1;
  }
  return m;
}
