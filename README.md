# @stag/phonebook

Static, Storybook-style component gallery generated from screenshots your team already has: Compose `@Preview`s and SwiftUI `#Preview`s. No new test code, no design tokens to maintain by hand — Phonebook renders what's already in your codebase into a browsable HTML site designers can open without installing anything.

Think of it as the open-source, self-hosted alternative to Emerge Tools Snapshots' gallery: same idea (harvest previews, publish a static site), no SaaS account required.

Each repo runs Phonebook independently. v1 is single-platform: one Android repo (or one iOS repo) produces one bundle, and `phonebook build` turns that bundle into one site.

## How it works

1. `phonebook generate` runs your platform's preview-rendering engine and harvests the output into a **bundle** (`manifest.json` + `images/`).
   - Android: [Roborazzi](https://github.com/takahirom/roborazzi) + [ComposablePreviewScanner](https://github.com/sergio-sastre/ComposablePreviewScanner), run on the JVM via Robolectric. No emulator, works on Linux CI.
   - iOS: [SnapshotPreviews](https://github.com/getsentry/SnapshotPreviews), run via `xcodebuild test` on a simulator. Requires macOS.
2. `phonebook build <bundle>` turns that bundle into a static site (`phonebook-site/index.html` by default) — plain HTML/CSS/JS, works from `file://` or any static host.

Commands run via `npx tsx src/cli.ts <cmd>` for now (npm packaging as `@stag/phonebook` is pending — this repo is not yet on npm).

## Quickstart: Android

Add the Roborazzi Gradle plugin and preview-scanner test deps (see `samples/android/app/build.gradle.kts` for a full working example):

```kotlin
// app/build.gradle.kts
plugins {
    id("io.github.takahirom.roborazzi") // root build.gradle.kts: version "1.72.0" apply false
}

roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
        packages = listOf("dev.stag.phonebook.sample") // your app's package
    }
}

dependencies {
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.72.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.72.0")
    testImplementation("io.github.sergio-sastre.ComposablePreviewScanner:android:0.9.3")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose-preview-scanner-support:1.72.0")
}
```

Add a `phonebook.config.json` next to `settings.gradle.kts`:

```json
{
  "appName": "My Android App",
  "platform": "android",
  "android": { "modules": [":app"], "variant": "debug" }
}
```

Then, from the repo containing Phonebook:

```sh
npx tsx src/cli.ts generate -C /path/to/your/android/repo
npx tsx src/cli.ts build /path/to/your/android/repo/phonebook-out
```

Open `phonebook-site/index.html`.

## Quickstart: iOS

Add the [SnapshotPreviews](https://github.com/getsentry/SnapshotPreviews) SPM package to your project and a small XCTest target that subclasses `SnapshotTest` (see `samples/ios` for a full working example):

```swift
// PhonebookSnapshotTests.swift
import SnapshottingTests

final class PhonebookSnapshotTests: SnapshotTest {
    override class func snapshotPreviews() -> [String]? {
        return nil // record every #Preview
    }
}
```

Add `phonebook.config.json` next to your `.xcodeproj`:

```json
{
  "appName": "My iOS App",
  "platform": "ios",
  "ios": {
    "project": "MyApp.xcodeproj",
    "scheme": "MyApp",
    "simulator": "iPhone 17 Pro"
  }
}
```

Your scheme must build and test the snapshot test target (see `PhonebookSample.xcscheme` in the sample). Then:

```sh
npx tsx src/cli.ts generate -C /path/to/your/ios/repo
npx tsx src/cli.ts build /path/to/your/ios/repo/phonebook-out
```

## Naming convention

Phonebook groups screenshots into `component / state` cards from your existing preview names — no required annotation. See [docs/naming-convention.md](docs/naming-convention.md) for the full rules and examples.

## Config reference (`phonebook.config.json`)

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `appName` | string | — | Required. Shown in the gallery header. |
| `platform` | `"android"` \| `"ios"` | — | Required. |
| `output` | string | `"phonebook-out"` | Bundle output directory, relative to the config file. |
| `android.modules` | string[] | `[":app"]` | Gradle modules to record. |
| `android.variant` | string | `"debug"` | Build variant; Phonebook runs `<module>:recordRoborazzi<Variant>`. |
| `ios.project` | string | — | Path to `.xcodeproj`, relative to the config file. One of `project`/`workspace` required. |
| `ios.workspace` | string | — | Path to `.xcworkspace`, relative to the config file. |
| `ios.scheme` | string | — | Required. Scheme that includes the SnapshotPreviews test target. |
| `ios.simulator` | string | `"iPhone 17 Pro"` | Simulator device name used for `-destination`. |

`phonebook generate` also accepts `-C <dir>` (project directory containing `phonebook.config.json`) and `-o <dir>` (bundle output override). `phonebook build <bundle>` accepts `-o <dir>` for the site output directory (default `phonebook-site`).

## `phonebook init` and `phonebook doctor`

`phonebook init` will detect your platform and scaffold `phonebook.config.json` plus the dependency/setup snippets shown above — it never edits your build files for you. `phonebook doctor` will check that the required plugin, test target, and toolchain (JDK/Xcode/simulator) are wired up correctly before you run `generate`. Both are being added in parallel with this doc and aren't in the CLI yet (only `generate` and `build` are implemented today).

## Requirements

**Android**: JDK 17+. No emulator needed — Roborazzi renders on the JVM via Robolectric, so `generate` runs on Linux CI.

**iOS**: macOS with Xcode installed, plus a booted or bootable simulator (`generate` runs `xcodebuild test` against a named simulator destination). Requires a macOS runner in CI.

See [docs/ci.md](docs/ci.md) for CI recipes and [docs/naming-convention.md](docs/naming-convention.md) for the naming rules.
