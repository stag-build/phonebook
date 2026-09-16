import { describe, expect, it } from 'vitest';
import { IncompleteRenderError } from '../engines/ios.js';
import type { Manifest, ManifestEntry } from '../manifest.js';
import type { ScannedPreview } from '../scan/types.js';
import { explainFailedPreviews, parseFailedPreviews, summarizeIncompleteRender } from './unrendered.js';

describe('parseFailedPreviews', () => {
  it('reads the container of every preview test the runner reported failed', () => {
    const output = [
      "Test case 'PhonebookSnapshotTests.portrait-Avatar View-0-12()' failed on 'Clone 1 of iPhone 17 Pro - Ice Cubes (94053)' (0.000 seconds)",
      "Test case 'PhonebookSnapshotTests.portrait-Next Page View-0-14()' passed on 'Clone 1 of iPhone 17 Pro - Ice Cubes (94698)' (0.000 seconds)",
      "Test case 'PhonebookSnapshotTests.landscapeLeft-Sign-In View-0-3()' failed on 'Clone 1 of iPhone 17 Pro - Ice Cubes (94698)' (0.000 seconds)",
      "Test case 'PhonebookSnapshotTests.portrait-Status Row Detail View-0-5()' failed on 'Clone 1 of iPhone 17 Pro - Ice Cubes (94698)' (0.000 seconds)",
    ].join('\n');

    expect(parseFailedPreviews(output)).toEqual(['Avatar View', 'Sign-In View', 'Status Row Detail View']);
  });

  it('finds nothing in a run where every preview rendered', () => {
    expect(
      parseFailedPreviews("Test case 'PhonebookSnapshotTests.portrait-Next Page View-0-14()' passed on 'x' (0.000 seconds)"),
    ).toEqual([]);
  });
});

const scanned = (over: Partial<ScannedPreview>): ScannedPreview => ({
  name: 'unnamed',
  file: 'Packages/StatusKit/Sources/StatusKit/Row/Subviews/StatusRowDetailView.swift',
  line: 1,
  dark: false,
  annotationText: '',
  ...over,
});

const rendered = (label: string, sourceFile = 'StatusKit/StatusRowDetailView.swift'): ManifestEntry => ({
  component: 'x',
  state: 'y',
  module: 'StatusKit',
  sourceFile,
  previewName: `${sourceFile}:${label}`,
  image: 'images/x.png',
});

/**
 * A failed test names a container, "Status Row Detail View", and a position in
 * the discovery order that matches nothing in the source. Neither tells the
 * reader which preview to open. What does: the previews that file declares,
 * minus the ones that came back as images.
 */
describe('explainFailedPreviews', () => {
  const previews = [
    scanned({ displayName: 'StatusRowDetailView/NoEngagement', line: 224 }),
    scanned({ displayName: 'StatusRowDetailView/Dark', line: 248 }),
    scanned({ line: 290 }),
    scanned({ file: 'Packages/DesignSystem/Sources/DesignSystem/Views/AvatarView.swift', line: 74 }),
  ];

  it('names the preview in the crashed file that did not come back', () => {
    const [detail] = explainFailedPreviews(
      ['Status Row Detail View'],
      [rendered('StatusRowDetailView/NoEngagement'), rendered('At line #290')],
      previews,
    );

    expect(detail).toEqual({
      container: 'Status Row Detail View',
      failures: 1,
      unrendered: [
        {
          file: 'Packages/StatusKit/Sources/StatusKit/Row/Subviews/StatusRowDetailView.swift',
          line: 248,
          name: 'StatusRowDetailView/Dark',
        },
      ],
    });
  });

  it('points at every preview of a file when none of them rendered', () => {
    const [detail] = explainFailedPreviews(['Avatar View'], [], previews);

    expect(detail.unrendered).toEqual([
      { file: 'Packages/DesignSystem/Sources/DesignSystem/Views/AvatarView.swift', line: 74, name: 'Avatar View' },
    ]);
  });

  it('counts two failures in one file once, as two', () => {
    const details = explainFailedPreviews(['Avatar View', 'Avatar View'], [], previews);

    expect(details).toHaveLength(1);
    expect(details[0].failures).toBe(2);
  });

  it('still reports a container it cannot find in the source', () => {
    expect(explainFailedPreviews(['Zeta View'], [], previews)).toEqual([
      { container: 'Zeta View', failures: 1, unrendered: [] },
    ]);
  });
});

const manifest = (count: number): Manifest => ({
  schemaVersion: 1,
  platform: 'ios',
  app: { name: 'Sample', generatedAt: '2026-09-14T00:00:00.000Z' },
  entries: Array.from({ length: count }, (_, i) => ({
    component: 'Card',
    state: `S${i}`,
    module: 'Sample',
    previewName: `Sample/Card.swift:Card/S${i}`,
    image: `images/${i}.png`,
  })),
});

describe('summarizeIncompleteRender', () => {
  const error = new IncompleteRenderError(manifest(13), '/proj/phonebook-out', ['Status Row Detail View', 'Status Row View'], []);

  it('points at each preview that did not render, by file and line', () => {
    const text = summarizeIncompleteRender(error, [
      {
        container: 'Status Row Detail View',
        failures: 1,
        unrendered: [{ file: 'Sources/StatusRowDetailView.swift', line: 248, name: 'StatusRowDetailView/Dark' }],
      },
      { container: 'Status Row View', failures: 1, unrendered: [] },
    ]);

    expect(text).toContain('Rendered 13 previews into /proj/phonebook-out; 2 crashed.');
    expect(text).toContain('  Sources/StatusRowDetailView.swift:248 StatusRowDetailView/Dark');
    // A container with no file to point at is still named, not dropped.
    expect(text).toContain('  Status Row View');
  });

  it('says which of several unrendered previews it cannot tell apart', () => {
    const text = summarizeIncompleteRender(error, [
      {
        container: 'Status Row Detail View',
        failures: 1,
        unrendered: [
          { file: 'Sources/StatusRowDetailView.swift', line: 248, name: 'StatusRowDetailView/Dark' },
          { file: 'Sources/StatusRowDetailView.swift', line: 261, name: 'StatusRowDetailView/LargeText' },
        ],
      },
    ]);

    expect(text).toContain('Status Row Detail View: 1 crashed, and these 2 did not render');
  });
});
