/**
 * Coverage gaps: what a component is *missing*, as opposed to what an existing
 * preview got wrong.
 *
 * `hints.ts` answers "this preview's name promises something its annotation
 * doesn't declare". That only ever fires on a preview that already exists, so a
 * component with no previews at all — or one preview standing in for four
 * states — produces no hints and reads as fine.
 *
 * This module answers the other half: given what a component actually is (its
 * stored properties or parameters) and what the project supports (its locales),
 * which previews *should* exist and don't. The output is guidance for an agent
 * to act on, not a verdict — Phonebook renders previews, it never writes them,
 * and whether a state is worth covering is a judgment the agent makes with the
 * component's source in front of it.
 */

export type PropertyKind = 'bool' | 'optional' | 'collection' | 'enum-like' | 'other';

export interface ComponentProperty {
  name: string;
  /** Type as written in source, e.g. "Bool", "[Status]", "Status?". */
  type: string;
  kind: PropertyKind;
}

export interface CoverageGap {
  rule: string;
  severity: 'warning' | 'info';
  message: string;
  suggestion: string;
}

export interface CoverageGapInput {
  platform: 'android' | 'ios';
  component: string;
  properties: ComponentProperty[];
  /** Display names of the previews already covering this component. */
  previewNames: string[];
  /** True when at least one existing preview declares a dark configuration. */
  hasDarkPreview: boolean;
  /** Raw text of every existing preview for this component, for "already declares it" checks. */
  previewText: string;
  /** Locales the project ships, beyond its development language. Empty when unlocalized. */
  extraLocales: string[];
  /** Enum types declared anywhere in the project. A property of one of these
   * has a known, finite set of states; a property of any other named type is
   * left alone rather than guessed at. */
  enumTypes?: string[];
  /** Types the component reads via `@Environment(X.self)` (iOS only). */
  environmentTypes?: string[];
  /** Everything the previews pass to `.environment(...)`, including through any
   * project helper they call. A type named anywhere in here is supplied. */
  environmentProvided?: string;
}

/** A state name the previews already mention, however it is spelled. */
function covers(input: CoverageGapInput, ...words: string[]): boolean {
  const haystack = [...input.previewNames, input.previewText].join(' ').toLowerCase();
  return words.some((w) => haystack.includes(w.toLowerCase()));
}

/**
 * True when some preview passes *this* property in its absent or empty form.
 *
 * Checked against the property by name rather than by looking for "nil"
 * anywhere: a preview that passes `author: nil` covers the absent author, and
 * says nothing about an empty `replies` in the same call.
 */
function coversPropertyAs(input: CoverageGapInput, property: string, forms: RegExp): boolean {
  const pattern = new RegExp(`\\b${property}\\s*[:=]\\s*(?:${forms.source})`, 'i');
  return pattern.test(input.previewText);
}

const ABSENT_FORMS = /nil|null|\.none|None/;
const EMPTY_FORMS = /\[\s*\]|emptyList\(\)|emptySet\(\)|\.init\(\)|listOf\(\)|setOf\(\)/;

function stateCount(input: CoverageGapInput): number {
  // A component with one preview has one state covered no matter what that
  // preview is called; "Default" is not two states.
  return new Set(input.previewNames.map((n) => n.toLowerCase())).size;
}

const IOS_ENV = {
  dark: '.preferredColorScheme(.dark)',
  dynamicType: '.dynamicTypeSize(.accessibility3)',
  locale: (code: string) => `.environment(\\.locale, .init(identifier: "${code}"))`,
};

const ANDROID_ENV = {
  dark: '@Preview(uiMode = Configuration.UI_MODE_NIGHT_YES)',
  dynamicType: '@Preview(fontScale = 1.5f)',
  locale: (code: string) => `@Preview(locale = "${code}")`,
};

export function componentGaps(input: CoverageGapInput): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const env = input.platform === 'ios' ? IOS_ENV : ANDROID_ENV;
  const previewCount = input.previewNames.length;

  if (previewCount === 0) {
    gaps.push({
      rule: 'no-preview',
      severity: 'warning',
      message: `"${input.component}" has no preview, so it never reaches the gallery.`,
      suggestion: 'add one preview per meaningful state; call get_preview_guidance for the template',
    });
  }

  for (const prop of input.properties) {
    if (prop.kind === 'bool') {
      const both = stateCount(input) >= 2;
      if (!both) {
        gaps.push({
          rule: 'state-bool',
          severity: 'warning',
          message: `"${input.component}" takes ${prop.name}: ${prop.type}, which has two states, but ${previewCount === 0 ? 'no preview covers either' : 'only one preview exists'}.`,
          suggestion: `one preview per value of ${prop.name}, named "${input.component}/<State>"`,
        });
      }
      continue;
    }

    if (prop.kind === 'optional') {
      const covered =
        coversPropertyAs(input, prop.name, ABSENT_FORMS) ||
        covers(input, 'empty', 'none', 'missing', 'placeholder');
      if (!covered) {
        gaps.push({
          rule: 'state-optional',
          severity: 'warning',
          message: `"${input.component}" takes ${prop.name}: ${prop.type}, which can be absent, and no preview covers the absent case.`,
          suggestion: `a preview with ${prop.name} set to nil, named "${input.component}/Empty"`,
        });
      }
      continue;
    }

    if (prop.kind === 'collection') {
      const covered =
        coversPropertyAs(input, prop.name, EMPTY_FORMS) || covers(input, 'empty', 'none', 'zero');
      if (!covered) {
        gaps.push({
          rule: 'state-collection',
          severity: 'warning',
          message: `"${input.component}" takes ${prop.name}: ${prop.type}, which can be empty, and no preview covers the empty case.`,
          suggestion: `a preview with ${prop.name} empty, named "${input.component}/Empty"`,
        });
      }
      continue;
    }

    if (prop.kind === 'enum-like') {
      // Only when the project actually declares it as an enum. Every other
      // named type — a class, a struct, a protocol — has no finite set of
      // states to enumerate, and guessing at one would fill the report with
      // work that does not exist.
      const declared = (input.enumTypes ?? []).includes(prop.type.replace(/\s+/g, ''));
      if (declared && stateCount(input) < 2) {
        gaps.push({
          rule: 'state-enum',
          severity: 'warning',
          message: `"${input.component}" takes ${prop.name}: ${prop.type}, an enum, and ${previewCount === 0 ? 'no preview covers any case' : 'only one preview exists'}.`,
          suggestion: `one preview per case of ${prop.type}, named "${input.component}/<Case>"`,
        });
      }
    }
  }

  // Before every configuration rule below, because those describe a preview
  // that renders the wrong thing and this one describes a preview that does not
  // render at all. SwiftUI has no default for an @Observable read out of the
  // environment: the property's getter traps the moment the body reads it, so a
  // preview missing one is not thin coverage, it is a crash with a name.
  //
  // Direct reads only. A view that renders a subview with environment needs of
  // its own still traps, and finding that needs the call graph rather than the
  // one struct — worth doing, not done here, and a rule that catches the direct
  // case is already the difference between a preview that runs and one that
  // does not.
  if (input.platform === 'ios' && previewCount > 0) {
    const provided = input.environmentProvided ?? '';
    for (const type of input.environmentTypes ?? []) {
      if (provided.includes(type)) continue;
      gaps.push({
        rule: 'env-missing',
        severity: 'warning',
        message: `"${input.component}" reads @Environment(${type}.self) and no preview supplies one, so every preview of it traps at render.`,
        suggestion: `pass ${type} to .environment(...) in each preview — an unsatisfied @Environment traps rather than defaulting`,
      });
    }
  }

  if (previewCount > 0 && !input.hasDarkPreview) {
    gaps.push({
      rule: 'theme-dark',
      severity: 'warning',
      message: `"${input.component}" has no dark-theme preview, so a dark-mode regression cannot show up in the gallery.`,
      suggestion: env.dark,
    });
  }

  if (previewCount > 0 && !covers(input, 'dynamictypesize', 'fontscale', 'sizecategory', 'accessibility')) {
    gaps.push({
      rule: 'dynamic-type',
      severity: 'info',
      message: `"${input.component}" has no large-text preview, the configuration that most often breaks a layout.`,
      suggestion: env.dynamicType,
    });
  }

  // Silent on an unlocalized project: telling every repository to cover locales
  // it does not ship would make the report noise rather than a to-do list.
  if (previewCount > 0 && input.extraLocales.length > 0 && !covers(input, 'locale', 'environment(\\.locale', 'rtl')) {
    const sample = input.extraLocales[0];
    gaps.push({
      rule: 'localization',
      severity: 'info',
      message: `The project ships ${input.extraLocales.length} localization${input.extraLocales.length === 1 ? '' : 's'} (${input.extraLocales.slice(0, 4).join(', ')}${input.extraLocales.length > 4 ? ', …' : ''}) and "${input.component}" is previewed in the development language only.`,
      suggestion: env.locale(sample),
    });
  }

  return gaps;
}
