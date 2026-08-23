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

function summarizeCoverage(report: CoverageReport): string {
  const { stats } = report;
  const withoutPreview = stats.components - stats.withPreview;
  const orphanCount = report.orphanPreviews.length;
  return [
    `Components: ${stats.components}`,
    `With preview: ${stats.withPreview}`,
    `Without preview: ${withoutPreview}`,
    `With dark preview: ${stats.withDarkPreview}`,
    orphanCount > 0
      ? `Orphan previews (could not be matched to a component in the same file): ${orphanCount}`
      : `Orphan previews (unmatched to a component): ${orphanCount}`,
  ].join('\n');
}

const HINT_LIST_CAP = 40;

function summarizeHints(report: CoverageReport): string {
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

Canvas size (iOS): preview dimensions come from traits: (e.g. .fixedLayout(width:height:)) or .previewDevice on the #Preview, not from a frame modifier in the view body.`;

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
        'Scan the codebase for UI components and the previews that cover them: which have previews, which states/themes are missing. Read-only.',
      inputSchema: {
        dir: z.string().default('.').describe('Project directory containing phonebook.config.json'),
      },
    },
    async ({ dir }) => {
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

      const summary = summarizeCoverage(report);
      const hints = summarizeHints(report);
      return textResult(`${summary}\n\n${hints}\n\n${JSON.stringify(report, null, 2)}`);
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
