import { describe, expect, it } from 'vitest';
import { previewHints } from './hints.js';

function ruleNames(hints: ReturnType<typeof previewHints>): string[] {
  return hints.map((h) => h.rule);
}

describe('previewHints: android', () => {
  it('the real finding: SplashContentLandscape with a plain @Preview fires orientation-landscape', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'SplashContentLandscape',
      annotationText: '@Preview(showBackground = true)',
    });
    const hint = hints.find((h) => h.rule === 'orientation-landscape');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('orientation=landscape');
  });

  it('orientation-landscape: suppressed when device spec declares landscape', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'HeaderLandscapePreview',
      annotationText: '@Preview(device = "spec:width=891dp,height=411dp,orientation=landscape")',
    });
    expect(ruleNames(hints)).not.toContain('orientation-landscape');
  });

  it('orientation-landscape: suppressed when widthDp > heightDp', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'HeaderLandscapePreview',
      displayName: 'Header/Landscape',
      annotationText: '@Preview(widthDp = 800, heightDp = 400)',
    });
    expect(ruleNames(hints)).not.toContain('orientation-landscape');
  });

  it('orientation-portrait: fires when name implies portrait but annotation declares landscape', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'HeaderPortraitPreview',
      annotationText: '@Preview(device = "spec:width=891dp,height=411dp,orientation=landscape")',
    });
    const hint = hints.find((h) => h.rule === 'orientation-portrait');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('orientation=portrait');
  });

  it('orientation-portrait: suppressed when no landscape is declared', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'HeaderPortraitPreview',
      annotationText: '@Preview(showBackground = true)',
    });
    expect(ruleNames(hints)).not.toContain('orientation-portrait');
  });

  it('theme-dark: fires for "Dark"/"Night" names without UI_MODE_NIGHT_YES', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'CardNightPreview',
      annotationText: '@Preview(showBackground = true)',
    });
    const hint = hints.find((h) => h.rule === 'theme-dark');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('UI_MODE_NIGHT_YES');
  });

  it('theme-dark: suppressed when UI_MODE_NIGHT_YES is declared', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'CardDarkPreview',
      annotationText: '@Preview(uiMode = Configuration.UI_MODE_NIGHT_YES)',
    });
    expect(ruleNames(hints)).not.toContain('theme-dark');
  });

  it('theme-light: fires when name implies light but UI_MODE_NIGHT_YES is declared', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'CardLightPreview',
      annotationText: '@Preview(uiMode = Configuration.UI_MODE_NIGHT_YES)',
    });
    expect(ruleNames(hints)).toContain('theme-light');
  });

  it('theme-light: suppressed when no dark uiMode is declared', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'CardLightPreview',
      annotationText: '@Preview(showBackground = true)',
    });
    expect(ruleNames(hints)).not.toContain('theme-light');
  });

  it('device-tablet: fires for tablet/foldable/expanded names without device=', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'DashboardTabletPreview',
      annotationText: '@Preview(showBackground = true)',
    });
    const hint = hints.find((h) => h.rule === 'device-tablet');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('Devices.TABLET');
  });

  it('device-tablet: foldable name suggests a foldable spec', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'DashboardFoldablePreview',
      annotationText: '@Preview(showBackground = true)',
    });
    const hint = hints.find((h) => h.rule === 'device-tablet');
    expect(hint?.suggestion).toContain('foldable');
  });

  it('device-tablet: suppressed when device= is declared', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'DashboardTabletPreview',
      annotationText: '@Preview(device = Devices.TABLET)',
    });
    expect(ruleNames(hints)).not.toContain('device-tablet');
  });

  it('locale-rtl: fires for RTL/Arabic/Hebrew names without locale=', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'HeaderArabicPreview',
      annotationText: '@Preview(showBackground = true)',
    });
    const hint = hints.find((h) => h.rule === 'locale-rtl');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toBe('locale = "ar"');
  });

  it('locale-rtl: Hebrew name suggests locale "he"', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'HeaderHebrewPreview',
      annotationText: '@Preview(showBackground = true)',
    });
    const hint = hints.find((h) => h.rule === 'locale-rtl');
    expect(hint?.suggestion).toBe('locale = "he"');
  });

  it('locale-rtl: suppressed when locale= is declared', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'HeaderArabicPreview',
      annotationText: '@Preview(locale = "ar")',
    });
    expect(ruleNames(hints)).not.toContain('locale-rtl');
  });

  it('font-scale: fires for accessibility/font-scale names without fontScale=', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'CardAccessibilityPreview',
      annotationText: '@Preview(showBackground = true)',
    });
    const hint = hints.find((h) => h.rule === 'font-scale');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('fontScale');
  });

  it('font-scale: suppressed when fontScale= is declared', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'CardAccessibilityPreview',
      annotationText: '@Preview(fontScale = 1.5f)',
    });
    expect(ruleNames(hints)).not.toContain('font-scale');
  });

  it('size-compact: fires for compact/small-screen names without widthDp or device', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'CardCompactPreview',
      annotationText: '@Preview(showBackground = true)',
    });
    const hint = hints.find((h) => h.rule === 'size-compact');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('widthDp');
  });

  it('size-compact: suppressed when widthDp= is declared', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'CardCompactPreview',
      annotationText: '@Preview(widthDp = 320)',
    });
    expect(ruleNames(hints)).not.toContain('size-compact');
  });

  it('unnamed-preview: fires when there is no displayName', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'UserCardPreview',
      annotationText: '@Preview',
    });
    const hint = hints.find((h) => h.rule === 'unnamed-preview');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('@Preview(name =');
  });

  it('unnamed-preview: suppressed when a displayName is present', () => {
    const hints = previewHints({
      platform: 'android',
      functionName: 'UserCardPreview',
      displayName: 'User Card/Default',
      annotationText: '@Preview(name = "User Card/Default")',
    });
    expect(ruleNames(hints)).not.toContain('unnamed-preview');
  });
});

describe('previewHints: ios', () => {
  it('orientation-landscape: fires for landscape names without a landscape modifier', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'HeaderLandscape',
      annotationText: '#Preview("Header/Landscape") {\n    Header()\n}',
    });
    const hint = hints.find((h) => h.rule === 'orientation-landscape');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('previewInterfaceOrientation');
  });

  it('orientation-landscape: suppressed when .landscapeLeft is declared', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'HeaderLandscape',
      annotationText:
        '#Preview("Header/Landscape") {\n    Header()\n        .previewInterfaceOrientation(.landscapeLeft)\n}',
    });
    expect(ruleNames(hints)).not.toContain('orientation-landscape');
  });

  it('theme-dark: fires for dark/night names without .preferredColorScheme(.dark)', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'CardDark',
      annotationText: '#Preview("Card/Dark") {\n    Card()\n}',
    });
    const hint = hints.find((h) => h.rule === 'theme-dark');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toBe('.preferredColorScheme(.dark)');
  });

  it('theme-dark: suppressed when .preferredColorScheme(.dark) is declared', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'CardDark',
      annotationText: '#Preview("Card/Dark") {\n    Card()\n        .preferredColorScheme(.dark)\n}',
    });
    expect(ruleNames(hints)).not.toContain('theme-dark');
  });

  it('theme-light: fires when name implies light but .preferredColorScheme(.dark) is declared', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'CardLight',
      annotationText: '#Preview("Card/Light") {\n    Card()\n        .preferredColorScheme(.dark)\n}',
    });
    expect(ruleNames(hints)).toContain('theme-light');
  });

  it('theme-light: suppressed when no dark color scheme is declared', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'CardLight',
      annotationText: '#Preview("Card/Light") {\n    Card()\n}',
    });
    expect(ruleNames(hints)).not.toContain('theme-light');
  });

  it('device-tablet: fires for tablet/ipad names without .previewDevice', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'DashboardIpad',
      annotationText: '#Preview("Dashboard/iPad") {\n    Dashboard()\n}',
    });
    const hint = hints.find((h) => h.rule === 'device-tablet');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('previewDevice');
  });

  it('device-tablet: suppressed when .previewDevice is declared', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'DashboardIpad',
      annotationText:
        '#Preview("Dashboard/iPad") {\n    Dashboard()\n        .previewDevice("iPad Pro 13-inch (M4)")\n}',
    });
    expect(ruleNames(hints)).not.toContain('device-tablet');
  });

  it('locale-rtl: fires for RTL/Arabic/Hebrew names without layoutDirection', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'HeaderArabic',
      annotationText: '#Preview("Header/Arabic") {\n    Header()\n}',
    });
    const hint = hints.find((h) => h.rule === 'locale-rtl');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('rightToLeft');
  });

  it('locale-rtl: suppressed when layoutDirection is declared', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'HeaderArabic',
      annotationText:
        '#Preview("Header/Arabic") {\n    Header()\n        .environment(\\.layoutDirection, .rightToLeft)\n}',
    });
    expect(ruleNames(hints)).not.toContain('locale-rtl');
  });

  it('font-scale: fires for accessibility/dynamicType names without dynamicTypeSize', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'CardAccessibility',
      annotationText: '#Preview("Card/Accessibility") {\n    Card()\n}',
    });
    const hint = hints.find((h) => h.rule === 'font-scale');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('dynamicTypeSize');
  });

  it('font-scale: suppressed when dynamicTypeSize is declared', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'CardAccessibility',
      annotationText:
        '#Preview("Card/Accessibility") {\n    Card()\n        .dynamicTypeSize(.accessibility3)\n}',
    });
    expect(ruleNames(hints)).not.toContain('font-scale');
  });

  it('sizing: fires (info) when no traits: is declared and name does not imply full-screen', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'PrimaryButton',
      annotationText: '#Preview("Button/Enabled") {\n    PrimaryButton()\n}',
    });
    const hint = hints.find((h) => h.rule === 'sizing');
    expect(hint).toBeDefined();
    expect(hint?.severity).toBe('info');
    expect(hint?.suggestion).toBe('traits: .sizeThatFitsLayout');
  });

  it('sizing: suppressed when traits: is declared', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'PrimaryButton',
      annotationText: '#Preview("Button/Enabled", traits: .sizeThatFitsLayout) {\n    PrimaryButton()\n}',
    });
    expect(ruleNames(hints)).not.toContain('sizing');
  });

  it('sizing: suppressed for names ending in Screen/Page/Content', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'SettingsScreen',
      annotationText: '#Preview("Settings/Default") {\n    SettingsScreen()\n}',
    });
    expect(ruleNames(hints)).not.toContain('sizing');
  });

  it('unnamed-preview: fires when there is no displayName', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'unnamed',
      annotationText: '#Preview {\n    ContentView()\n}',
    });
    const hint = hints.find((h) => h.rule === 'unnamed-preview');
    expect(hint).toBeDefined();
    expect(hint?.suggestion).toContain('#Preview("<Component>/<State>")');
  });

  it('unnamed-preview: suppressed when a displayName is present', () => {
    const hints = previewHints({
      platform: 'ios',
      functionName: 'UserCard/Default',
      displayName: 'UserCard/Default',
      annotationText: '#Preview("UserCard/Default", traits: .sizeThatFitsLayout) {\n    UserCard()\n}',
    });
    expect(ruleNames(hints)).not.toContain('unnamed-preview');
  });
});
