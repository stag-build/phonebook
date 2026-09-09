import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanIos } from './ios.js';
import { scanAndroid } from './android.js';

describe('scanIos gap detection', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'phonebook-gaps-ios-'));
    const srcDir = join(projectDir, 'Sources');
    await mkdir(srcDir, { recursive: true });

    await writeFile(
      join(srcDir, 'StatusRow.swift'),
      `import SwiftUI

enum LoadingState { case idle, loading }

class RouterPath {}

struct StatusRow: View {
  let isFocused: Bool
  var replies: [Status]
  var author: Account?
  var state: LoadingState
  var router: RouterPath
  private let title: String
  @Binding var draft: String

  var body: some View {
    Text(title)
  }

  var accessibilityLabel: String {
    title
  }
}

#Preview("StatusRow/Default") {
  StatusRow(isFocused: false, replies: [reply], author: .sample, state: .idle, draft: .constant(""))
}
`,
    );

    await writeFile(
      join(srcDir, 'CoveredRow.swift'),
      `import SwiftUI

struct CoveredRow: View {
  var replies: [Status]
  var author: Account?

  var body: some View { Text("hi") }
}

#Preview("CoveredRow/Empty") {
  CoveredRow(replies: [], author: nil)
}
`,
    );

    await writeFile(
      join(srcDir, 'QuietBadge.swift'),
      `import SwiftUI

struct QuietBadge: View {
  var body: some View { Text("hi") }
}
`,
    );

    // A localized project: two .lproj directories beyond Base.
    for (const locale of ['Base', 'de', 'he']) {
      await mkdir(join(projectDir, 'Resources', `${locale}.lproj`), { recursive: true });
    }
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('reads stored properties and skips body and computed properties', async () => {
    const report = await scanIos(projectDir);
    const row = report.components.find((c) => c.name === 'StatusRow');
    const names = (row?.properties ?? []).map((p) => p.name);

    expect(names).toContain('isFocused');
    expect(names).toContain('replies');
    expect(names).toContain('author');
    expect(names).toContain('draft');
    expect(names).not.toContain('body');
    expect(names).not.toContain('accessibilityLabel');
  });

  it('classifies each property by the states it implies', async () => {
    const report = await scanIos(projectDir);
    const row = report.components.find((c) => c.name === 'StatusRow');
    const kind = (name: string) => row?.properties?.find((p) => p.name === name)?.kind;

    expect(kind('isFocused')).toBe('bool');
    expect(kind('replies')).toBe('collection');
    expect(kind('author')).toBe('optional');
    expect(kind('state')).toBe('enum-like');
    expect(kind('title')).toBe('other');
  });

  it('reports the states one preview leaves uncovered', async () => {
    const report = await scanIos(projectDir);
    const row = report.components.find((c) => c.name === 'StatusRow');
    const rules = (row?.gaps ?? []).map((g) => g.rule);

    expect(rules).toContain('state-bool');
    expect(rules).toContain('state-collection');
    expect(rules).toContain('state-optional');
    expect(rules).toContain('theme-dark');
    expect(rules).not.toContain('no-preview');
  });

  it('takes a preview that passes the property itself as covering that state', async () => {
    const report = await scanIos(projectDir);
    const covered = report.components.find((c) => c.name === 'CoveredRow');
    const rules = (covered?.gaps ?? []).map((g) => g.rule);

    expect(rules).not.toContain('state-optional');
    expect(rules).not.toContain('state-collection');
  });

  it('asks for enum cases only for a type the project declares as an enum', async () => {
    const report = await scanIos(projectDir);
    const row = report.components.find((c) => c.name === 'StatusRow');
    const enumGaps = (row?.gaps ?? []).filter((g) => g.rule === 'state-enum');

    expect(enumGaps).toHaveLength(1);
    expect(enumGaps[0].message).toContain('LoadingState');
    expect(enumGaps.some((g) => g.message.includes('RouterPath'))).toBe(false);
  });

  it('leaves the development language out of the project locales', async () => {
    const withProject = await mkdtemp(join(tmpdir(), 'phonebook-gaps-devregion-'));
    await mkdir(join(withProject, 'App.xcodeproj'), { recursive: true });
    await writeFile(
      join(withProject, 'App.xcodeproj', 'project.pbxproj'),
      'developmentRegion = en;\n',
    );
    for (const locale of ['en', 'de']) {
      await mkdir(join(withProject, `${locale}.lproj`), { recursive: true });
    }

    const report = await scanIos(withProject);
    expect(report.extraLocales).toEqual(['de']);
    await rm(withProject, { recursive: true, force: true });
  });

  it('reports a component with no preview at all', async () => {
    const report = await scanIos(projectDir);
    const badge = report.components.find((c) => c.name === 'QuietBadge');
    expect((badge?.gaps ?? []).map((g) => g.rule)).toContain('no-preview');
  });

  it('finds the project locales and excludes Base', async () => {
    const report = await scanIos(projectDir);
    expect(report.extraLocales).toEqual(['de', 'he']);
    const row = report.components.find((c) => c.name === 'StatusRow');
    expect((row?.gaps ?? []).map((g) => g.rule)).toContain('localization');
  });

  it('counts components carrying a warning-level gap', async () => {
    const report = await scanIos(projectDir);
    expect(report.stats.componentsWithGaps).toBe(3);
    expect(report.stats.gapCount).toBeGreaterThan(0);
  });
});

describe('scanAndroid gap detection', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'phonebook-gaps-android-'));
    const srcDir = join(projectDir, 'app', 'src', 'main', 'java', 'dev', 'stag');
    await mkdir(srcDir, { recursive: true });
    await mkdir(join(projectDir, 'app', 'src', 'main', 'res', 'values-de'), { recursive: true });
    await mkdir(join(projectDir, 'app', 'src', 'main', 'res', 'values'), { recursive: true });

    await writeFile(
      join(srcDir, 'PrimaryButton.kt'),
      `package dev.stag

import androidx.compose.runtime.Composable

@Composable
fun PrimaryButton(
    text: String,
    enabled: Boolean,
    items: List<String>,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Text(text)
}

@Preview(name = "PrimaryButton/Enabled")
@Composable
private fun PrimaryButtonPreview() {
    PrimaryButton(text = "Continue", enabled = true, items = emptyList(), onClick = {})
}
`,
    );
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('reads composable parameters and skips Modifier', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const button = report.components.find((c) => c.name === 'PrimaryButton');
    const names = (button?.properties ?? []).map((p) => p.name);

    expect(names).toContain('text');
    expect(names).toContain('enabled');
    expect(names).toContain('items');
    expect(names).not.toContain('modifier');
  });

  it('classifies Kotlin types and reports the uncovered states', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const button = report.components.find((c) => c.name === 'PrimaryButton');
    const kind = (name: string) => button?.properties?.find((p) => p.name === name)?.kind;

    expect(kind('enabled')).toBe('bool');
    expect(kind('items')).toBe('collection');
    expect(kind('onClick')).toBe('other');

    const rules = (button?.gaps ?? []).map((g) => g.rule);
    expect(rules).toContain('state-bool');
    expect(rules).toContain('state-collection');
  });

  it('finds locales from resource directories and suggests Android syntax', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    expect(report.extraLocales).toEqual(['de']);

    const button = report.components.find((c) => c.name === 'PrimaryButton');
    const dark = (button?.gaps ?? []).find((g) => g.rule === 'theme-dark');
    expect(dark?.suggestion).toContain('UI_MODE_NIGHT_YES');
  });
});
