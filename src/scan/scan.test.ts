import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAndroid } from './android.js';
import { scanIos } from './ios.js';

describe('scanAndroid', () => {
  let root: string;
  let projectDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'phonebook-scan-android-'));
    projectDir = root;

    const srcDir = join(projectDir, 'app', 'src', 'main', 'java', 'dev', 'stag');
    await mkdir(srcDir, { recursive: true });

    await writeFile(
      join(srcDir, 'PrimaryButton.kt'),
      `package dev.stag

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

@Composable
fun PrimaryButton(text: String) {
    Text(text)
}

@Preview(name = "Button/Enabled")
@Composable
private fun PrimaryButtonEnabledPreview() {
    PrimaryButton(text = "Continue")
}

@Preview(name = "Button/Disabled")
@Composable
private fun PrimaryButtonDisabledPreview() {
    PrimaryButton(text = "Continue")
}
`,
      'utf8',
    );

    await writeFile(
      join(srcDir, 'UserCard.kt'),
      `package dev.stag

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

@Composable
fun UserCard(name: String) {
    Text(name)
}

@Preview
@Composable
private fun UserCardPreview() {
    UserCard(name = "Ada")
}

@Preview(uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun UserCardDarkPreview() {
    UserCard(name = "Ada")
}
`,
      'utf8',
    );

    // A preview whose name doesn't match any component -> orphan.
    await writeFile(
      join(srcDir, 'Orphan.kt'),
      `package dev.stag

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

@Preview
@Composable
private fun MysteryPreview() {
}
`,
      'utf8',
    );

    // Self-preview pattern: @Preview directly on the composable it previews, no
    // separate component.
    await writeFile(
      join(srcDir, 'SplashContent.kt'),
      `package dev.stag

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

@Preview(showBackground = true)
@Composable
fun SplashContentLandscape(onNavigateToSignup: () -> Unit = {}) {
    Text("splash")
}
`,
      'utf8',
    );

    // Both patterns in one file: a wrapper preview of SecondaryButton, plus a
    // self-previewed screen-level composable.
    await writeFile(
      join(srcDir, 'Mixed.kt'),
      `package dev.stag

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

@Composable
fun SecondaryButton(text: String) {
    Text(text)
}

@Preview
@Composable
private fun SecondaryButtonPreview() {
    SecondaryButton(text = "Cancel")
}

@Preview
@Composable
fun MixedScreen() {
    Text("mixed screen")
}
`,
      'utf8',
    );

    // A build output directory that must be skipped.
    const buildDir = join(projectDir, 'app', 'src', 'main', 'java', 'dev', 'stag', 'build');
    await mkdir(buildDir, { recursive: true });
    await writeFile(
      join(buildDir, 'Generated.kt'),
      `package dev.stag

import androidx.compose.runtime.Composable

@Composable
fun ShouldBeIgnored() {}
`,
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('discovers composable components', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const names = report.components.map((c) => c.name).sort();
    expect(names).toContain('PrimaryButton');
    expect(names).toContain('UserCard');
  });

  it('skips build/ directories', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const names = report.components.map((c) => c.name);
    expect(names).not.toContain('ShouldBeIgnored');
  });

  it('matches previews to components by longest name-prefix, same file', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const button = report.components.find((c) => c.name === 'PrimaryButton');
    expect(button?.previews.map((p) => p.name).sort()).toEqual(
      ['PrimaryButtonDisabledPreview', 'PrimaryButtonEnabledPreview'].sort(),
    );
  });

  it('extracts displayName from name = "..." preview args', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const button = report.components.find((c) => c.name === 'PrimaryButton');
    const enabled = button?.previews.find((p) => p.name === 'PrimaryButtonEnabledPreview');
    expect(enabled?.displayName).toBe('Button/Enabled');
  });

  it('detects dark previews via UI_MODE_NIGHT_YES', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const card = report.components.find((c) => c.name === 'UserCard');
    const dark = card?.previews.find((p) => p.name === 'UserCardDarkPreview');
    expect(dark?.dark).toBe(true);
    const light = card?.previews.find((p) => p.name === 'UserCardPreview');
    expect(light?.dark).toBe(false);
  });

  it('treats a @Preview composable with no matching component as a self-preview, not an orphan', async () => {
    // MysteryPreview has no separate non-preview composable in its file to attach
    // to (unlike PrimaryButton/UserCard's wrapper previews), so it becomes a
    // component that is its own preview, per the self-preview pattern.
    const report = await scanAndroid(projectDir, [':app']);
    expect(report.orphanPreviews.map((p) => p.name)).not.toContain('MysteryPreview');
    const mystery = report.components.find((c) => c.name === 'MysteryPreview');
    expect(mystery?.previews.map((p) => p.name)).toEqual(['MysteryPreview']);
  });

  it('self-preview pattern: a @Preview @Composable fun with no separate component becomes a component covered by itself', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const splash = report.components.find((c) => c.name === 'SplashContentLandscape');
    expect(splash).toBeDefined();
    expect(splash?.previews.map((p) => p.name)).toEqual(['SplashContentLandscape']);
    expect(report.orphanPreviews.map((p) => p.name)).not.toContain('SplashContentLandscape');
  });

  it('wrapper pattern: a @Preview fun matching an existing component by name-prefix still attaches to it, not itself', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const secondary = report.components.find((c) => c.name === 'SecondaryButton');
    expect(secondary?.previews.map((p) => p.name)).toEqual(['SecondaryButtonPreview']);
    // The wrapper preview function itself is not a separate component.
    expect(report.components.map((c) => c.name)).not.toContain('SecondaryButtonPreview');
  });

  it('handles both the wrapper and self-preview patterns in the same file', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const secondary = report.components.find((c) => c.name === 'SecondaryButton');
    const mixedScreen = report.components.find((c) => c.name === 'MixedScreen');
    expect(secondary?.previews.map((p) => p.name)).toEqual(['SecondaryButtonPreview']);
    expect(mixedScreen?.previews.map((p) => p.name)).toEqual(['MixedScreen']);
  });

  it('computes stats', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    // PrimaryButton, UserCard, MysteryPreview, SplashContentLandscape,
    // SecondaryButton, MixedScreen.
    expect(report.stats.components).toBe(6);
    expect(report.stats.withPreview).toBe(6);
    expect(report.stats.withDarkPreview).toBe(1);
    expect(report.stats.totalPreviews).toBe(8); // 2 + 2 + 1 + 1 + 1 + 1, no orphans
    expect(report.orphanPreviews).toEqual([]);
  });

  it('reports selfPreviewed count in stats', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    // MysteryPreview, SplashContentLandscape, MixedScreen.
    expect(report.stats.selfPreviewed).toBe(3);
  });

  it('reports file paths relative to projectDir', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const button = report.components.find((c) => c.name === 'PrimaryButton');
    expect(button?.file).toBe(join('app', 'src', 'main', 'java', 'dev', 'stag', 'PrimaryButton.kt'));
  });

  it('captures the raw @Preview annotation text', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const button = report.components.find((c) => c.name === 'PrimaryButton');
    const enabled = button?.previews.find((p) => p.name === 'PrimaryButtonEnabledPreview');
    expect(enabled?.annotationText).toContain('@Preview(name = "Button/Enabled")');
  });

  it('attaches configuration hints to previews (unnamed-preview for a bare @Preview)', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const card = report.components.find((c) => c.name === 'UserCard');
    const unnamed = card?.previews.find((p) => p.name === 'UserCardPreview');
    expect(unnamed?.hints?.map((h) => h.rule)).toContain('unnamed-preview');

    const named = card?.previews.find((p) => p.name === 'UserCardDarkPreview');
    // Has no displayName either, so it also gets unnamed-preview, but not theme-dark
    // since UI_MODE_NIGHT_YES is declared.
    expect(named?.hints?.map((h) => h.rule)).not.toContain('theme-dark');
  });

  it('rolls up hintCount in stats', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    expect(report.stats.hintCount).toBeGreaterThan(0);
  });

  it('captures the preview function body text', async () => {
    const report = await scanAndroid(projectDir, [':app']);
    const splash = report.components.find((c) => c.name === 'SplashContentLandscape');
    const preview = splash?.previews.find((p) => p.name === 'SplashContentLandscape');
    expect(preview?.bodyText).toContain('Text("splash")');
  });
});

describe('scanIos', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'phonebook-scan-ios-'));
    const srcDir = join(projectDir, 'Sample', 'Components');
    await mkdir(srcDir, { recursive: true });

    await writeFile(
      join(srcDir, 'UserCard.swift'),
      `import SwiftUI

struct UserCard: View {
    let name: String

    var body: some View {
        Text(name)
    }
}

#Preview("UserCard/Default", traits: .sizeThatFitsLayout) {
    UserCard(name: "Ada")
}

#Preview("UserCard/Dark", traits: .sizeThatFitsLayout) {
    UserCard(name: "Ada")
        .preferredColorScheme(.dark)
}
`,
      'utf8',
    );

    await writeFile(
      join(srcDir, 'StatusBadge.swift'),
      `import SwiftUI

struct StatusBadge: View {
    let text: String

    var body: some View {
        Text(text)
    }
}

#Preview {
    StatusBadge(text: "Active")
}

struct StatusBadge_Previews: PreviewProvider {
    static var previews: some View {
        StatusBadge(text: "Active")
    }
}
`,
      'utf8',
    );

    // Orphan: no component in file.
    await writeFile(
      join(srcDir, 'Orphan.swift'),
      `import SwiftUI

#Preview("Nothing/Here") {
    Text("nothing")
}
`,
      'utf8',
    );

    // Should be skipped entirely (Test dir).
    const testDir = join(projectDir, 'SampleTests');
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'Ignored.swift'),
      `import SwiftUI

struct IgnoredView: View {
    var body: some View { Text("x") }
}
`,
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('discovers SwiftUI View structs', async () => {
    const report = await scanIos(projectDir);
    const names = report.components.map((c) => c.name).sort();
    expect(names).toEqual(['StatusBadge', 'UserCard']);
  });

  it('skips directories with "Test" in the path', async () => {
    const report = await scanIos(projectDir);
    expect(report.components.map((c) => c.name)).not.toContain('IgnoredView');
  });

  it('matches #Preview blocks via "Component/State" display name', async () => {
    const report = await scanIos(projectDir);
    const card = report.components.find((c) => c.name === 'UserCard');
    expect(card?.previews.map((p) => p.displayName).sort()).toEqual(
      ['UserCard/Default', 'UserCard/Dark'].sort(),
    );
  });

  it('detects dark previews via .preferredColorScheme(.dark)', async () => {
    const report = await scanIos(projectDir);
    const card = report.components.find((c) => c.name === 'UserCard');
    const dark = card?.previews.find((p) => p.displayName === 'UserCard/Dark');
    expect(dark?.dark).toBe(true);
    const light = card?.previews.find((p) => p.displayName === 'UserCard/Default');
    expect(light?.dark).toBe(false);
  });

  it('attaches an unnamed #Preview to the single component in the file', async () => {
    const report = await scanIos(projectDir);
    const badge = report.components.find((c) => c.name === 'StatusBadge');
    const unnamed = badge?.previews.find((p) => p.name === 'unnamed');
    expect(unnamed).toBeDefined();
  });

  it('matches legacy X_Previews: PreviewProvider structs to component X', async () => {
    const report = await scanIos(projectDir);
    const badge = report.components.find((c) => c.name === 'StatusBadge');
    const legacy = badge?.previews.find((p) => p.name === 'StatusBadge_Previews');
    expect(legacy).toBeDefined();
    expect(legacy?.dark).toBe(false);
  });

  it('puts previews with no component in the file into orphanPreviews', async () => {
    const report = await scanIos(projectDir);
    expect(report.orphanPreviews.map((p) => p.displayName)).toContain('Nothing/Here');
  });

  it('computes stats', async () => {
    const report = await scanIos(projectDir);
    expect(report.stats.components).toBe(2);
    expect(report.stats.withPreview).toBe(2);
    expect(report.stats.withDarkPreview).toBe(1);
    expect(report.stats.totalPreviews).toBe(5); // 2 + 2 + 1 orphan
    // #Preview is always a separate top-level block on iOS; a View struct can't
    // be its own preview the way an Android @Preview @Composable can.
    expect(report.stats.selfPreviewed).toBe(0);
  });

  it('reports file paths relative to projectDir', async () => {
    const report = await scanIos(projectDir);
    const card = report.components.find((c) => c.name === 'UserCard');
    expect(card?.file).toBe(join('Sample', 'Components', 'UserCard.swift'));
  });

  it('captures the raw #Preview annotation text', async () => {
    const report = await scanIos(projectDir);
    const card = report.components.find((c) => c.name === 'UserCard');
    const dark = card?.previews.find((p) => p.displayName === 'UserCard/Dark');
    expect(dark?.annotationText).toContain('#Preview("UserCard/Dark"');
    expect(dark?.annotationText).toContain('.preferredColorScheme(.dark)');
  });

  it('attaches configuration hints to previews (sizing info when no traits: is declared)', async () => {
    const report = await scanIos(projectDir);
    const badge = report.components.find((c) => c.name === 'StatusBadge');
    const unnamed = badge?.previews.find((p) => p.name === 'unnamed');
    expect(unnamed?.hints?.map((h) => h.rule)).toContain('sizing');
    expect(unnamed?.hints?.map((h) => h.rule)).toContain('unnamed-preview');

    const card = report.components.find((c) => c.name === 'UserCard');
    const named = card?.previews.find((p) => p.displayName === 'UserCard/Default');
    // Has traits: .sizeThatFitsLayout declared, so no sizing hint.
    expect(named?.hints?.map((h) => h.rule) ?? []).not.toContain('sizing');
  });

  it('rolls up hintCount in stats', async () => {
    const report = await scanIos(projectDir);
    expect(report.stats.hintCount).toBeGreaterThan(0);
  });
});
