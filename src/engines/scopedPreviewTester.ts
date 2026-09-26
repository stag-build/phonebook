import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Renders only the previews of the files a `--files` run asks for.
 *
 * Gradle's `--tests` cannot do this: every preview is a parameter of the one
 * generated `RoborazziPreviewParameterizedTests` class, and parameter names
 * only exist once the test runs. So the filtering happens inside the run
 * instead, through the extension point Roborazzi documents for it — a custom
 * `ComposePreviewTester` whose `testParameters()` decides which previews become
 * tests (docs/topics/preview_support.md, "Custom ComposePreviewTester").
 *
 * Nothing is written to the user's sources or build files. Phonebook drops the
 * tester and a Gradle init script into the root `build/phonebook/` directory and
 * passes the script with `--init-script` on scoped runs only. The requested
 * classes travel as a `-Proborazzi.*` property, which Roborazzi's plugin copies
 * into the test JVM's system properties (RoborazziPlugin, `gradlePropertiesPrefixedBy("roborazzi")`).
 *
 * The tester also narrows the scan to the requested classes' packages, so a
 * 500-preview module pays neither to scan nor to render the other 499.
 */

/** The Gradle property carrying the comma-separated declaring classes to render. */
export const PREVIEW_CLASSES_PROPERTY = 'roborazzi.phonebook.previewClasses';

export const SCOPED_TESTER_CLASS = 'build.stag.phonebook.PhonebookPreviewTester';

const TESTER_SOURCE = `// Written by Phonebook (@stag-build/phonebook) at render time. Not part of your
// sources: it lives under build/ and is only compiled when Phonebook passes its
// init script. Safe to delete.
@file:OptIn(ExperimentalRoborazziApi::class, InternalRoborazziApi::class)

package build.stag.phonebook

import com.github.takahirom.roborazzi.AndroidComposePreviewTester
import com.github.takahirom.roborazzi.ComposePreviewTester
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.InternalRoborazziApi

@Suppress("UNCHECKED_CAST")
class PhonebookPreviewTester private constructor(
  private val delegate: ComposePreviewTester<ComposePreviewTester.TestParameter<*>>,
) : ComposePreviewTester<ComposePreviewTester.TestParameter<*>> by delegate {

  constructor() : this(
    AndroidComposePreviewTester() as ComposePreviewTester<ComposePreviewTester.TestParameter<*>>,
  )

  override fun testParameters(): List<ComposePreviewTester.TestParameter<*>> {
    val requested = System.getProperty("${PREVIEW_CLASSES_PROPERTY}").orEmpty()
      .split(',').map { it.trim() }.filter { it.isNotEmpty() }
    if (requested.isEmpty()) return delegate.testParameters()

    // Scan only the requested classes' packages, and never outside the
    // packages the project configured.
    val plugin = ComposePreviewTester.defaultOptionsFromPlugin
    val configured = plugin.scanOptions.packages
    val packages = requested
      .map { it.substringBeforeLast('.', "") }
      .filter { pkg -> configured.any { pkg == it || pkg.startsWith("$it.") } }
      .distinct()
    if (packages.isEmpty()) return emptyList()

    ComposePreviewTester.defaultOptionsFromPlugin =
      plugin.copy(scanOptions = plugin.scanOptions.copy(packages = packages))
    val scanned = try {
      delegate.testParameters()
    } finally {
      ComposePreviewTester.defaultOptionsFromPlugin = plugin
    }
    return scanned.filter { parameter ->
      val declaring = (parameter as? ComposePreviewTester.TestParameter.JUnit4TestParameter<*>)
        ?.preview?.declaringClass ?: return@filter true
      // Nested classes are reported as Outer.Inner (or Outer$Inner).
      requested.any { declaring == it || declaring.startsWith("$it.") || declaring.startsWith("$it$") }
    }
  }
}
`;

function initScript(testerDir: string, modules: string[]): string {
  return `// Written by Phonebook (@stag-build/phonebook) for one scoped render.
// Swaps in a preview tester that renders only the requested previews.
def testerSources = new File(${JSON.stringify(testerDir)})
def testerClass = ${JSON.stringify(SCOPED_TESTER_CLASS)}
def scopedModules = ${JSON.stringify(modules)} as Set

allprojects { project ->
  if (!scopedModules.contains(project.path)) return
  project.plugins.withId('io.github.takahirom.roborazzi') {
    def previews = project.extensions.getByName('roborazzi').generateComposePreviewRobolectricTests
    // Roborazzi versions without this flag reject any custom tester next to
    // includePrivatePreviews; leave those builds rendering the whole module.
    if (!previews.hasProperty('useScanOptionParametersInTester')) return
    // Conventions, not values: a tester the project configures itself wins.
    previews.testerQualifiedClassName.convention(testerClass)
    previews.useScanOptionParametersInTester.convention(
      previews.testerQualifiedClassName.map { it == testerClass })
    ['com.android.application', 'com.android.library'].each { id ->
      project.plugins.withId(id) {
        def test = project.android.sourceSets.getByName('test')
        // AGP 9's built-in Kotlin compiles only the kotlin directories; the
        // Kotlin Gradle plugin on older AGP reads those too.
        def dirs = test.hasProperty('kotlin') ? test.kotlin : test.java
        if (dirs.hasProperty('directories')) dirs.directories.add(testerSources.path)
        else dirs.srcDir(testerSources)
      }
    }
    // A scoped render that matches no preview runs zero tests; Phonebook
    // notices the empty output and falls back to the whole module.
    project.tasks.withType(Test).configureEach { filter.failOnNoMatchingTests = false }
  }
}
`;
}

/**
 * Writes the tester and the init script for `modules`, returning the init
 * script's path to pass with `--init-script`.
 */
export async function writeScopedPreviewTester(projectDir: string, modules: string[]): Promise<string> {
  const root = join(projectDir, 'build', 'phonebook');
  const testerDir = join(root, 'scoped-preview-tester');
  const packageDir = join(testerDir, ...SCOPED_TESTER_CLASS.split('.').slice(0, -1));
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'PhonebookPreviewTester.kt'), TESTER_SOURCE);
  const scriptPath = join(root, 'scoped-preview-tester.init.gradle');
  await writeFile(scriptPath, initScript(testerDir, modules));
  return scriptPath;
}
