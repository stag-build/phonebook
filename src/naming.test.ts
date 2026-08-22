import { describe, expect, it } from 'vitest';
import { parsePreviewName, spaceCamelCase } from './naming.js';
import { parseRoborazziFileName } from './engines/android.js';

describe('parsePreviewName', () => {
  it('splits slash display names into component/state', () => {
    expect(parsePreviewName('PrimaryButtonEnabledPreview', 'Button/Enabled')).toEqual({
      component: 'Button',
      state: 'Enabled',
    });
  });

  it('uses display name as state when no slash', () => {
    expect(parsePreviewName('UserCardPreview', 'Dark')).toEqual({
      component: 'User Card',
      state: 'Dark',
    });
  });

  it('defaults state and strips Preview suffix', () => {
    expect(parsePreviewName('UserCardPreview')).toEqual({
      component: 'User Card',
      state: 'Default',
    });
  });

  it('strips Preview prefix', () => {
    expect(parsePreviewName('PreviewStatusBadge')).toEqual({
      component: 'Status Badge',
      state: 'Default',
    });
  });

  it('keeps name when it is only "Preview"', () => {
    expect(parsePreviewName('Preview').component).toBe('Preview');
  });
});

describe('spaceCamelCase', () => {
  it('splits camel case', () => expect(spaceCamelCase('PrimaryButton')).toBe('Primary Button'));
  it('keeps acronym runs', () => expect(spaceCamelCase('URLBar')).toBe('URL Bar'));
  it('handles underscores', () => expect(spaceCamelCase('user_card')).toBe('user card'));
});

describe('parseRoborazziFileName', () => {
  it('parses plain preview with no display name', () => {
    const m = parseRoborazziFileName('dev.stag.phonebook.sample.UserCardKt.UserCardPreview.png');
    expect(m.functionName).toBe('UserCardPreview');
    expect(m.displayName).toBeUndefined();
    expect(m.theme).toBeUndefined();
  });

  it('parses slash display name spread across subdirectories', () => {
    const m = parseRoborazziFileName(
      'dev.stag.phonebook.sample.PrimaryButtonKt.PrimaryButtonEnabledPreview.Button/Enabled.png',
    );
    expect(m.functionName).toBe('PrimaryButtonEnabledPreview');
    expect(m.displayName).toBe('Button/Enabled');
    expect(m.sourceFile).toBe('dev/stag/phonebook/sample/PrimaryButton.kt');
  });

  it('maps NIGHT suffix to dark theme', () => {
    const m = parseRoborazziFileName('dev.stag.phonebook.sample.UserCardKt.UserCardDarkPreview.NIGHT.png');
    expect(m.theme).toBe('dark');
    expect(m.displayName).toBeUndefined();
    expect(m.functionName).toBe('UserCardDarkPreview');
  });

  it('parses simple display name', () => {
    const m = parseRoborazziFileName('dev.stag.phonebook.sample.StatusBadgeKt.StatusBadgeSuccessPreview.Badge/Success.png');
    expect(m.displayName).toBe('Badge/Success');
  });

  it('demotes WITH_BACKGROUND to a tag, not a display name', () => {
    // Real output from an app whose previews are all @Preview(showBackground = true)
    // with no explicit name= — the ALL_CAPS marker must not become the state.
    const m = parseRoborazziFileName('com.om.spotifyuiapp.ui.features.home.HomeContentKt.HomeContent.WITH_BACKGROUND.png');
    expect(m.displayName).toBeUndefined();
    expect(m.theme).toBeUndefined();
    expect(m.tags).toEqual(['WITH_BACKGROUND']);
    expect(parsePreviewName(m.functionName, m.displayName)).toEqual({
      component: 'Home Content',
      state: 'Default',
    });
  });

  it('separates NIGHT (theme) from WITH_BACKGROUND (tag) when both are present', () => {
    const m = parseRoborazziFileName(
      'dev.stag.phonebook.sample.UserCardKt.UserCardPreview.NIGHT.WITH_BACKGROUND.png',
    );
    expect(m.theme).toBe('dark');
    expect(m.displayName).toBeUndefined();
    expect(m.tags).toEqual(['WITH_BACKGROUND']);
    expect(parsePreviewName(m.functionName, m.displayName)).toEqual({
      component: 'User Card',
      state: 'Default',
    });
  });

  it('keeps a genuine slash display name alongside a machine marker tag', () => {
    const m = parseRoborazziFileName(
      'dev.stag.phonebook.sample.PrimaryButtonKt.PrimaryButtonEnabledPreview.Button/Enabled.WITH_BACKGROUND.png',
    );
    expect(m.displayName).toBe('Button/Enabled');
    expect(m.tags).toEqual(['WITH_BACKGROUND']);
    expect(parsePreviewName(m.functionName, m.displayName)).toEqual({
      component: 'Button',
      state: 'Enabled',
    });
  });

  it('keeps a single all-caps word with no underscore as a state, not a marker', () => {
    // A user could plausibly pass name = "ERROR"; only underscored ALL_CAPS
    // tokens are Roborazzi's machine-generated markers.
    const m = parseRoborazziFileName('dev.stag.phonebook.sample.BannerKt.BannerPreview.ERROR.png');
    expect(m.displayName).toBe('ERROR');
    expect(m.tags).toBeUndefined();
    expect(parsePreviewName(m.functionName, m.displayName)).toEqual({
      component: 'Banner',
      state: 'ERROR',
    });
  });
});
