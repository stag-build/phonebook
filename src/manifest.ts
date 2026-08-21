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
  width?: number;
  height?: number;
  theme?: 'light' | 'dark';
  device?: string;
  tags?: string[];
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
  for (const e of m.entries) {
    for (const key of ['component', 'state', 'module', 'previewName', 'image'] as const) {
      if (typeof e[key] !== 'string' || e[key].length === 0) {
        throw new Error(`manifest entry missing "${key}": ${JSON.stringify(e)}`);
      }
    }
  }
  return m;
}
