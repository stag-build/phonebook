import { describe, expect, it } from 'vitest';
import { buildEmptySnapshotsMessage, mapSidecar, resolveOnlyTesting } from './ios.js';

const sidecar = (over: object = {}, preview: object = {}) => ({
  display_name: 'UserCard/Dark',
  group: 'PhonebookSample/UserCard.swift',
  context: {
    preview: { container_display_name: 'User Card', preferred_color_scheme: 'dark', ...preview },
    simulator: { device_name: 'iPhone 17 Pro' },
  },
  ...over,
});

describe('mapSidecar', () => {
  it('maps slash display name to component/state with camel spacing', () => {
    const e = mapSidecar('x.png', sidecar());
    expect(e.component).toBe('User Card');
    expect(e.state).toBe('Dark');
    expect(e.theme).toBe('dark');
    expect(e.module).toBe('PhonebookSample');
    expect(e.sourceFile).toBe('PhonebookSample/UserCard.swift');
    expect(e.device).toBe('iPhone 17 Pro');
  });

  it('treats auto "At line #N" names as unnamed previews', () => {
    const e = mapSidecar(
      'c.png',
      sidecar(
        { display_name: 'At line #14', group: 'PhonebookSample/ContentView.swift' },
        { container_display_name: 'Content View', preferred_color_scheme: undefined },
      ),
    );
    expect(e.component).toBe('Content View');
    expect(e.state).toBe('Default');
    expect(e.theme).toBeUndefined();
  });

  it('survives an empty sidecar by falling back to the file name', () => {
    const e = mapSidecar('PhonebookSample_StatusBadge.swift_Badge_Success.png', {});
    expect(e.component.length).toBeGreaterThan(0);
    expect(e.state).toBe('Default');
    expect(e.module).toBe('app');
  });

  it('uses a plain display name as the state', () => {
    const e = mapSidecar(
      'b.png',
      sidecar({ display_name: 'Loading' }, { preferred_color_scheme: undefined }),
    );
    expect(e.component).toBe('User Card');
    expect(e.state).toBe('Loading');
  });
});

describe('buildEmptySnapshotsMessage', () => {
  it('mentions the export dir, the scheme, and that previews may be filtered out', () => {
    const message = buildEmptySnapshotsMessage('/tmp/phonebook-snapshots-abc', 'PhonebookSample');
    expect(message).toContain('/tmp/phonebook-snapshots-abc');
    expect(message).toContain('"PhonebookSample" scheme');
    expect(message).toContain('SnapshotPreviews test target');
    expect(message).toContain('filtered out');
  });
});

describe('resolveOnlyTesting', () => {
  const cfg = (ios: object) => ({ appName: 'x', platform: 'ios' as const, ios: { scheme: 's', ...ios } });

  it('auto-detects Target/Class from the sample project', async () => {
    const result = await resolveOnlyTesting(
      cfg({ project: 'PhonebookSample.xcodeproj' }),
      'samples/ios',
    );
    expect(result).toBe('PhonebookSnapshotTests/PhonebookSnapshotTests');
  });

  it('honors an explicit override', async () => {
    expect(await resolveOnlyTesting(cfg({ onlyTesting: 'Custom/Class' }), '/nonexistent')).toBe('Custom/Class');
  });

  it('empty override disables the filter', async () => {
    expect(await resolveOnlyTesting(cfg({ onlyTesting: '' }), '/nonexistent')).toBeUndefined();
  });

  it('returns undefined when nothing can be detected', async () => {
    expect(await resolveOnlyTesting(cfg({}), '/nonexistent')).toBeUndefined();
  });
});
