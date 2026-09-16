import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanIos } from './ios.js';

/**
 * A preview is read to its closing brace, not for a fixed number of lines.
 *
 * The window used to be 15 lines for hints and 11 for dark detection, which
 * truncated exactly the previews worth reading: a long body pushes the
 * modifiers that carry the configuration past the cap, so a preview that
 * declares dark was reported as not declaring it. Seen on IceCubesApp, where a
 * 17-line preview was flagged for a modifier written on its line 16 — and the
 * same report called it dark, because the two checks used different windows.
 */
describe('scanIos preview body extraction', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'phonebook-preview-body-'));
    const srcDir = join(projectDir, 'Sources');
    await mkdir(srcDir, { recursive: true });

    await writeFile(
      join(srcDir, 'DetailCard.swift'),
      `import SwiftUI

struct DetailCard: View {
  let title: String
  var body: some View {
    Text(title)
  }
}

#Preview("DetailCard/Dark", traits: .sizeThatFitsLayout) {
  DetailCard(
    title: "A title long enough that the call spans several lines",
    subtitle: "and a second argument",
    footnote: "and a third",
    trailing: "and a fourth",
    leading: "and a fifth",
    accessory: "and a sixth"
  )
  .padding()
  .withPreviewsEnv()
  .environment(Theme.shared)
  .environment(
    StatusDataControllerProvider.shared.dataController(
      for: Status.placeholder(),
      client: .init(server: ""))
  )
  .preferredColorScheme(.dark)
}

#Preview("DetailCard/Default", traits: .sizeThatFitsLayout) {
  DetailCard(title: "A title")
}
`,
    );
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('sees a .preferredColorScheme past the old line cap', async () => {
    const report = await scanIos(projectDir);
    const card = report.components.find((c) => c.name === 'DetailCard');
    const dark = card?.previews.find((p) => p.displayName === 'DetailCard/Dark');

    expect(dark?.dark).toBe(true);
    expect(dark?.hints ?? []).not.toContainEqual(expect.objectContaining({ rule: 'theme-dark' }));
  });

  it('stops at the preview it is reading, not the one after it', async () => {
    const report = await scanIos(projectDir);
    const card = report.components.find((c) => c.name === 'DetailCard');
    const dark = card?.previews.find((p) => p.displayName === 'DetailCard/Dark');

    expect(dark?.annotationText).toContain('.preferredColorScheme(.dark)');
    expect(dark?.annotationText).not.toContain('DetailCard/Default');
  });
});
