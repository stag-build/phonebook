import { describe, it, expect } from 'vitest';
import { componentGaps, type CoverageGapInput } from './gaps.js';

function input(overrides: Partial<CoverageGapInput> = {}): CoverageGapInput {
  return {
    platform: 'ios',
    component: 'StatusRow',
    properties: [],
    previewNames: ['StatusRow/Default'],
    hasDarkPreview: true,
    previewText: '#Preview("StatusRow/Default") { .preferredColorScheme(.dark) }',
    extraLocales: [],
    ...overrides,
  };
}

const rules = (gaps: { rule: string }[]) => gaps.map((g) => g.rule);

describe('componentGaps', () => {
  it('reports a component that has no preview at all', () => {
    const gaps = componentGaps(input({ previewNames: [], previewText: '', hasDarkPreview: false }));
    expect(rules(gaps)).toContain('no-preview');
    expect(gaps.find((g) => g.rule === 'no-preview')?.severity).toBe('warning');
  });

  it('asks for both values of a Bool when only one preview exists', () => {
    const gaps = componentGaps(
      input({ properties: [{ name: 'isFocused', type: 'Bool', kind: 'bool' }] }),
    );
    const gap = gaps.find((g) => g.rule === 'state-bool');
    expect(gap).toBeDefined();
    expect(gap?.message).toContain('isFocused');
  });

  it('accepts a Bool once two previews cover it', () => {
    const gaps = componentGaps(
      input({
        properties: [{ name: 'isFocused', type: 'Bool', kind: 'bool' }],
        previewNames: ['StatusRow/Focused', 'StatusRow/Unfocused'],
      }),
    );
    expect(rules(gaps)).not.toContain('state-bool');
  });

  it('asks for the absent case of an Optional, and takes an Empty preview as covering it', () => {
    const properties = [{ name: 'author', type: 'Account?', kind: 'optional' as const }];
    expect(rules(componentGaps(input({ properties })))).toContain('state-optional');

    const covered = componentGaps(
      input({ properties, previewNames: ['StatusRow/Default', 'StatusRow/Empty'] }),
    );
    expect(rules(covered)).not.toContain('state-optional');
  });

  it('asks for the empty case of a collection', () => {
    const gaps = componentGaps(
      input({ properties: [{ name: 'replies', type: '[Status]', kind: 'collection' }] }),
    );
    expect(rules(gaps)).toContain('state-collection');
  });

  it('asks for a preview per case only when the type really is an enum', () => {
    const properties = [{ name: 'state', type: 'LoadingState', kind: 'enum-like' as const }];

    const declared = componentGaps(input({ properties, enumTypes: ['LoadingState'] }));
    const gap = declared.find((g) => g.rule === 'state-enum');
    expect(gap?.severity).toBe('warning');
    expect(gap?.suggestion).toContain('LoadingState');

    // A class or struct of the same shape has no finite set of cases to cover.
    expect(rules(componentGaps(input({ properties, enumTypes: ['SomethingElse'] })))).not.toContain(
      'state-enum',
    );
    expect(rules(componentGaps(input({ properties })))).not.toContain('state-enum');
  });

  it('reports a missing dark preview only when some preview exists', () => {
    expect(rules(componentGaps(input({ hasDarkPreview: false })))).toContain('theme-dark');
    expect(
      rules(componentGaps(input({ previewNames: [], previewText: '', hasDarkPreview: false }))),
    ).not.toContain('theme-dark');
  });

  it('reports missing large-text coverage and stops once a preview declares it', () => {
    expect(rules(componentGaps(input()))).toContain('dynamic-type');
    const covered = componentGaps(
      input({ previewText: '#Preview { StatusRow().dynamicTypeSize(.accessibility3) }' }),
    );
    expect(rules(covered)).not.toContain('dynamic-type');
  });

  it('stays silent about localization on an unlocalized project', () => {
    expect(rules(componentGaps(input({ extraLocales: [] })))).not.toContain('localization');
  });

  it('names the locales the project actually ships', () => {
    const gap = componentGaps(input({ extraLocales: ['de', 'fr', 'he'] })).find(
      (g) => g.rule === 'localization',
    );
    expect(gap?.message).toContain('de');
    expect(gap?.suggestion).toContain('de');
  });

  it('gives the platform its own suggestion syntax', () => {
    const ios = componentGaps(input({ hasDarkPreview: false }));
    const android = componentGaps(input({ platform: 'android', hasDarkPreview: false }));
    expect(ios.find((g) => g.rule === 'theme-dark')?.suggestion).toContain('preferredColorScheme');
    expect(android.find((g) => g.rule === 'theme-dark')?.suggestion).toContain('UI_MODE_NIGHT_YES');
  });
});
