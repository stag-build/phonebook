/**
 * Preview configuration hints: heuristics that catch a preview whose *name*
 * (composable/View function name, or its `@Preview`/`#Preview` display name)
 * implies a configuration — landscape, dark theme, tablet, RTL, etc. — that
 * the annotation never actually declares. Real finding that motivated this:
 * `fun SplashContentLandscape()` annotated with plain
 * `@Preview(showBackground = true)` rendered portrait, so the gallery showed
 * a screenshot named "Landscape" that wasn't.
 */

import { spaceCamelCase } from '../naming.js';

export interface PreviewHint {
  rule: string;
  severity: 'warning' | 'info';
  message: string;
  suggestion: string;
}

export interface PreviewHintInput {
  platform: 'android' | 'ios';
  functionName: string;
  displayName?: string;
  annotationText: string;
  /** Text of the preview function's body (from the opening brace, capped to ~20 lines).
   * Android-only for now; used by the `size-in-body` rule. */
  bodyText?: string;
}

interface Dims {
  width?: number;
  height?: number;
}

/** Extracts width/height (in dp) from a `device = "spec:width=..dp,height=..dp,..."` value,
 * or from standalone `widthDp = N` / `heightDp = N` params. */
function extractDims(text: string): Dims {
  const deviceMatch = text.match(/device\s*=\s*"([^"]*)"/);
  const scope = deviceMatch ? deviceMatch[1] : '';
  const widthMatch = scope.match(/width\s*=\s*(\d+)dp/i) ?? text.match(/widthDp\s*=\s*(\d+)/i);
  const heightMatch = scope.match(/height\s*=\s*(\d+)dp/i) ?? text.match(/heightDp\s*=\s*(\d+)/i);
  return {
    width: widthMatch ? Number(widthMatch[1]) : undefined,
    height: heightMatch ? Number(heightMatch[1]) : undefined,
  };
}

function androidDeclaresLandscape(text: string): boolean {
  if (/orientation\s*=\s*landscape/i.test(text)) return true;
  const { width, height } = extractDims(text);
  return width !== undefined && height !== undefined && width > height;
}

interface RuleContext {
  functionName: string;
  displayName?: string;
  annotationText: string;
  /** The name candidate (functionName or displayName) that matched this rule's pattern. */
  matchedName: string;
}

interface HintRule {
  rule: string;
  severity: 'warning' | 'info';
  namePattern: RegExp;
  /** True when the annotation already declares the implied trait (rule is suppressed). */
  declared: (ctx: RuleContext) => boolean;
  message: (ctx: RuleContext) => string;
  suggestion: (ctx: RuleContext) => string;
  /** Extra guard evaluated only when namePattern matched; return true to suppress the hint entirely. */
  skip?: (ctx: RuleContext) => boolean;
}

const ANDROID_RULES: HintRule[] = [
  {
    rule: 'orientation-landscape',
    severity: 'warning',
    namePattern: /landscape/i,
    declared: (ctx) => androidDeclaresLandscape(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies landscape orientation, but the @Preview annotation doesn't declare a landscape device/orientation.`,
    suggestion: () =>
      'on the @Preview annotation: device = "spec:width=891dp,height=411dp,orientation=landscape"',
  },
  {
    rule: 'orientation-portrait',
    severity: 'warning',
    namePattern: /portrait/i,
    declared: (ctx) => !androidDeclaresLandscape(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies portrait orientation, but the @Preview annotation declares a landscape device.`,
    suggestion: () =>
      'on the @Preview annotation: device = "spec:width=411dp,height=891dp,orientation=portrait"',
  },
  {
    rule: 'theme-dark',
    severity: 'warning',
    namePattern: /\b(dark|night)\b/i,
    declared: (ctx) => /UI_MODE_NIGHT_YES/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies dark theme, but the @Preview annotation doesn't set UI_MODE_NIGHT_YES.`,
    suggestion: () =>
      'uiMode = Configuration.UI_MODE_NIGHT_YES (import android.content.res.Configuration)',
  },
  {
    rule: 'theme-light',
    severity: 'warning',
    namePattern: /\blight\b/i,
    declared: (ctx) => !/UI_MODE_NIGHT_YES/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies light theme, but the @Preview annotation sets UI_MODE_NIGHT_YES.`,
    suggestion: () => 'remove uiMode, or set uiMode = Configuration.UI_MODE_NIGHT_NO',
  },
  {
    rule: 'device-tablet',
    severity: 'warning',
    namePattern: /\b(tablet|foldable|expanded|large ?screen)\b/i,
    declared: (ctx) => /device\s*=/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies a tablet/foldable/expanded device, but the @Preview annotation doesn't set device.`,
    suggestion: (ctx) =>
      /foldable/i.test(ctx.matchedName)
        ? 'on the @Preview annotation: device = "spec:width=673dp,height=841dp" (unfolded foldable spec)'
        : 'on the @Preview annotation: device = Devices.TABLET',
  },
  {
    rule: 'locale-rtl',
    severity: 'warning',
    namePattern: /\b(rtl|arabic|hebrew)\b/i,
    declared: (ctx) => /locale\s*=/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies an RTL locale, but the @Preview annotation doesn't set locale.`,
    suggestion: (ctx) => (/hebrew/i.test(ctx.matchedName) ? 'locale = "he"' : 'locale = "ar"'),
  },
  {
    rule: 'font-scale',
    severity: 'warning',
    namePattern: /\b(large ?font|font ?scale|accessibility|a11y)\b/i,
    declared: (ctx) => /fontScale\s*=/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies a large font scale, but the @Preview annotation doesn't set fontScale.`,
    suggestion: () => 'fontScale = 1.5f',
  },
  {
    rule: 'size-compact',
    severity: 'warning',
    namePattern: /\b(compact|small ?screen|phone ?small)\b/i,
    declared: (ctx) => /widthDp\s*=/.test(ctx.annotationText) || /device\s*=/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies a compact/small-screen size, but the @Preview annotation doesn't set widthDp or device.`,
    suggestion: () => 'on the @Preview annotation: widthDp = 320',
  },
];

/** Matches a fixed-size Modifier call (e.g. `.size(width = 891.dp, height = 411.dp)`) with
 * a simple, non-nested argument list — the shape these calls take in practice. A call whose
 * argument contains its own parens (e.g. `.size(dimensionResource(R.dimen.x))`) deliberately
 * doesn't match: we have no literal dp value to reason about, so there's nothing to report. */
const SIZE_MODIFIER_RE =
  /\.(size|requiredSize|width|height|requiredWidth|requiredHeight)\s*\(([^()]*)\)/g;

interface ParsedBodySize {
  modifiers: string[];
  width?: number;
  height?: number;
}

/** Scans (a segment of) a preview body for fixed-size Modifier calls and, where parseable, the
 * dp values they set. Handles `.size(48.dp)`, `.size(300.dp, 200.dp)`,
 * `.size(width = 891.dp, height = 411.dp)`, and separate `.width(...)`/`.height(...)` calls. */
function parseBodySize(text: string): ParsedBodySize | undefined {
  const modifiers: string[] = [];
  let width: number | undefined;
  let height: number | undefined;

  for (const match of text.matchAll(SIZE_MODIFIER_RE)) {
    const mod = match[1];
    const args = match[2];
    modifiers.push(mod);

    const widthArg = args.match(/width\s*=\s*(\d+(?:\.\d+)?)\.dp/i);
    const heightArg = args.match(/height\s*=\s*(\d+(?:\.\d+)?)\.dp/i);
    const dpValues = [...args.matchAll(/(\d+(?:\.\d+)?)\.dp/g)].map((m) => Number(m[1]));

    if (mod === 'size' || mod === 'requiredSize') {
      if (widthArg) width = Number(widthArg[1]);
      if (heightArg) height = Number(heightArg[1]);
      if (!widthArg && !heightArg) {
        if (dpValues.length === 1) {
          width = dpValues[0];
          height = dpValues[0];
        } else if (dpValues.length >= 2) {
          width = dpValues[0];
          height = dpValues[1];
        }
      }
    } else if (mod === 'width' || mod === 'requiredWidth') {
      if (dpValues.length >= 1) width = dpValues[0];
    } else if (mod === 'height' || mod === 'requiredHeight') {
      if (dpValues.length >= 1) height = dpValues[0];
    }
  }

  if (modifiers.length === 0) return undefined;
  return { modifiers, width, height };
}

function androidDeclaresExplicitSize(annotationText: string): boolean {
  return (
    /widthDp\s*=/.test(annotationText) ||
    /heightDp\s*=/.test(annotationText) ||
    /device\s*=/.test(annotationText)
  );
}

/**
 * The default Compose preview canvas (a Pixel-ish phone) when no widthDp/heightDp/device
 * is declared: 392dp wide, 892dp tall. A size set on the root composable only causes visible
 * harm (clipping) when it exceeds these — an icon's `.size(40.dp)` is completely harmless.
 */
const DEFAULT_CANVAS_WIDTH_DP = 392;
const DEFAULT_CANVAS_HEIGHT_DP = 892;

/**
 * Isolates the modifier chain of the preview body's ROOT composable call: the text from the
 * start of the body up to the first `{` that opens that root call's content lambda. Nested
 * composables (anything inside that lambda) are deliberately excluded — almost every preview
 * body has *some* inner `.size(...)` (an icon, a row height, ...), and those never affect the
 * canvas, so scanning the whole body would be all noise. A simple line/brace-position
 * approximation, not a real parser: robust enough for the common `Root(modifier = ...) { ... }`
 * shape, and for a bare `Root(...)` call with no trailing lambda (root segment == whole body).
 */
function rootComposableSegment(bodyText: string): string {
  // bodyText always starts with the function's own opening brace (see captureBodyText).
  const searchStart = 1;
  const lambdaOpen = bodyText.indexOf('{', searchStart);
  return lambdaOpen === -1 ? bodyText.slice(searchStart) : bodyText.slice(searchStart, lambdaOpen);
}

/**
 * `size-in-body`: the preview body's ROOT composable sets a fixed size via a Modifier
 * (`.size`/`.requiredSize`/`.width`/`.height`/`.requiredWidth`/`.requiredHeight`) that exceeds
 * the default preview canvas (392dp wide / 892dp tall), while the annotation declares no canvas
 * size of its own -- so the content is clipped instead of resized. This is a distinct mistake
 * from `orientation-landscape`/`device-tablet`/`size-compact` (which key off the preview's
 * *name*): here the body itself proves the mistake, regardless of naming. Both may fire together
 * on the same preview -- a landscape-named preview that also over-sizes itself via Modifier is
 * doubly wrong -- but their messages don't contradict: this rule only ever talks about the root
 * Modifier size exceeding the canvas, never about orientation/name.
 *
 * Requires a literal, parseable dp value that actually exceeds the canvas: an in-bounds size
 * (an icon's `.size(40.dp)`, a row's `.width(360.dp)`) or an unparseable expression (a
 * dimension resource, a variable) never fires. No evidence, no warning.
 */
function checkSizeInBody(annotationText: string, bodyText: string | undefined): PreviewHint | undefined {
  if (!bodyText) return undefined;
  if (androidDeclaresExplicitSize(annotationText)) return undefined;

  const parsed = parseBodySize(rootComposableSegment(bodyText));
  if (!parsed) return undefined;
  const { width, height } = parsed;
  if (width === undefined && height === undefined) return undefined;

  const widthExceeds = width !== undefined && width > DEFAULT_CANVAS_WIDTH_DP;
  const heightExceeds = height !== undefined && height > DEFAULT_CANVAS_HEIGHT_DP;
  if (!widthExceeds && !heightExceeds) return undefined;

  const reasons: string[] = [];
  if (widthExceeds) {
    reasons.push(`${width}dp of width, but the preview canvas is only ${DEFAULT_CANVAS_WIDTH_DP}dp wide`);
  }
  if (heightExceeds) {
    reasons.push(`${height}dp of height, but the preview canvas is only ${DEFAULT_CANVAS_HEIGHT_DP}dp tall`);
  }

  const suggestedParts: string[] = [];
  if (width !== undefined) suggestedParts.push(`widthDp = ${width}`);
  if (height !== undefined) suggestedParts.push(`heightDp = ${height}`);

  return {
    rule: 'size-in-body',
    severity: 'warning',
    message:
      `The preview body's root composable requests ${reasons.join(' and ')}, so it is clipped ` +
      `instead of resized. A size Modifier in the preview body sizes content inside the canvas -- ` +
      `it does not resize the canvas itself.`,
    suggestion: `on the @Preview annotation: @Preview(${suggestedParts.join(', ')})`,
  };
}

const IOS_RULES: HintRule[] = [
  {
    rule: 'orientation-landscape',
    severity: 'warning',
    namePattern: /landscape/i,
    declared: (ctx) => /\.landscapeLeft|\.landscapeRight|previewInterfaceOrientation/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies landscape orientation, but the #Preview doesn't declare .previewInterfaceOrientation(.landscape*).`,
    suggestion: () => '.previewInterfaceOrientation(.landscapeLeft)',
  },
  {
    rule: 'theme-dark',
    severity: 'warning',
    namePattern: /\b(dark|night)\b/i,
    declared: (ctx) => /\.preferredColorScheme\(\s*\.dark\s*\)/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies dark theme, but the #Preview doesn't declare .preferredColorScheme(.dark).`,
    suggestion: () => '.preferredColorScheme(.dark)',
  },
  {
    rule: 'theme-light',
    severity: 'warning',
    namePattern: /\blight\b/i,
    declared: (ctx) => !/\.preferredColorScheme\(\s*\.dark\s*\)/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies light theme, but the #Preview declares .preferredColorScheme(.dark).`,
    suggestion: () => '.preferredColorScheme(.light)',
  },
  {
    rule: 'device-tablet',
    severity: 'warning',
    namePattern: /\b(tablet|ipad)\b/i,
    declared: (ctx) => /\.previewDevice/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies an iPad/tablet device, but the #Preview doesn't declare .previewDevice.`,
    suggestion: () => '.previewDevice("iPad Pro 13-inch (M4)")',
  },
  {
    rule: 'locale-rtl',
    severity: 'warning',
    namePattern: /\b(rtl|arabic|hebrew)\b/i,
    declared: (ctx) => /layoutDirection/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies an RTL locale, but the #Preview doesn't set layoutDirection.`,
    suggestion: () => '.environment(\\.layoutDirection, .rightToLeft)',
  },
  {
    rule: 'font-scale',
    severity: 'warning',
    namePattern: /\b(large ?font|dynamic ?type|accessibility|a11y)\b/i,
    declared: (ctx) => /dynamicTypeSize/.test(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies a large/accessibility font size, but the #Preview doesn't set dynamicTypeSize.`,
    suggestion: () => '.dynamicTypeSize(.accessibility3)',
  },
  {
    rule: 'sizing',
    severity: 'info',
    namePattern: /.*/,
    declared: (ctx) => /traits\s*:/.test(ctx.annotationText),
    skip: (ctx) => /(Screen|Page|Content)$/i.test(ctx.matchedName),
    message: (ctx) =>
      `"${ctx.matchedName}" doesn't declare a traits: value, so it renders at full device size instead of fit-to-content.`,
    suggestion: () => 'traits: .sizeThatFitsLayout',
  },
];

function nameCandidates(functionName: string, displayName?: string): string[] {
  const candidates = [functionName];
  if (displayName) candidates.push(displayName);
  return candidates;
}

function evalRules(rules: HintRule[], functionName: string, displayName: string | undefined, annotationText: string): PreviewHint[] {
  const hints: PreviewHint[] = [];
  const candidates = nameCandidates(functionName, displayName);

  for (const rule of rules) {
    let matchedName: string | undefined;
    for (const candidate of candidates) {
      // Match against both the raw candidate (handles "/"-separated or
      // already-spaced display names) and its camelCase-split form, so a
      // word like "Landscape" is found inside "SplashContentLandscape" too.
      if (rule.namePattern.test(candidate) || rule.namePattern.test(spaceCamelCase(candidate))) {
        matchedName = candidate;
        break;
      }
    }
    if (matchedName === undefined) continue;

    const ctx: RuleContext = { functionName, displayName, annotationText, matchedName };
    if (rule.skip?.(ctx)) continue;
    if (rule.declared(ctx)) continue;

    hints.push({
      rule: rule.rule,
      severity: rule.severity,
      message: rule.message(ctx),
      suggestion: rule.suggestion(ctx),
    });
  }

  return hints;
}

export function previewHints(input: PreviewHintInput): PreviewHint[] {
  const { platform, functionName, displayName, annotationText, bodyText } = input;
  const rules = platform === 'android' ? ANDROID_RULES : IOS_RULES;
  const hints = evalRules(rules, functionName, displayName, annotationText);

  if (platform === 'android') {
    const sizeHint = checkSizeInBody(annotationText, bodyText);
    if (sizeHint) hints.push(sizeHint);
  }

  if (!displayName) {
    const example = platform === 'android' ? '@Preview(name = "<Component>/<State>")' : '#Preview("<Component>/<State>")';
    hints.push({
      rule: 'unnamed-preview',
      severity: 'info',
      message: `"${functionName}" has no display name, so the gallery groups it under "Default" instead of a real state.`,
      suggestion: `${example} per the naming convention`,
    });
  }

  return hints;
}
