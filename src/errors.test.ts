import { describe, expect, it } from 'vitest';
import { diagnoseGradleFailure, diagnoseXcodebuildFailure } from './errors.js';

describe('diagnoseGradleFailure', () => {
  it('flags a Roborazzi/Kotlin metadata incompatibility, with parsed versions', () => {
    const output = `
e: file:///project/app/src/test/java/dev/stag/sample/SnapshotsKt.kt: (12, 1): Class
'com.github.takahirom.roborazzi.RoborazziOptions' was compiled with an incompatible version of
Kotlin. The binary version of its metadata is 2.3.0, expected version is 2.0.0.

FAILURE: Build failed with an exception.
`;
    const lines = diagnoseGradleFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Roborazzi is too new for this project's Kotlin.");
    expect(lines[0]).toContain('found metadata 2.3.0, expected 2.0.0');
    expect(lines[0]).toContain('phonebook doctor');
  });

  it('flags the same incompatibility without exact metadata numbers', () => {
    const output = `
e: Class 'com.github.takahirom.roborazzi.RoborazziOptions' was compiled with an incompatible
version of Kotlin and cannot be read.
`;
    const lines = diagnoseGradleFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Roborazzi is too new for this project's Kotlin.");
    expect(lines[0]).not.toContain('found metadata');
  });

  it('does not flag an unrelated "incompatible version of Kotlin" error', () => {
    const output = "Class 'com.example.Foo' was compiled with an incompatible version of Kotlin.";
    expect(diagnoseGradleFailure(output)).toEqual([]);
  });

  it('flags a missing ui-test-junit4 dependency (unresolved reference)', () => {
    const output = `
e: file:///project/app/src/test/java/dev/stag/sample/SnapshotsKt.kt: (3, 8): Unresolved reference 'junit4'
`;
    expect(diagnoseGradleFailure(output)).toEqual([
      'Missing test dependency: add testImplementation("androidx.compose.ui:ui-test-junit4") to the module.',
    ]);
  });

  it('flags a missing ui-test-junit4 dependency (cannot access class)', () => {
    const output = `
e: Cannot access class 'androidx.compose.ui.test.junit4.AndroidComposeTestRule'. Check your module classpath
for missing or conflicting dependencies.
`;
    expect(diagnoseGradleFailure(output)).toEqual([
      'Missing test dependency: add testImplementation("androidx.compose.ui:ui-test-junit4") to the module.',
    ]);
  });

  it('flags a Java version mismatch with the required version', () => {
    const output = `
* What went wrong:
Android Gradle plugin requires Java 17 to run. You are currently using Java 11.
`;
    const lines = diagnoseGradleFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Android Gradle plugin requires Java 17+');
    expect(lines[0]).toContain('JAVA_HOME');
  });

  it('flags 0 recorded previews on a recordRoborazzi run', () => {
    const output = `
> Task :app:recordRoborazziDebug

BUILD SUCCESSFUL
0 tests completed, 0 failed
`;
    const lines = diagnoseGradleFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('includePrivatePreviews');
  });

  it('does not flag "0 tests" without a recordRoborazzi task present', () => {
    const output = '0 tests completed, 0 failed';
    expect(diagnoseGradleFailure(output)).toEqual([]);
  });

  it('can flag more than one signature at once', () => {
    const output = `
Unresolved reference 'junit4'
Android Gradle plugin requires Java 17 to run.
`;
    const lines = diagnoseGradleFailure(output);
    expect(lines).toHaveLength(2);
  });

  it('returns an empty array for unrecognized output', () => {
    expect(diagnoseGradleFailure('some totally unrelated failure')).toEqual([]);
  });

  it('flags a K2 compiler crash analyzing the generated Roborazzi test, with file:line:col', () => {
    const output = `
e: org.jetbrains.kotlin.util.FileAnalysisException: While analysing /Users/dev/app/build/generated/roborazzi/preview-screenshot/debug/com/github/takahirom/roborazzi/RoborazziPreviewParameterizedTests.kt:30:49: java.lang.IllegalStateException: Shouldn't be here
	at org.jetbrains.kotlin.foo.bar(Foo.kt:1)
	at org.jetbrains.kotlin.foo.baz(Foo.kt:2)
Caused by: java.lang.IllegalStateException: Shouldn't be here
	at org.jetbrains.kotlin.foo.qux(Foo.kt:3)

> Internal compiler error. See log for more details
`;
    const lines = diagnoseGradleFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Kotlin compiler crashed analyzing the generated Roborazzi test');
    expect(lines[0]).toContain('androidx.compose.ui:ui-test-junit4');
    expect(lines[0]).toContain('phonebook doctor');
    expect(lines[0]).toContain(
      '(at /Users/dev/app/build/generated/roborazzi/preview-screenshot/debug/com/github/takahirom/roborazzi/RoborazziPreviewParameterizedTests.kt:30:49)',
    );
  });

  it('does not flag the compiler-crash signature without a generated Roborazzi path', () => {
    const output = `
e: org.jetbrains.kotlin.util.FileAnalysisException: While analysing /Users/dev/app/src/main/java/dev/stag/sample/Foo.kt:1:1: something
> Internal compiler error. See log for more details
`;
    expect(diagnoseGradleFailure(output)).toEqual([]);
  });

  it('prefers the specific junit4-unresolved-reference signature over the compiler-crash signature when both match', () => {
    const output = `
e: file:///project/app/build/generated/roborazzi/preview-screenshot/debug/RoborazziPreviewParameterizedTests.kt: (30, 49): Unresolved reference 'junit4'
e: org.jetbrains.kotlin.util.FileAnalysisException: While analysing /project/app/build/generated/roborazzi/preview-screenshot/debug/RoborazziPreviewParameterizedTests.kt:30:49: java.lang.IllegalStateException: Shouldn't be here
> Internal compiler error. See log for more details
`;
    const lines = diagnoseGradleFailure(output);
    expect(lines).toEqual([
      'Missing test dependency: add testImplementation("androidx.compose.ui:ui-test-junit4") to the module.',
    ]);
  });
});

describe('diagnoseXcodebuildFailure', () => {
  it('diagnoses a missing module dependency import', () => {
    const out = diagnoseXcodebuildFailure(
      "Testing failed:\n\tUnable to find module dependency: 'SnapshotPreviews'\nimport SnapshotPreviews\n       ^\n\tTesting cancelled because the build failed.\n** TEST FAILED **",
    );
    expect(out.join('\n')).toContain("imports 'SnapshotPreviews'");
    expect(out.join('\n')).toContain('import SnapshottingTests');
  });

  it('flags a dead simulator-runtime Mach error installing the test runner', () => {
    const output = `
Testing failed:
    The operation couldn't be completed. (Mach error -308 - (ipc/mig) server died)
    CountriesSwiftUI encountered an error (Failed to install or launch the test runner. (Underlying Error: The operation couldn't be completed. (Mach error -308 - (ipc/mig) server died)))
** TEST FAILED **
error: xcodebuild failed (exit 65) running: xcodebuild test -project CountriesSwiftUI.xcodeproj -scheme CountriesSwiftUI -destination platform=iOS Simulator,name=iPhone 17 Pro
`;
    const lines = diagnoseXcodebuildFailure(output);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('simulator runtime died');
    expect(lines[0]).toContain('usually transient');
    expect(lines[1]).toContain('xcrun simctl shutdown all');
    expect(lines[1]).toContain('xcrun simctl erase');
    expect(lines[1]).toContain('Simulator.app');
  });

  it('flags a scheme with no runnable tests', () => {
    const output = 'Scheme MyApp is not currently configured for the test action.';
    const lines = diagnoseXcodebuildFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("scheme's Test action has no runnable tests");
    expect(lines[0]).toContain('phonebook doctor');
  });

  it('flags a scheme with no runnable tests ("does not contain any tests")', () => {
    const output = 'Scheme MyApp does not contain any tests.';
    const lines = diagnoseXcodebuildFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("scheme's Test action has no runnable tests");
  });

  it('flags a scheme with no runnable tests ("There are no test bundles")', () => {
    const output = 'There are no test bundles for the "MyApp" scheme.';
    const lines = diagnoseXcodebuildFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("scheme's Test action has no runnable tests");
  });

  it('flags an unmatched simulator destination', () => {
    const output = 'xcodebuild: error: Unable to find a destination matching the provided destination specifier';
    const lines = diagnoseXcodebuildFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('No simulator matches the configured name');
    expect(lines[0]).toContain('xcrun simctl list devices available');
    expect(lines[0]).toContain('ios.simulator');
  });

  it('flags an unmatched device destination ("matching device")', () => {
    const output = 'xcodebuild: error: Unable to find a device matching the provided destination specifier';
    const lines = diagnoseXcodebuildFailure(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('No simulator matches the configured name');
  });

  it('returns an empty array for unrecognized output', () => {
    expect(diagnoseXcodebuildFailure('BUILD SUCCEEDED')).toEqual([]);
  });
});
