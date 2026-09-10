import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { CoverageReport } from './types.js';
import { computeStats } from './stats.js';
import { rendersComponent } from './ios.js';

const run = promisify(execFile);

type Scope = NonNullable<CoverageReport['scope']>;
type PreviewOfWhatChanged = NonNullable<Scope['previewsOfWhatChanged']>[number];
type UncoveredUse = NonNullable<Scope['uncoveredUsesOfWhatChanged']>[number];

/**
 * Narrow a finished report to the components declared in `paths`.
 *
 * The scan itself is never narrowed, and that distinction is the whole design.
 * Which types are enums, what a project's preview helper supplies, which
 * locales ship — all of it is a fact about the project, not about one file, and
 * a scan that walked only the changed files would get every one of them wrong.
 * So the walk stays whole and the report is filtered afterwards, which costs a
 * few hundred milliseconds and buys an answer that is still correct.
 *
 * What it saves is the reader. A run that touched five components was handed
 * five hundred gaps, of which ten were its own; the rest are a backlog nobody
 * asked it about, and an agent cannot tell which is which.
 */
export function scopeReport(report: CoverageReport, paths: string[]): CoverageReport {
  if (paths.length === 0) return report;

  const wanted = paths.map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''));
  const matches = (file: string) => wanted.some((p) => file === p || file.startsWith(`${p}/`));

  const components = report.components.filter((c) => matches(c.file));
  const orphanPreviews = report.orphanPreviews.filter((p) => matches(p.file));

  const changed = new Set(components.map((c) => c.name));
  const previewsOfWhatChanged = previewsRendering(report, changed, matches);
  const uncoveredUsesOfWhatChanged = uncoveredUses(report, changed, matches);

  return {
    ...report,
    components,
    orphanPreviews,
    stats: computeStats(components, orphanPreviews),
    scope: {
      paths: wanted,
      componentsScanned: report.components.length,
      ...(previewsOfWhatChanged.length > 0 ? { previewsOfWhatChanged } : {}),
      ...(uncoveredUsesOfWhatChanged.length > 0 ? { uncoveredUsesOfWhatChanged } : {}),
    },
  };
}

/**
 * Previews outside the scope that render something inside it.
 *
 * A component is rarely previewed only where it is declared: edit a row and the
 * preview that shows it may live in the list's file, which the filter drops. The
 * agent can read these and decide — they are as likely to be fine as not.
 */
function previewsRendering(
  report: CoverageReport,
  changed: Set<string>,
  inScope: (file: string) => boolean,
): PreviewOfWhatChanged[] {
  const found: PreviewOfWhatChanged[] = [];
  const previews = [...report.components.flatMap((c) => c.previews), ...report.orphanPreviews];

  for (const preview of previews) {
    if (inScope(preview.file)) continue;
    const source = preview.annotationText ?? '';
    const renders = [...changed].filter((name) => rendersComponent(source, name));
    if (renders.length === 0) continue;
    found.push({ name: preview.displayName ?? preview.name, file: preview.file, line: preview.line, renders });
  }
  return found;
}

/**
 * Views outside the scope that render something inside it and have no preview
 * of their own.
 *
 * Having any preview is enough to be left alone: rendering the parent renders
 * its children, so the change does reach a screenshot. With no preview at all
 * it reaches nothing, and whether that context deserves one is a question about
 * the product — which is why this is something to ask the designer rather than
 * a gap to close.
 */
function uncoveredUses(
  report: CoverageReport,
  changed: Set<string>,
  inScope: (file: string) => boolean,
): UncoveredUse[] {
  const found: UncoveredUse[] = [];

  for (const component of report.components) {
    if (inScope(component.file) || component.previews.length > 0) continue;
    const uses = (component.uses ?? []).filter((name) => changed.has(name));
    if (uses.length === 0) continue;
    found.push({ component: component.name, file: component.file, line: component.line, uses });
  }
  return found;
}

/**
 * Files with uncommitted changes, relative to the project directory.
 *
 * `git status --porcelain` reports staged, unstaged and untracked in one pass,
 * which is what an agent's turn leaves behind: it edits and adds, it does not
 * commit. Paths come back relative to the repository root, so they are rebased
 * onto the project directory — the two differ whenever phonebook.config.json
 * sits in a subdirectory of a larger repository.
 *
 * A directory that is not a repository, or a git that is not installed, is not
 * an error here. It means the caller cannot scope by change and gets the whole
 * project, which is the behaviour they had before asking.
 */
export async function changedFiles(projectDir: string): Promise<string[]> {
  let root: string;
  let status: string;
  let base: string;
  try {
    root = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: projectDir })).stdout.trim();
    status = (await run('git', ['status', '--porcelain'], { cwd: projectDir })).stdout;
    // git answers in real paths. The caller's directory may be reached through
    // a symlink — every macOS temp directory is — and comparing the two
    // unresolved puts the whole repository outside itself.
    base = await realpath(projectDir);
  } catch {
    return [];
  }

  const files = new Set<string>();
  for (const line of status.split('\n')) {
    if (line.trim() === '') continue;
    // "XY path", or "XY old -> new" for a rename: the new name is the one that
    // still exists to be scanned.
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = path.trim().replace(/^"|"$/g, '');
    if (path === '') continue;

    const fromProject = relative(base, resolve(root, path));
    // Outside the project directory: another module of the same repository,
    // which this scan never walked and cannot report on.
    if (fromProject.startsWith('..')) continue;
    files.add(fromProject);
  }
  return [...files];
}
