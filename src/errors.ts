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

  if (
    /Unresolved reference '?junit4'?/.test(output) ||
    /Cannot access class 'androidx\.compose\.ui\.test\.junit4/.test(output)
  ) {
    lines.push('Missing test dependency: add testImplementation("androidx.compose.ui:ui-test-junit4") to the module.');
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
