import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildEmptySnapshotsMessage,
  buildSnapshotsOnlyFilter,
  escapeRegex,
  generateIos,
  IncompleteRenderError,
  mapSidecar,
  resolveOnlyTesting,
} from './ios.js';

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

describe('mapSidecar previewName is an identity, not a label', () => {
  it('qualifies the sidecar label with the source file', () => {
    expect(mapSidecar('x.png', sidecar()).previewName).toBe(
      'PhonebookSample/UserCard.swift:UserCard/Dark',
    );
  });

  it('keeps unnamed previews in different files apart', () => {
    const a = mapSidecar('a.png', {
      display_name: 'At line #14',
      group: 'PhonebookSample/ContentView.swift',
    });
    const b = mapSidecar('b.png', {
      display_name: 'At line #14',
      group: 'PhonebookSample/SettingsView.swift',
    });
    expect(a.previewName).not.toBe(b.previewName);
    expect(a.previewName).toBe('PhonebookSample/ContentView.swift:At line #14');
  });

  it('falls back to the png name when the sidecar carries no label', () => {
    expect(mapSidecar('Sample_Badge_Success.png', { group: 'Sample/Badge.swift' }).previewName).toBe(
      'Sample/Badge.swift:Sample_Badge_Success',
    );
  });

  it('uses the label alone when there is no source file', () => {
    expect(mapSidecar('x.png', { display_name: 'Badge/Error' }).previewName).toBe('Badge/Error');
  });

  it('no longer merely repeats component and state', () => {
    const e = mapSidecar('x.png', sidecar());
    expect(e.previewName).not.toBe(`${e.component}/${e.state}`);
  });
});

/**
 * Against IceCubes, three previews trapped and every trap cost a host-app
 * relaunch of about a minute and a half. The run outlived the MCP client's 300s
 * tool timeout, so the agent got "timed out" three times in a row. Had it
 * waited, xcodebuild would have printed which previews crashed, and 13 had
 * rendered into a directory Phonebook deletes when the run fails.
 *
 * These run a stand-in `xcodebuild` from PATH that behaves like that run.
 */
describe('generateIos when the run does not finish', () => {
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const config = {
    appName: 'Sample',
    platform: 'ios' as const,
    ios: { scheme: 'Sample', project: 'Sample.xcodeproj', onlyTesting: '' },
  };

  afterEach(() => vi.unstubAllEnvs());

  /** Puts an `xcodebuild` running `body` first on PATH, with a rendered preview
   * at $RENDERED to copy into the export directory. */
  async function fakeXcodebuild(body: string): Promise<{ projectDir: string; outputDir: string }> {
    const bin = await mkdtemp(join(tmpdir(), 'fake-xcodebuild-'));
    const rendered = join(bin, 'rendered.png');
    await writeFile(rendered, PNG_1x1);
    await writeFile(
      join(bin, 'xcodebuild'),
      `#!/bin/bash\nRENDERED="${rendered}"\nOUT="$TEST_RUNNER_SNAPSHOTS_EXPORT_DIR"\n${body}\n`,
    );
    await chmod(join(bin, 'xcodebuild'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const projectDir = await mkdtemp(join(tmpdir(), 'fake-project-'));
    return { projectDir, outputDir: join(projectDir, 'phonebook-out') };
  }

  const renderOne = `cp "$RENDERED" "$OUT/Sample_Card.swift_Card_Default.png"
echo '{"display_name":"Card/Default","group":"Sample/Card.swift"}' > "$OUT/Sample_Card.swift_Card_Default.json"
echo "Test case 'Snapshots.portrait-Card-0-0()' passed on 'iPhone' (0.000 seconds)"`;
  const crashOne = `echo "Test case 'Snapshots.portrait-Avatar View-0-1()' failed on 'iPhone' (0.000 seconds)"`;

  it('keeps what rendered and names the previews that crashed', async () => {
    const { projectDir, outputDir } = await fakeXcodebuild(`${renderOne}\n${crashOne}\nexit 65`);

    const error = await generateIos(config, projectDir, outputDir, { quiet: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IncompleteRenderError);
    const incomplete = error as IncompleteRenderError;
    expect(incomplete.failedPreviews).toEqual(['Avatar View']);
    expect(incomplete.manifest.entries.map((e) => e.previewName)).toEqual(['Sample/Card.swift:Card/Default']);
    const written = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf8'));
    expect(written.entries).toHaveLength(1);
  });

  it('still reports the build failure when nothing got as far as rendering', async () => {
    const { projectDir, outputDir } = await fakeXcodebuild(
      `echo "Unable to find module dependency: 'SnapshotPreviews'"\nexit 65`,
    );

    const error = await generateIos(config, projectDir, outputDir, { quiet: true }).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(IncompleteRenderError);
    expect((error as Error).message).toContain('xcodebuild failed (exit 65)');
    expect((error as Error).message).toContain("imports 'SnapshotPreviews'");
  });
});

describe('buildSnapshotsOnlyFilter', () => {
  it('escapes regex metacharacters in a literal', () => {
    expect(escapeRegex('My App+1/Card.swift')).toBe('My App\\+1/Card\\.swift');
  });

  it('anchors one pattern per file against the synthesized fileID', async () => {
    const filter = await buildSnapshotsOnlyFilter(
      ['App/Views/UserCard.swift', 'App/Button.swift', 'README.md'],
      async () => 'App',
    );
    expect(filter).toBe('^App/UserCard\\.swift(?::|$)\n^App/Button\\.swift(?::|$)');
  });

  // The bug this whole filter exists to avoid: a named #Preview silently never
  // rendering. SnapshotPreviews matches the fileID plus ":DisplayName" for any
  // preview that has one — which is every preview Phonebook's own naming
  // convention tells a caller to write — so a pattern ending flush at ".swift"
  // can never match one. Confirmed against the real matcher
  // (SnapshotPreviewsCore.swift's `firstMatch(of:)` over `Regex(pattern)`),
  // not just asserted here: both cases below are checked against Foundation's
  // own Regex/firstMatch, the same primitive SnapshotPreviews uses.
  it('matches a named preview\'s fileID:DisplayName form, not just the bare fileID', async () => {
    const filter = await buildSnapshotsOnlyFilter(['App/Card.swift'], async () => 'App');
    const regex = new RegExp(filter);
    expect(regex.test('App/Card.swift')).toBe(true);
    expect(regex.test('App/Card.swift:Card/Default')).toBe(true);
    // Still anchored: a same-prefix file must not match.
    expect(regex.test('App/CardHeader.swift')).toBe(false);
    expect(regex.test('App/CardHeader.swift:CardHeader/Default')).toBe(false);
  });

  // This used to drop the filter and render the whole project. A caller that
  // asked for one file and silently got a thousand previews — and every
  // simulator boot that costs — was given a different answer than the one it
  // asked for, with nothing in the result to say so.
  it('fails when any file cannot be resolved, rather than widening to everything', async () => {
    await expect(
      buildSnapshotsOnlyFilter(['App/Card.swift', 'Legacy/Old.swift'], async (file) =>
        file.startsWith('App/') ? 'App' : undefined,
      ),
    ).rejects.toThrow(/Legacy\/Old\.swift/);
  });

  // A narrow request whose answer is genuinely empty is not the same thing. The
  // caller named files, none of them can hold a #Preview, and nothing matching
  // is the honest result — the same call the Android engine makes when a
  // module has none of the requested previews.
  it('matches nothing when no Swift file changed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await buildSnapshotsOnlyFilter(['README.md'], async () => 'App')).toBe('^$');
    expect(warn.mock.calls[0][0]).toContain('Swift');
    warn.mockRestore();
  });
});
