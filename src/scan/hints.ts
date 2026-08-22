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
    suggestion: () => 'device = "spec:width=891dp,height=411dp,orientation=landscape"',
  },
  {
    rule: 'orientation-portrait',
    severity: 'warning',
    namePattern: /portrait/i,
    declared: (ctx) => !androidDeclaresLandscape(ctx.annotationText),
    message: (ctx) =>
      `"${ctx.matchedName}" implies portrait orientation, but the @Preview annotation declares a landscape device.`,
    suggestion: () => 'device = "spec:width=411dp,height=891dp,orientation=portrait"',
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
        ? 'device = "spec:width=673dp,height=841dp" (unfolded foldable spec)'
        : 'device = Devices.TABLET',
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
    suggestion: () => 'widthDp = 320',
  },
];

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
  const { platform, functionName, displayName, annotationText } = input;
  const rules = platform === 'android' ? ANDROID_RULES : IOS_RULES;
  const hints = evalRules(rules, functionName, displayName, annotationText);

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
