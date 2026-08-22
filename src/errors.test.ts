import { describe, expect, it } from 'vitest';
import { diagnoseGradleFailure } from './errors.js';

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
});
