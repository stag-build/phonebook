import { basename } from 'node:path';
import type { IncompleteRenderError } from '../engines/ios.js';
import type { ManifestEntry } from '../manifest.js';
import { spaceCamelCase } from '../naming.js';
import type { ScannedPreview } from '../scan/types.js';

/**
 * SnapshotPreviews names each preview test `<orientation>-<container>-<j>-<i>`,
 * where the container is the display name it derives from the preview's file
 * or type and `i` is a position in its own discovery order. The container can
 * carry hyphens, so the numbers are anchored at the end.
 */
const FAILED_PREVIEW_TEST = /Test case '[^']*?\.[A-Za-z]+-(.+)-\d+-\d+\(\)' failed/g;

/**
 * The container of every preview test the runner reported failed, one per test.
 *
 * A snapshot test asserts nothing, so a failure is the preview trapping: the
 * host app goes down with it and the runner relaunches it before carrying on.
 */
export function parseFailedPreviews(output: string): string[] {
  return [...output.matchAll(FAILED_PREVIEW_TEST)].map((m) => m[1]);
}

export interface FailedContainer {
  /** The container SnapshotPreviews reported, e.g. "Status Row Detail View". */
  container: string;
  failures: number;
  /** The previews in that container's file that did not come back as images.
   * Empty when the source holds no file matching the container. */
  unrendered: { file: string; line: number; name: string }[];
}

/**
 * Turns failed preview tests into previews a reader can open.
 *
 * The test name says which file and nothing more: its index follows discovery
 * order, not source order. What pins the preview down is subtraction — the
 * previews the file declares, minus the ones that rendered. When the run was cut
 * short that difference can also hold previews that were never reached, which
 * is why the list is "did not render" and the count is kept apart from it.
 */
export function explainFailedPreviews(
  failed: string[],
  rendered: ManifestEntry[],
  scanned: ScannedPreview[],
): FailedContainer[] {
  const failures = new Map<string, number>();
  for (const container of failed) failures.set(container, (failures.get(container) ?? 0) + 1);

  return [...failures].map(([container, count]) => {
    const declared = scanned.filter((p) => spaceCamelCase(basename(p.file, '.swift')) === container);
    const renderedLabels = new Set(
      rendered.flatMap((e) => {
        if (!e.sourceFile || !declared.some((p) => sameSource(p.file, e.sourceFile!))) return [];
        return [e.previewName.slice(e.sourceFile.length + 1)];
      }),
    );
    return {
      container,
      failures: count,
      unrendered: declared
        .filter((p) => !renderedLabels.has(sidecarLabel(p)))
        .map((p) => ({ file: p.file, line: p.line, name: p.displayName ?? container })),
    };
  });
}

/** What SnapshotPreviews writes as a preview's label: its display name, or
 * Xcode's placeholder for an unnamed one. */
function sidecarLabel(preview: ScannedPreview): string {
  return preview.displayName ?? `At line #${preview.line}`;
}

/** Whether a scanned path is the file a `Module/File.swift` file ID names. */
function sameSource(path: string, fileId: string): boolean {
  const slash = fileId.indexOf('/');
  const file = fileId.slice(slash + 1);
  if (path !== file && !path.endsWith(`/${file}`)) return false;
  return slash === -1 || path.split('/').includes(fileId.slice(0, slash));
}

/**
 * The answer to a render that crashed previews. Leads with where to look, because
 * each crash costs about a minute and a half on the next run too, and the reader
 * can only fix the ones it can find.
 */
export function summarizeIncompleteRender(error: IncompleteRenderError, explained: FailedContainer[]): string {
  const crashed = error.failedPreviews.length;
  const lines = [
    `Rendered ${error.manifest.entries.length} previews into ${error.outputDir}; ${crashed} crashed.`,
    '',
  ];
  if (crashed > 0) {
    lines.push(
      'A preview that crashes takes the app hosting the render down with it, and every relaunch costs about a',
      'minute and a half of the next run as well. Open each one: a trap at render is often an @Environment',
      'object the preview does not supply, which analyze_coverage reports as env-missing.',
    );
    for (const c of explained) {
      if (c.unrendered.length === 0) {
        lines.push(`  ${c.container}`);
      } else if (c.unrendered.length === c.failures) {
        lines.push(...c.unrendered.map((p) => `  ${p.file}:${p.line} ${p.name}`));
      } else {
        lines.push(`  ${c.container}: ${c.failures} crashed, and these ${c.unrendered.length} did not render`);
        lines.push(...c.unrendered.map((p) => `    ${p.file}:${p.line} ${p.name}`));
      }
    }
    lines.push('');
  }
  lines.push(...error.diagnosis);
  lines.push('Recorded:', ...error.manifest.entries.map((e) => `  ${e.component}/${e.state}`).sort());
  return lines.join('\n');
}
