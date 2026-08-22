# Manual testing on a real repo

How to validate Phonebook against a real open-source app. Android is the easier first target (no Xcode project surgery). Budget: ~30 min Android, ~45 min iOS.

Throughout, `phonebook` means running from this repo:

```sh
alias phonebook="npx tsx /Users/orelzion/git/phonebook/src/cli.ts"
```

## 1. Android on a real repo

Good candidates: any Compose app using `@Preview`. [Now in Android](https://github.com/android/nowinandroid) (multi-module, lots of previews) is the toughest realistic test; a single-module app is a gentler start.

1. Clone the repo, make sure it builds on your machine first (`./gradlew assembleDebug`).
2. `phonebook init -C /path/to/repo` — writes `phonebook.config.json`, prints the Gradle wiring instructions.
3. Edit the config: set `android.modules` to the module(s) whose previews you want (for nowinandroid that's UI modules like `":core:designsystem"`, not `":app"`).
4. Add the Gradle wiring from the init output to each listed module (plugin + test deps + `roborazzi { generateComposePreviewRobolectricTests { ... packages = listOf("<module's package>") } }`). Set `includePrivatePreviews = true` — most real repos declare previews `private`.
5. `phonebook doctor -C /path/to/repo` — fix anything it flags. Expect the JDK check to catch you if your default `java` is < 17 (set `JAVA_HOME`).
6. `phonebook generate -C /path/to/repo` — first run downloads Robolectric artifacts; expect minutes.
7. `phonebook build -C /path/to/repo && open /path/to/repo/phonebook-site/index.html`

What to judge:
- **Grouping quality** — this is the make-or-break risk (see PLAN.md). Do preview names like `ButtonPreview`, `NiaButtonPreview`, `@Preview(name="...")` land as sensible component/state groups, or as one component per preview? Note the ugly cases; they feed the naming-convention overrides.
- Multi-module: does the sidebar group by module correctly?
- Dark previews (`UI_MODE_NIGHT_YES`) fold into a Dark state, not separate components.
- Failures: previews that crash under Robolectric should fail the Gradle run legibly, not silently drop.

## 2. iOS on a real repo

Real-world friction is the test target. Pick a SwiftUI app with `#Preview`s (e.g. a small open-source SwiftUI app you can build; anything requiring signing tweaks — set the team to none and simulator-only).

1. Build it once in Xcode on a simulator.
2. `phonebook init -C /path/to/repo` — writes config (check `scheme` and `simulator` values against `xcodebuild -list`).
3. In Xcode: add the SPM package `https://github.com/getsentry/SnapshotPreviews`; add a **unit test** target hosted in the app; link product `SnapshottingTests` into it; add one file:
   ```swift
   import SnapshottingTests
   final class Snapshots: SnapshotTest {
     override class func snapshotPreviews() -> [String]? { nil }
   }
   ```
   Make sure the scheme's Test action includes this target and the scheme is shared.
4. `phonebook doctor -C /path/to/repo` — all checks green.
5. `phonebook generate -C /path/to/repo` (simulator boot + build: several minutes), then `build` as above.

What to judge:
- Previews without `.sizeThatFitsLayout` render full-device with transparency — annoying but correct? Decide whether v1 should auto-trim transparent borders (candidate for the backlog).
- `#Preview("Name/State")` vs unnamed previews: unnamed ones should group by their View's name with state "Default".
- UIKit-hosted or environment-dependent previews may fail — check the failure is visible, note which patterns break.

## 3. MCP server with Claude Code

From the target app's repo:

```sh
claude mcp add phonebook -- npx tsx /Users/orelzion/git/phonebook/src/cli.ts mcp
```

Then in a Claude Code session on that repo, try these prompts in order:

1. "Use phonebook's check_setup to see if this repo is ready for screenshot generation." — should mirror `doctor`.
2. "Analyze preview coverage and list components missing previews or dark variants." — judge the report against your own reading of the code.
3. "Add previews for <a component the report flagged>, following phonebook's preview guidance, then run generate and confirm the new screenshots appear." — the full agent loop: guidance → edit → run_generate. This is the core MCP value proposition; note where the agent needed hand-holding.
4. "Build the gallery site." — run_build.

## 4. Record findings

Append notes to this file or open issues: grouping misfires (with the preview's actual name), crashes, doctor checks that should exist but don't, MCP tool responses that confused the agent. These decide what M5 polish actually contains — and whether packaging can proceed as-is.
