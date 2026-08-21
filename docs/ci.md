# CI recipes

Phonebook doesn't publish anything itself — `phonebook build` just writes a static site directory (`phonebook-site/` by default). What you do with that directory (GitHub Pages, S3, Vercel, an internal static host) is up to you; these recipes stop at "upload the artifact."

Each recipe assumes your repo already has the platform setup described in the [README](../README.md) quickstart: a `phonebook.config.json`, the Roborazzi plugin (Android) or SnapshotPreviews package + test target (iOS).

## Android — ubuntu-latest

Android rendering runs on the JVM via Robolectric, so it needs no emulator and works on a plain Linux runner. The sample project (`samples/android`) targets `sourceCompatibility`/`targetCompatibility` `VERSION_17` and ships a Gradle 8.14.5 wrapper, so use JDK 17 and the repo's own `./gradlew`.

```yaml
name: phonebook-android
on: [push]
jobs:
  gallery:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - uses: gradle/actions/setup-gradle@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Check out phonebook
        uses: actions/checkout@v4
        with:
          repository: <your-org>/phonebook
          path: phonebook

      - run: npx --prefix phonebook tsx phonebook/src/cli.ts generate -C .
      - run: npx --prefix phonebook tsx phonebook/src/cli.ts build phonebook-out

      - uses: actions/upload-artifact@v4
        with:
          name: phonebook-site
          path: phonebook-site
```

`gradle/actions/setup-gradle` caches the wrapper distribution and dependency downloads between runs, so `generate` (which invokes `./gradlew :app:recordRoborazziDebug`) doesn't re-download Gradle every build.

To publish to GitHub Pages instead of a plain artifact, swap the last step for `actions/upload-pages-artifact@v3` pointed at `phonebook-site`, and add a `deploy` job using `actions/deploy-pages@v4` — same static directory either way.

## iOS — macos-15

SnapshotPreviews needs a real simulator, so this job requires a macOS runner. `xcodebuild test` boots the simulator implicitly from the `-destination` you pass in `phonebook.config.json` (`ios.simulator`, default `"iPhone 17 Pro"`) — no separate `xcrun simctl boot` step is required.

```yaml
name: phonebook-ios
on: [push]
jobs:
  gallery:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4

      - name: Select Xcode
        run: sudo xcode-select -s /Applications/Xcode.app

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Check out phonebook
        uses: actions/checkout@v4
        with:
          repository: <your-org>/phonebook
          path: phonebook

      - run: npx --prefix phonebook tsx phonebook/src/cli.ts generate -C .
      - run: npx --prefix phonebook tsx phonebook/src/cli.ts build phonebook-out

      - uses: actions/upload-artifact@v4
        with:
          name: phonebook-site
          path: phonebook-site
```

Pick whichever Xcode version `/Applications/Xcode.app` resolves to on the `macos-15` image that matches your project's Swift toolchain; `xcode-select -p` on the runner tells you what's installed if you need a specific version path (e.g. `/Applications/Xcode_16.app`).

## Both platforms in one workflow

Run the two jobs above in parallel (they're independent per the single-platform-per-repo model) and, if you want a combined view, download both `phonebook-site` artifacts in a follow-up job and publish them under separate paths on your static host. Merging them into a single cross-platform site is not supported yet — see `PLAN.md`.
