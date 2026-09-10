/**
 * Coverage scanning: heuristic, regex-based discovery of UI components and the
 * previews that cover them. Used by the MCP `analyze_coverage` tool so an agent
 * can find components with missing previews/states and add them as code.
 */

import type { PreviewHint } from './hints.js';
import type { ComponentProperty, CoverageGap } from './gaps.js';

export type { PreviewHint, ComponentProperty, CoverageGap };

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
  /** Text of the preview function's body (from the opening brace, capped to ~20 lines).
   * Lets hints inspect what the composable actually does, e.g. a fixed-size Modifier
   * that can't substitute for an annotation-level canvas size. */
  bodyText?: string;
  /** Configuration hints: cases where the preview's name implies a trait its
   * annotation doesn't declare. See src/scan/hints.ts. */
  hints?: PreviewHint[];
}

/**
 * A component rendered only behind a condition, and enough about the render to
 * go and look at it.
 *
 * The condition text is the payload. "Renders it inside an if" names a shape;
 * `if isFocused, !isCompact` names the state a preview would have to set, which
 * is the difference between a question and a chore.
 */
export interface ConditionalUse {
  /** The component rendered behind the condition. */
  name: string;
  /** The condition as written, whitespace collapsed. */
  guard: string;
  /** Line of the guarded render, in the file that declares the parent. */
  line: number;
}

export interface ScannedComponent {
  /** Composable function name (Android) or View struct name (iOS) */
  name: string;
  file: string;
  line: number;
  /** Previews matched to this component (same file + name-prefix heuristic) */
  previews: ScannedPreview[];
  /** Stored properties (iOS) or composable parameters (Android). What the
   * component's states are derived from. */
  properties?: ComponentProperty[];
  /** Types read via `@Environment(X.self)` (iOS). An unsatisfied one traps at
   * render, so a preview that omits it is broken rather than incomplete. */
  environmentTypes?: string[];
  /** Other discovered components this one renders in its body (iOS). What makes
   * it possible to say who else is affected when a component changes. */
  uses?: string[];
  /**
   * The subset of `uses` this component renders only inside an `if`, `switch`
   * or `guard`. Its own preview may never reach these.
   */
  conditionalUses?: ConditionalUse[];
  /** Previews this component should have and doesn't. See src/scan/gaps.ts. */
  gaps?: CoverageGap[];
}

export interface CoverageReport {
  platform: 'android' | 'ios';
  components: ScannedComponent[];
  /** Previews that could not be matched to any discovered component */
  orphanPreviews: ScannedPreview[];
  /** Locales the project ships beyond its development language. Empty when the
   * project is not localized, which keeps the localization gap silent there. */
  extraLocales: string[];
  /** Present when the report was narrowed to a subset of the project's files.
   * The scan still walked everything; only this report is filtered. */
  scope?: {
    paths: string[];
    /** Components the scan found, before the filter. */
    componentsScanned: number;
    /**
     * Previews outside the scope that put a component inside it on screen,
     * directly or through the views they render. Editing a row changes what
     * these show, and the filter would otherwise hide them. A fact to act on,
     * not a defect.
     */
    previewsOfWhatChanged?: {
      name: string;
      file: string;
      line: number;
      /** In-scope components this preview reaches. Its own text may name none of them. */
      renders: string[];
    }[];
    /**
     * Views outside the scope that render a component inside it directly and
     * have no preview of their own, so nothing shows the change in that
     * context. Whether that context is worth covering is a judgment about the
     * product, which is why this is a question for the designer rather than a
     * gap — and why it stops at one hop where `previewsOfWhatChanged` does not.
     */
    uncoveredUsesOfWhatChanged?: {
      component: string;
      file: string;
      /** The guarded render when `reason` is `conditional`, so the line points at
       * the branch in question; the component's declaration otherwise. */
      line: number;
      /** In-scope components it renders. */
      uses: string[];
      /** Why nothing shows the change here. */
      reason: 'no-preview' | 'conditional';
      /** `conditional` only: the condition a preview would have to satisfy. */
      guard?: string;
      /** `conditional` only: the previews that exist and do not enter the branch.
       * Naming them is what makes this answerable — the reader opens one. */
      previews?: { name: string; file: string; line: number }[];
    }[];
  };
  /** Totals for a quick summary */
  stats: {
    components: number;
    withPreview: number;
    withDarkPreview: number;
    totalPreviews: number;
    hintCount: number;
    gapCount: number;
    /** Components with at least one warning-severity gap. */
    componentsWithGaps: number;
    /** Components whose only preview is themselves (the @Preview-on-the-composable
     * pattern for screen-level composables with default parameters). */
    selfPreviewed: number;
  };
}
