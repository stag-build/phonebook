# Phonebook — Plan

Storybook for native mobile: harvest existing Compose `@Preview`s and SwiftUI `#Preview`s as screenshots, publish a static HTML component gallery for designers. CLI generates; MCP prepares the codebase; CI-friendly; publishing is out of scope.

## Positioning

- Closest existing product: **Emerge Tools Snapshots** (paid SaaS: preview-based snapshot generation + hosted gallery + diffing). Phonebook is the open-source, self-hosted, static-output alternative.
- Nothing today produces a **static web gallery from native previews** on either platform. In-app catalogs exist (eure/swift-storybook, JetBrains Storytale) but designers can't open them in a browser.

## Core decisions (settled)

1. **Grouping**: naming convention. Parse `@Preview(name="Button/Disabled")`, function names (`ButtonDisabledPreview`), and file/module location into `component / state`. No required annotation. MCP normalizes messy names by editing code.
2. **Stack**: TypeScript, npm, published under the `@stag-build` scope (`phonebook` and the `stag` scope were both already taken on npm). One package for v1: `@stag-build/phonebook` — CLI, MCP subcommand, and site builder together; split into `@stag-build/phonebook-*` packages only if size demands it. Binary name stays `phonebook`.
3. **Integration**: users (or their agent, via MCP guidance) add the platform dependencies; the CLI only orchestrates builds and harvests output. `phonebook init` scaffolds config + code snippets but never silently mutates builds.
4. **Repos are independent, and v1 is single-platform**: Android repo and iOS repo each run Phonebook alone with their own `phonebook.config.json`. Generation emits a self-contained **bundle** (manifest + images); `build` takes exactly one bundle in v1 and produces that platform's site. The bundle format is designed so a future `build` can accept N bundles and merge (cross-platform site), but merging is post-v1.
5. **Render matrix**: honor what each preview declares (uiMode, device, traits). One screenshot per declared preview. Missing dark-mode/state coverage is fixed by adding previews in code — that's the MCP's job, not a render matrix.
6. **iOS setup**: documented manual step to add the small XCTest target; MCP generates the Swift file and detects a missing target. No .pbxproj mutation by the CLI.

## Engine choices

### Android: Roborazzi + ComposablePreviewScanner
- Scans all `@Preview`s in the **main source set** (previews stay useful in the IDE), zero per-preview test code, runs on JVM/Robolectric — **no emulator, Linux CI works**.
- Rejected: Google's Compose Preview Screenshot Testing (forces previews into a separate source set); Paparazzi alone (hand-written tests per preview; can revisit as an alternate engine behind the same manifest format).
- CLI runs a Gradle task (Roborazzi record) and harvests PNGs + preview metadata into the bundle.

### iOS: SnapshotPreviews (getsentry)
- Auto-discovers `#Preview` / `PreviewProvider`, generates one XCTestCase per preview, snapshots via simulator. Requires a **macOS runner** — accepted cost.
- Rejected: swift-snapshot-testing (manual test per view defeats "use existing previews").
- CLI runs `xcodebuild test` on the snapshot target, harvests images from the result bundle / emitted directory.

## The bundle (contract between generate and build)

```
phonebook-out/
  manifest.json
  images/<hash>.png
```

`manifest.json` (versioned schema):
- `schemaVersion`, `platform` (android|ios), `app` (name, repo, commit, generatedAt)
- `entries[]`: `component`, `state`, `module`, `sourceFile`, `previewName`, `image`, `width`, `height`, `theme?`, `device?`, `tags?`

This contract is the whole architecture: engines are swappable, platforms never couple, and the site builder is engine-agnostic.

## CLI commands

1. `phonebook init` — detect platform (settings.gradle vs .xcodeproj/Package.swift), write `phonebook.config.json`, print the dependency/setup snippets (Gradle plugin block / SPM + test target file).
2. `phonebook doctor` — verify libraries are wired (Roborazzi plugin present? snapshot test target exists? JDK/Xcode/simulator available). Same checks the MCP exposes.
3. `phonebook generate` — run the platform engine, harvest into `phonebook-out/`. Flags: `--module`, `--filter`, `--output`.
4. `phonebook build <bundle>` — one bundle → static site in `phonebook-site/` (plain HTML/CSS/JS, no server; openable from file:// and any static host). Post-v1: accept multiple bundles and merge.
5. `phonebook serve` — local preview of the built site (dev convenience).

Config (`phonebook.config.json`): platform, gradle module list or xcode scheme/destination, package/target filters, grouping overrides (regex → component/state), output dir.

## Static site

v1: **component grid, one platform per site.** Sidebar grouped by module → component; component page shows all states with labels; light/dark page theme.

Later (in priority order):
1. Search + filters (theme, device, text).
2. Multi-bundle merge + side-by-side platform view when component names match across bundles — the cross-platform selling point.
3. Version diffing between two runs (v2; the manifest already carries commit + image hashes to enable it).

## MCP server

Ships in the same package (`phonebook mcp`, stdio). Tools:

1. `analyze_coverage` — scan the codebase: list components (public composables / SwiftUI views), which have previews, which states/themes are missing. Read-only.
2. `get_preview_guidance` — return platform-correct preview templates + the naming convention for a given component, so any agent writes consistent previews.
3. `check_setup` — report missing libraries/wiring (wraps `doctor`): Roborazzi/CPS plugin, SnapshotPreviews package, test target, config file.
4. `run_generate` / `run_build` — invoke the CLI, return structured pass/fail per preview so the agent can fix broken previews and rerun.

The MCP never edits files itself — the agent's own edit tools do that, guided by 1–2.

## CI recipes (docs, not code we own)

- Android repo: Linux runner → `phonebook generate` → `phonebook build phonebook-out` → upload/publish site artifact (Pages, S3, Vercel — user's choice, out of scope).
- iOS repo: macOS runner, boot simulator → same two commands.
- Combined (post-v1): a job that downloads both repos' bundle artifacts → multi-bundle `phonebook build` → publish.

## Milestones

1. **M1 — Android vertical slice** (~core): config + `generate` via Roborazzi/CPS on a sample app + manifest + minimal grid site. Proves the whole loop.
2. **M2 — iOS engine**: SnapshotPreviews orchestration, xcresult harvesting, same manifest. Sample SwiftUI app.
3. **M3 — `init` + `doctor` + docs**, npm publish as `@stag-build/phonebook`.
4. **M4 — MCP server** (coverage, guidance, setup check, run).
5. **M5 — post-v1**: search/filters, multi-bundle merge + side-by-side view, CI recipe docs, version diffing.

## Risks

1. **Naming-convention parsing is the make-or-break UX.** Mitigation: strict documented convention + config regex overrides + MCP normalization; fall back to "one component per file" when parsing fails.
2. **SnapshotPreviews rendering gaps** (some UIKit-hosted views, environment-dependent previews fail off-device). Mitigation: per-preview failure reporting in the manifest, skip-list in config.
3. **Robolectric fidelity** (screenshots are not pixel-identical to devices). Acceptable for a design gallery; document it.
4. **Engine churn** (Google may mature CPST). The bundle contract isolates us — engines are adapters.
5. **npm name**: `phonebook` and the `@stag` scope were both taken — publishing as `@stag-build/phonebook` instead.
