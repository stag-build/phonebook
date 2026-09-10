import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { collectDoctorChecks } from '../commands/doctor.js';
import { generateAndroid } from '../engines/android.js';
import { generateIos } from '../engines/ios.js';
import { buildSite } from '../site/build.js';
import type { CoverageReport } from '../scan/types.js';
import { changedFiles, scopeReport } from '../scan/scope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(resolve(__dirname, '../../package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function summarizeCoverage(report: CoverageReport): string {
  const { stats } = report;
  const withoutPreview = stats.components - stats.withPreview;
  const orphanCount = report.orphanPreviews.length;
  return [
    // First, so a reader never mistakes a slice for the project. Every number
    // under it counts the components in scope and no others.
    ...(report.scope
      ? [
          `Scope: ${stats.components} of ${report.scope.componentsScanned} components, filtered to ${report.scope.paths.join(', ')}`,
        ]
      : []),
    `Components: ${stats.components}`,
    `With preview: ${stats.withPreview}`,
    `Without preview: ${withoutPreview}`,
    `With dark preview: ${stats.withDarkPreview}`,
    `Components with missing previews: ${stats.componentsWithGaps}`,
    report.extraLocales.length > 0
      ? `Localizations beyond the development language: ${report.extraLocales.join(', ')}`
      : 'Localizations beyond the development language: none',
    orphanCount > 0
      ? `Orphan previews (could not be matched to a component in the same file): ${orphanCount}`
      : `Orphan previews (unmatched to a component): ${orphanCount}`,
  ].join('\n');
}

const REACH_LIST_CAP = 25;

/**
 * What a scoped report would otherwise hide: previews and views outside the
 * scope that show a component inside it.
 *
 * Kept apart from the gaps above, and worded differently, because they are not
 * the same kind of claim. A gap is a defect with a fix. The first list here is
 * a fact — these previews show what you changed, and only their source says
 * whether that matters. The second is a question: nothing renders that context
 * at all, and whether it deserves a preview is a judgment about the product
 * rather than about the code.
 */
export function summarizeReach(report: CoverageReport): string {
  const shown = report.scope?.previewsOfWhatChanged ?? [];
  const ask = report.scope?.uncoveredUsesOfWhatChanged ?? [];
  if (shown.length === 0 && ask.length === 0) return '';

  const lines: string[] = [];

  if (shown.length > 0) {
    lines.push(
      `Previews elsewhere that render what you changed (${shown.length})`,
      'Outside the files you named, so they are not in the report above. Read each one and',
      'decide whether it still shows the right thing.',
    );
    for (const p of shown.slice(0, REACH_LIST_CAP)) {
      lines.push(`  ${p.file}:${p.line} "${p.name}" renders ${p.renders.join(', ')}`);
    }
    if (shown.length > REACH_LIST_CAP) lines.push(`  ... and ${shown.length - REACH_LIST_CAP} more (see JSON)`);
  }

  if (ask.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `Views that use what you changed and have no preview (${ask.length})`,
      'Nothing renders these, so your change never reaches a screenshot in that context.',
      'Whether it should is the designer\'s call, not yours: end your turn by asking, with',
      'these as the options.',
    );
    for (const u of ask.slice(0, REACH_LIST_CAP)) {
      lines.push(`  ${u.file}:${u.line} ${u.component} uses ${u.uses.join(', ')}`);
    }
    if (ask.length > REACH_LIST_CAP) lines.push(`  ... and ${ask.length - REACH_LIST_CAP} more (see JSON)`);
  }

  return lines.join('\n');
}

const HINT_LIST_CAP = 40;
const GAP_COMPONENT_CAP = 60;

/**
 * What each component is missing, which is the half `summarizeHints` cannot
 * see: a hint needs a preview to exist before it can say anything about it.
 *
 * Grouped by component rather than listed flat. A flat list sorted by severity
 * put every "has no preview" first, and on a repository with a hundred of them
 * the cap fell before a single state gap was reached — the specific, useful
 * half of the report never reached the reader. Components carrying the most
 * missing states come first for the same reason.
 *
 * It reports; it never edits.
 */
export function summarizeGaps(report: CoverageReport): string {
  const withGaps = report.components.filter((c) => (c.gaps ?? []).length > 0);
  const total = withGaps.reduce((sum, c) => sum + (c.gaps ?? []).length, 0);

  if (total === 0) {
    return 'Missing previews (0)';
  }

  const warnings = (component: (typeof withGaps)[number]) =>
    (component.gaps ?? []).filter((g) => g.severity === 'warning').length;

  const ordered = [...withGaps].sort(
    (a, b) =>
      warnings(b) - warnings(a) ||
      (b.gaps ?? []).length - (a.gaps ?? []).length ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  const shown = ordered.slice(0, GAP_COMPONENT_CAP);
  const blocks = shown.map((component) => {
    const gaps = component.gaps ?? [];
    const header = `${component.file}:${component.line} ${component.name} (${gaps.length} missing)`;
    const lines = gaps.map((g) => `  [${g.rule}] ${g.message} -> ${g.suggestion}`);
    return [header, ...lines].join('\n');
  });

  const remaining = ordered.length - shown.length;
  if (remaining > 0) {
    blocks.push(`... and ${remaining} more component${remaining === 1 ? '' : 's'} (see JSON)`);
  }

  return [
    `Missing previews (${total} across ${withGaps.length} component${withGaps.length === 1 ? '' : 's'})`,
    '',
    ...blocks,
    '',
    'Read each component before writing previews: the states above are inferred from its parameters, and only its source says which of them are worth a preview. Call get_preview_guidance for the naming convention and a template.',
  ].join('\n');
}

export function summarizeHints(report: CoverageReport): string {
  const allPreviews = [
    ...report.components.flatMap((c) => c.previews),
    ...report.orphanPreviews,
  ];
  const entries = allPreviews.flatMap((p) =>
    (p.hints ?? []).map((h) => ({
      file: p.file,
      line: p.line,
      functionName: p.name,
      hint: h,
    })),
  );

  if (entries.length === 0) {
    return 'Configuration hints (0)';
  }

  const shown = entries.slice(0, HINT_LIST_CAP);
  const lines = shown.map(
    (e) =>
      `${e.file}:${e.line} ${e.functionName} [${e.hint.rule}] ${e.hint.message} -> ${e.hint.suggestion}`,
  );
  const remaining = entries.length - shown.length;
  if (remaining > 0) {
    lines.push(`... and ${remaining} more (see JSON)`);
  }

  return [`Configuration hints (${entries.length})`, ...lines].join('\n');
}

const NAMING_GUIDANCE = `Naming convention (see docs/naming-convention.md):
1. A display name containing "/" splits into component/state (e.g. "Button/Enabled").
2. A display name without "/" becomes the state; the component comes from the function name.
3. No display name: the function name (minus a leading/trailing "Preview") is the component, and the state is "Default".
Component names are camel-case-spaced ("UserCard" -> "User Card", acronym runs kept together: "URLBar" -> "URL Bar").
Dark mode: Android infers "Dark" state from uiMode = UI_MODE_NIGHT_YES and strips a trailing Dark/Night suffix from the function name; iOS has no such inference, so give the preview an explicit "Component/Dark" name and add .preferredColorScheme(.dark).

Configuration hints: analyze_coverage also flags previews whose name implies a configuration (landscape, dark, tablet, RTL, large font, ...) that the annotation doesn't actually declare — e.g. a function named "...Landscape" with a plain @Preview() renders portrait. Fix by adding the declared trait the hint suggests (device/orientation spec, uiMode, locale, fontScale, traits: for iOS, etc.), or renaming if the config was never intended.

Canvas size (Android): preview dimensions come only from the @Preview annotation — widthDp/heightDp or device = "spec:width=..dp,height=..dp,...". Wrapping the composable in Modifier.size(...)/width(...)/height(...) in the preview body does NOT resize the canvas: the content is sized inside a canvas that stays the default phone size, so wide or large content is clipped, not fit. Correct: @Preview(widthDp = 891, heightDp = 411) fun ... { LoginContentLandscape() } — no size Modifier needed.

Canvas size (iOS): preview dimensions come from traits: (e.g. .fixedLayout(width:height:)) or .previewDevice on the #Preview, not from a frame modifier in the view body.

Environment (iOS): a preview must supply every object the view tree reads with @Environment(SomeType.self). SwiftUI has no default for one, so an @Observable that is missing traps the moment the body reads it — the preview does not render wrong, it crashes. Read the view's own @Environment declarations, and its subviews', and pass each one: .environment(SomeType.shared), .environment(SomeType()), or the project's own preview helper if it has one (a \`func ...() -> some View\` extension that chains .environment calls). analyze_coverage reports the direct ones it can see as \`env-missing\`; a subview's needs are yours to find. The keypath form, @Environment(\\.openURL), always has a value and never needs supplying.

Snapshot test class (iOS): the SnapshotTest subclass that records previews must live in the app-hosted unit-test target's own folder (the target linking SnapshottingTests, hosted via TEST_HOST/BUNDLE_LOADER) — run \`phonebook doctor\` to see which target and where. In a project using Xcode's filesystem-synchronized groups, just creating the file in that folder is enough (Xcode picks it up automatically); \`phonebook init --write-snapshot-class\` can do this for you when that condition holds.`;

function androidTemplate(component: string, states: string[]): string {
  const name = component || 'Component';
  const stateList = states.length > 0 ? states : ['Default'];
  const blocks = stateList
    .filter((s) => s.toLowerCase() !== 'dark')
    .map(
      (state) => `@Preview(name = "${name}/${state}")
@Composable
private fun ${name}${state}Preview() {
    ${name}(/* TODO: pass ${state} state props */)
}`,
    )
    .join('\n\n');

  const dark = `@Preview(name = "${name}/Dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun ${name}DarkPreview() {
    ${name}(/* TODO: pass default props */)
}`;

  return `${blocks}\n\n${dark}`;
}

function iosTemplate(component: string, states: string[]): string {
  const name = component || 'Component';
  const stateList = states.length > 0 ? states : ['Default'];
  const blocks = stateList
    .filter((s) => s.toLowerCase() !== 'dark')
    .map(
      (state) => `#Preview("${name}/${state}", traits: .sizeThatFitsLayout) {
    ${name}(/* TODO: pass ${state} state props */)
}`,
    )
    .join('\n\n');

  const dark = `#Preview("${name}/Dark", traits: .sizeThatFitsLayout) {
    ${name}(/* TODO: pass default props */)
        .preferredColorScheme(.dark)
}`;

  return `${blocks}\n\n${dark}`;
}

export async function runMcpServer(): Promise<void> {
  const version = await readPackageVersion();
  const server = new McpServer({ name: 'phonebook', version });

  server.registerTool(
    'analyze_coverage',
    {
      description:
        'Scan the codebase for UI components and the previews that cover them, and report what each component is missing: states implied by its parameters, environment objects no preview supplies, dark theme, large text, and localization when the project ships one. Read-only — it reports the gaps, it does not write previews. After editing, pass changed: true (or paths) to hear only about what you touched; the whole project is always scanned either way, so the answers stay correct.',
      inputSchema: {
        dir: z.string().default('.').describe('Project directory containing phonebook.config.json'),
        paths: z
          .array(z.string())
          .optional()
          .describe('Report only components declared in these files or directories, relative to the project directory. The whole project is still scanned.'),
        changed: z
          .boolean()
          .optional()
          .describe('Report only components in files with uncommitted git changes — what you just edited. Ignored outside a git repository. Combined with paths when both are given.'),
      },
    },
    async ({ dir, paths, changed }) => {
      let projectDir: string;
      let platform: 'android' | 'ios';
      let modules: string[];
      try {
        const loaded = await loadConfig(dir);
        projectDir = loaded.projectDir;
        platform = loaded.config.platform;
        modules = loaded.config.android?.modules ?? [':app'];
      } catch (err) {
        return errorResult(
          `${(err as Error).message}\nRun \`phonebook init\` first to scaffold phonebook.config.json.`,
        );
      }

      let report: CoverageReport;
      try {
        if (platform === 'android') {
          const { scanAndroid } = await import('../scan/android.js');
          report = await scanAndroid(projectDir, modules);
        } else {
          const { scanIos } = await import('../scan/ios.js');
          report = await scanIos(projectDir);
        }
      } catch (err) {
        return errorResult(`Failed to analyze coverage: ${(err as Error).message}`);
      }

      // Scoping narrows the report, never the scan: which types are enums,
      // what the project's preview helper supplies and which locales ship are
      // facts about the project, and a scan of the changed files alone would
      // get all three wrong.
      const scope = [...(paths ?? []), ...(changed ? await changedFiles(projectDir) : [])];
      if (scope.length > 0) {
        const scoped = scopeReport(report, scope);
        if (scoped.components.length === 0) {
          return textResult(
            `No components found in ${scope.join(', ')}. The scan found ${report.components.length} in the project; either nothing there declares a component, or the paths are not relative to ${projectDir}.`,
          );
        }
        report = scoped;
      }

      const summary = summarizeCoverage(report);
      const gaps = summarizeGaps(report);
      const hints = summarizeHints(report);
      const reach = summarizeReach(report);
      return textResult(
        [summary, gaps, hints, reach, JSON.stringify(report, null, 2)].filter((s) => s !== '').join('\n\n'),
      );
    },
  );

  server.registerTool(
    'check_setup',
    {
      description:
        "Check that the project is correctly set up for `phonebook generate` (same checks as `phonebook doctor`): libraries wired, test target present, JDK/Xcode/simulator available.",
      inputSchema: {
        dir: z.string().default('.').describe('Project directory containing phonebook.config.json'),
      },
    },
    async ({ dir }) => {
      const { lines, ok } = await collectDoctorChecks(dir);
      const text = [...lines, ok ? 'READY' : 'NOT READY'].join('\n');
      return textResult(text);
    },
  );

  server.registerTool(
    'get_preview_guidance',
    {
      description:
        'Return the preview naming convention plus a ready-to-paste preview code template for a component, so any agent writes consistent previews.',
      inputSchema: {
        platform: z.enum(['android', 'ios']).describe('Target platform'),
        component: z.string().optional().describe('Component name, e.g. "Button"'),
        states: z.array(z.string()).optional().describe('State names, e.g. ["Enabled", "Disabled"]'),
      },
    },
    async ({ platform, component, states }) => {
      const name = component ?? 'Component';
      const stateList = states && states.length > 0 ? states : ['Default'];
      const template = platform === 'android' ? androidTemplate(name, stateList) : iosTemplate(name, stateList);
      const text = `${NAMING_GUIDANCE}\n\nTemplate for ${name} (${platform}):\n\n${template}`;
      return textResult(text);
    },
  );

  server.registerTool(
    'run_generate',
    {
      description:
        'Run the platform engine to render all previews and produce a bundle (manifest + images), same as `phonebook generate`.',
      inputSchema: {
        dir: z.string().default('.').describe('Project directory containing phonebook.config.json'),
      },
    },
    async ({ dir }) => {
      let projectDir: string;
      try {
        const loaded = await loadConfig(dir);
        projectDir = loaded.projectDir;
        const outputDir = resolve(projectDir, loaded.config.output ?? 'phonebook-out');
        const manifest =
          loaded.config.platform === 'android'
            ? await generateAndroid(loaded.config, projectDir, outputDir, { quiet: true })
            : await generateIos(loaded.config, projectDir, outputDir, { quiet: true });

        const componentStates = manifest.entries.map((e) => `${e.component}/${e.state}`).sort();
        const text = [
          `Recorded ${manifest.entries.length} previews -> ${outputDir}`,
          '',
          ...componentStates,
        ].join('\n');
        return textResult(text);
      } catch (err) {
        return errorResult(
          `${(err as Error).message}\nRun the check_setup tool (or \`phonebook doctor\`) to diagnose the project setup.`,
        );
      }
    },
  );

  server.registerTool(
    'run_build',
    {
      description: 'Build the static gallery site from a bundle, same as `phonebook build <bundle>`.',
      inputSchema: {
        bundle: z.string().describe('Bundle directory produced by run_generate / `phonebook generate`'),
        output: z
          .string()
          .optional()
          .describe('Site output directory (default: the bundle directory itself, reusing its images)'),
      },
    },
    async ({ bundle, output }) => {
      try {
        // Default to building in place so the site reuses the bundle's images
        // instead of duplicating every screenshot into a sibling directory.
        const outDir = output ? resolve(output) : resolve(bundle);
        const count = await buildSite(resolve(bundle), outDir);
        return textResult(`Built gallery with ${count} screenshots -> ${outDir}/index.html`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
