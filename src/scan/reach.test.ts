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

    // Two hops from Row: its only preview names RowPage, nothing below it.
    await writeFile(
      join(src, 'RowPage.swift'),
      `import SwiftUI

struct RowPage: View {
  var body: some View { RowList() }
}

#Preview("RowPage/Default") {
  RowPage()
}
`,
    );

    // Has a preview, but only shows Row behind a condition the preview never sets.
    // This is IceCubes' StatusRowView: previewed in the timeline context, where the
    // detail view it renders when focused never appears.
    await writeFile(
      join(src, 'RowToggle.swift'),
      `import SwiftUI

struct RowToggle: View {
  @Environment(\\.isFocused) private var isFocused

  var body: some View {
    VStack {
      Text("always here")
      if isFocused {
        Row(title: "only when focused")
      }
    }
  }
}

#Preview("RowToggle/Default") {
  RowToggle()
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

    const screen = ask.find((u) => u.component === 'RowScreen');
    expect(screen?.uses).toContain('Row');
    expect(screen?.reason).toBe('no-preview');
  });

  it('names a preview that reaches what changed through the component it renders', async () => {
    const shown = (await scoped()).scope?.previewsOfWhatChanged ?? [];

    // "RowList/Default" says only `RowList()`. Row never appears in its text,
    // and it is still the preview that shows the changed row on screen.
    const viaParent = shown.find((p) => p.name === 'RowList/Default');
    expect(viaParent).toBeDefined();
    expect(viaParent?.renders).toContain('Row');
  });

  it('follows the graph further than one hop', async () => {
    const shown = (await scoped()).scope?.previewsOfWhatChanged ?? [];

    // RowPage renders RowList renders Row.
    expect(shown.map((p) => p.name)).toContain('RowPage/Default');
  });

  it('does not claim a preview shows what it only reaches behind a condition', async () => {
    const shown = (await scoped()).scope?.previewsOfWhatChanged ?? [];

    // The same preview the ask list names. Claiming it renders Row and asking
    // whether Row is shown anywhere would be two answers to one question.
    expect(shown.map((p) => p.name)).not.toContain('RowToggle/Default');
  });

  it('asks about a view whose preview only renders what changed behind a condition', async () => {
    const ask = (await scoped()).scope?.uncoveredUsesOfWhatChanged ?? [];

    // RowToggle has a preview, and that preview does not set the condition that
    // brings Row on screen. Having a preview is not the same as showing this.
    const guarded = ask.find((u) => u.component === 'RowToggle');
    expect(guarded).toBeDefined();
    expect(guarded?.uses).toContain('Row');
    expect(guarded?.reason).toBe('conditional');
  });

  it('does not ask about a view whose own preview renders it', async () => {
    const ask = (await scoped()).scope?.uncoveredUsesOfWhatChanged ?? [];
    // RowList uses Row, but RowList has a preview, so rendering it renders Row.
    expect(ask.map((u) => u.component)).not.toContain('RowList');
  });
});
