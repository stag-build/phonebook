import type { ScannedComponent, ScannedPreview, CoverageReport } from './types.js';

/**
 * Totals over a set of components and the previews that could not be matched
 * to one.
 *
 * Shared by both scanners and by `scopeReport`, which needs the same numbers
 * over a subset. The self-preview rule is Android's — a composable annotated
 * with `@Preview` is its own preview — and it costs nothing on iOS, where
 * `#Preview` is always a separate top-level block and the count is therefore
 * always zero.
 */
export function computeStats(
  components: ScannedComponent[],
  orphanPreviews: ScannedPreview[],
): CoverageReport['stats'] {
  const allPreviews = [...components.flatMap((c) => c.previews), ...orphanPreviews];
  return {
    components: components.length,
    withPreview: components.filter((c) => c.previews.length > 0).length,
    withDarkPreview: components.filter((c) => c.previews.some((p) => p.dark)).length,
    totalPreviews: components.reduce((sum, c) => sum + c.previews.length, 0) + orphanPreviews.length,
    hintCount: allPreviews.reduce((sum, p) => sum + (p.hints?.length ?? 0), 0),
    gapCount: components.reduce((sum, c) => sum + (c.gaps?.length ?? 0), 0),
    componentsWithGaps: components.filter((c) =>
      (c.gaps ?? []).some((g) => g.severity === 'warning'),
    ).length,
    selfPreviewed: components.filter((c) =>
      c.previews.some((p) => p.name === c.name && p.line === c.line),
    ).length,
  };
}
