/**
 * Signature matching over raw Gradle (or xcodebuild) output, turning known
 * failure patterns into human diagnosis lines. Zero lines means "no known
 * signature matched" — the raw output should still be shown to the user.
 */
export function diagnoseGradleFailure(output: string): string[] {
  const lines: string[] = [];

  const mentionsRoborazzi = /roborazzi/i.test(output);
  const incompatibleKotlin = /was compiled with an incompatible\s+version of Kotlin/.test(output);
  const metadataMatch = output.match(
    /binary version of its metadata is ([\d.]+),\s*expected version is ([\d.]+)/,
  );
  if (mentionsRoborazzi && (incompatibleKotlin || metadataMatch)) {
    const detail = metadataMatch ? ` (found metadata ${metadataMatch[1]}, expected ${metadataMatch[2]})` : '';
    lines.push(
      `Roborazzi is too new for this project's Kotlin.${detail} Run \`phonebook doctor\` for the exact ` +
        'compatible version, or see the kotlin-compat check.',
    );
  }

  const isJunit4Unresolved =
    /Unresolved reference '?junit4'?/.test(output) ||
    /Cannot access class 'androidx\.compose\.ui\.test\.junit4/.test(output);
  if (isJunit4Unresolved) {
    lines.push('Missing test dependency: add testImplementation("androidx.compose.ui:ui-test-junit4") to the module.');
  }

  const mentionsRoborazziGeneratedTest =
    /generated[\/\\]roborazzi/.test(output) || /RoborazziPreviewParameterizedTests/.test(output);
  if (!isJunit4Unresolved && /FileAnalysisException|Internal compiler error/.test(output) && mentionsRoborazziGeneratedTest) {
    const locationMatch = output.match(/While analysing (\S+?):(\d+):(\d+):/);
    const location = locationMatch ? ` (at ${locationMatch[1]}:${locationMatch[2]}:${locationMatch[3]})` : '';
    lines.push(
      'Kotlin compiler crashed analyzing the generated Roborazzi test. This is usually a missing test ' +
        'dependency — most often androidx.compose.ui:ui-test-junit4 — or a Roborazzi/ComposablePreviewScanner ' +
        `version mismatch. Run \`phonebook doctor\` for dependency checks.${location}`,
    );
  }

  const javaMatch = output.match(/Android Gradle plugin requires Java (\d+)/);
  if (javaMatch) {
    lines.push(
      `Android Gradle plugin requires Java ${javaMatch[1]}+; check JAVA_HOME (note: /usr/libexec/java_home may ` +
        'point at an old JDK even when newer ones are installed, e.g. via Homebrew).',
    );
  }

  if (/(?:0 tests|No tests found)/.test(output) && /recordRoborazzi/.test(output)) {
    lines.push(
      'No previews were recorded. If your @Preview functions are private, set includePrivatePreviews = true ' +
        'in the roborazzi { generateComposePreviewRobolectricTests { ... } } block.',
    );
  }

  return lines;
}

/**
 * Signature matching over raw xcodebuild output, turning known failure
 * patterns into human diagnosis lines. Zero lines means "no known signature
 * matched" — the raw output should still be shown to the user.
 */
export function diagnoseXcodebuildFailure(output: string): string[] {
  const lines: string[] = [];

  if (/Failed to install or launch the test runner|Mach error -308|\(ipc\/mig\) server died/.test(output)) {
    lines.push(
      'The iOS simulator runtime died while installing the test runner — usually transient, not a setup problem.',
    );
    lines.push(
      'Retry once; if it persists run: xcrun simctl shutdown all  (and if still failing: xcrun simctl erase ' +
        '"<device name>"). First boot of a newly installed runtime can also take minutes — let it finish in ' +
        'Simulator.app before retrying.',
    );
  }

  if (
    /Scheme (.+?) is not currently configured for the test action|does not contain any tests|There are no test bundles/.test(
      output,
    )
  ) {
    lines.push(
      "The scheme's Test action has no runnable tests. Ensure the test target with your SnapshotTest subclass " +
        'is included in the scheme\'s Test action, then run `phonebook doctor`.',
    );
  }

  if (/Unable to find a d(?:estination|evice) matching/.test(output)) {
    lines.push(
      'No simulator matches the configured name. List devices with: xcrun simctl list devices available — ' +
        'then update ios.simulator in phonebook.config.json.',
    );
  }

  return lines;
}
