/**
 * Coverage scanning: heuristic, regex-based discovery of UI components and the
 * previews that cover them. Used by the MCP `analyze_coverage` tool so an agent
 * can find components with missing previews/states and add them as code.
 */

import type { PreviewHint } from './hints.js';

export type { PreviewHint };

export interface ScannedPreview {
  /** Preview function name (Android) or #Preview display name / "unnamed" (iOS) */
  name: string;
  /** Display name from @Preview(name=...) / #Preview("...") when present */
  displayName?: string;
  file: string;
  line: number;
  /** True when the preview declares a dark configuration (uiMode NIGHT / .dark) */
  dark: boolean;
  /** Raw annotation/macro text as written in source (Android: @Preview(...) annotations
   * joined; iOS: the #Preview(...) line plus the following lines of its body, capped). */
  annotationText?: string;
  /** Configuration hints: cases where the preview's name implies a trait its
   * annotation doesn't declare. See src/scan/hints.ts. */
  hints?: PreviewHint[];
}

export interface ScannedComponent {
  /** Composable function name (Android) or View struct name (iOS) */
  name: string;
  file: string;
  line: number;
  /** Previews matched to this component (same file + name-prefix heuristic) */
  previews: ScannedPreview[];
}

export interface CoverageReport {
  platform: 'android' | 'ios';
  components: ScannedComponent[];
  /** Previews that could not be matched to any discovered component */
  orphanPreviews: ScannedPreview[];
  /** Totals for a quick summary */
  stats: {
    components: number;
    withPreview: number;
    withDarkPreview: number;
    totalPreviews: number;
    hintCount: number;
  };
}
