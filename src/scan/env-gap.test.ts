import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanIos } from './ios.js';

/**
 * A preview that omits an @Environment object the view reads does not render
 * badly — it traps. SwiftUI has no default for an @Observable pulled out of the
 * environment, so the property's getter crashes the moment the body reads it.
 *
 * This is the failure a static scan is uniquely good at: the crash happens at
 * render, but the cause is legible in the source. SB-215's first run against
 * IceCubesApp wrote previews that parsed cleanly, passed every other rule here,
 * and trapped in Xcode on ToastCenter and SceneDelegate.
 */
describe('scanIos environment gaps', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'phonebook-env-gap-'));
    const srcDir = join(projectDir, 'Sources');
    await mkdir(srcDir, { recursive: true });

    // The helper lives in its own file, as it does in a real project: the
    // preview that calls it never names what it supplies.
    await writeFile(
      join(srcDir, 'PreviewEnv.swift'),
      `import SwiftUI

extension View {
  public func withPreviewsEnv() -> some View {
    environment(CurrentAccount.shared)
      .environment(RouterPath())
  }
}
`,
    );

    await writeFile(
      join(srcDir, 'Cards.swift'),
      `import SwiftUI

struct ToastyCard: View {
  @Environment(ToastCenter.self) private var toasts
  @Environment(\\.openURL) private var openURL
  let title: String
  var body: some View { Text(title) }
}

#Preview("ToastyCard/Default") {
  ToastyCard(title: "hi")
}

struct ThemedCard: View {
  @Environment(Theme.self) private var theme
  let title: String
  var body: some View { Text(title) }
}

#Preview("ThemedCard/Default") {
  ThemedCard(title: "hi")
    .environment(Theme.shared)
}

struct AccountCard: View {
  @Environment(CurrentAccount.self) private var account
  let title: String
  var body: some View { Text(title) }
}

#Preview("AccountCard/Default") {
  AccountCard(title: "hi")
    .withPreviewsEnv()
}

struct DataCard: View {
  @Environment(StatusDataController.self) private var data
  let title: String
  var body: some View { Text(title) }
}

#Preview("DataCard/Default") {
  DataCard(title: "hi")
    .environment(
      StatusDataControllerProvider.shared.dataController(
        for: Status.placeholder(),
        client: .init(server: ""))
    )
}
`,
    );
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  async function gapsFor(name: string) {
    const report = await scanIos(projectDir);
    return report.components.find((c) => c.name === name)?.gaps ?? [];
  }

  it('flags an environment object no preview supplies', async () => {
    const gaps = await gapsFor('ToastyCard');
    const env = gaps.filter((g) => g.rule === 'env-missing');

    expect(env).toHaveLength(1);
    expect(env[0].message).toContain('ToastCenter');
    expect(env[0].severity).toBe('warning');
  });

  it('leaves keypath environment values alone', async () => {
    const gaps = await gapsFor('ToastyCard');
    expect(gaps.filter((g) => g.rule === 'env-missing' && g.message.includes('openURL'))).toHaveLength(0);
  });

  it('is silent when the preview supplies it directly', async () => {
    expect((await gapsFor('ThemedCard')).filter((g) => g.rule === 'env-missing')).toHaveLength(0);
  });

  it('is silent when a helper the preview calls supplies it', async () => {
    expect((await gapsFor('AccountCard')).filter((g) => g.rule === 'env-missing')).toHaveLength(0);
  });

  it('is silent when the value comes from a provider of that type', async () => {
    expect((await gapsFor('DataCard')).filter((g) => g.rule === 'env-missing')).toHaveLength(0);
  });
});

/**
 * A legacy `X_Previews: PreviewProvider` struct is a preview like any other.
 * Reporting nothing for its body made it look like it declared nothing —
 * never dark, and supplying no environment object it in fact supplies — which
 * put two false alarms on the oldest previews in a project.
 */
describe('scanIos legacy PreviewProvider bodies', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'phonebook-legacy-'));
    const srcDir = join(projectDir, 'Sources');
    await mkdir(srcDir, { recursive: true });

    await writeFile(
      join(srcDir, 'LegacyCard.swift'),
      `import SwiftUI

struct LegacyCard: View {
  @Environment(Theme.self) private var theme
  let title: String
  var body: some View { Text(title) }
}

struct LegacyCard_Previews: PreviewProvider {
  static var previews: some View {
    LegacyCard(title: "hi")
      .environment(Theme.shared)
      .preferredColorScheme(.dark)
  }
}
`,
    );
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('sees what a legacy preview supplies and declares', async () => {
    const report = await scanIos(projectDir);
    const card = report.components.find((c) => c.name === 'LegacyCard');

    expect(card?.previews[0]?.dark).toBe(true);
    expect((card?.gaps ?? []).map((g) => g.rule)).not.toContain('env-missing');
    expect((card?.gaps ?? []).map((g) => g.rule)).not.toContain('theme-dark');
  });
});
