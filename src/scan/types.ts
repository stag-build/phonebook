/**
 * Coverage scanning: heuristic, regex-based discovery of UI components and the
 * previews that cover them. Used by the MCP `analyze_coverage` tool so an agent
 * can find components with missing previews/states and add them as code.
 */

export interface ScannedPreview {
  /** Preview function name (Android) or #Preview display name / "unnamed" (iOS) */
  name: string;
  /** Display name from @Preview(name=...) / #Preview("...") when present */
  displayName?: string;
  file: string;
  line: number;
  /** True when the preview declares a dark configuration (uiMode NIGHT / .dark) */
  dark: boolean;
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
  };
}
