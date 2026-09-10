import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanIos } from './ios.js';
import { scopeReport } from './scope.js';

/**
 * Scoping the report to the files a turn changed hides the thing most likely
 * to break: a component is rendered by previews that live somewhere else. Edit
 * a row and the only preview showing it may sit in the list's file, which the
 * filter drops — so the agent finishes, and the gallery still shows the old row.
 *
 * Two answers, because the two cases are not the same question. A preview
 * elsewhere that renders what changed is a fact the agent can act on. A view
 * elsewhere that uses it and has no preview at all is a judgment about whether
 * that context is worth covering, which only the designer can make.
 */
describe('scopeReport reach', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'phonebook-reach-'));
    const src = join(projectDir, 'Sources');
    await mkdir(src, { recursive: true });

    await writeFile(
      join(src, 'Row.swift'),
      `import SwiftUI

struct Row: View {
  let title: String
  var body: some View { Text(title) }
}

#Preview("Row/Default") {
  Row(title: "hi")
}
`,
    );

    // Previews Row, and is not itself the file that declares Row.
    await writeFile(
      join(src, 'RowList.swift'),
      `import SwiftUI

struct RowList: View {
  var body: some View { Row(title: "in a list") }
}

#Preview("RowList/Default") {
  RowList()
}

#Preview("RowList/Single Row") {
  Row(title: "shown from the list's file")
}
`,
    );

    // Uses Row and has no preview of its own.
    await writeFile(
      join(src, 'RowScreen.swift'),
      `import SwiftUI

struct RowScreen: View {
  var body: some View { Row(title: "on a screen") }
}
`,
    );

    // Touches nothing that changed.
    await writeFile(
      join(src, 'Unrelated.swift'),
      `import SwiftUI

struct Unrelated: View {
  var body: some View { Text("nothing to do with Row") }
}

#Preview("Unrelated/Default") {
  Unrelated()
}
`,
    );
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  async function scoped() {
    return scopeReport(await scanIos(projectDir), ['Sources/Row.swift']);
  }

  it('names previews elsewhere that render what changed', async () => {
    const shown = (await scoped()).scope?.previewsOfWhatChanged ?? [];

    expect(shown.map((p) => p.name)).toContain('RowList/Single Row');
    expect(shown.every((p) => p.renders.includes('Row'))).toBe(true);
    // The component's own previews are already in the report.
    expect(shown.map((p) => p.name)).not.toContain('Row/Default');
  });

  it('leaves out previews that render nothing that changed', async () => {
    const shown = (await scoped()).scope?.previewsOfWhatChanged ?? [];
    expect(shown.map((p) => p.name)).not.toContain('Unrelated/Default');
  });

  it('asks about a view that uses what changed and has no preview', async () => {
    const ask = (await scoped()).scope?.uncoveredUsesOfWhatChanged ?? [];

    expect(ask.map((u) => u.component)).toEqual(['RowScreen']);
    expect(ask[0].uses).toContain('Row');
  });

  it('does not ask about a view whose own preview renders it', async () => {
    const ask = (await scoped()).scope?.uncoveredUsesOfWhatChanged ?? [];
    // RowList uses Row, but RowList has a preview, so rendering it renders Row.
    expect(ask.map((u) => u.component)).not.toContain('RowList');
  });
});
