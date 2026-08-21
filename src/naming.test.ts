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
});
