import { describe, it, expect } from 'vitest';
import { summarizeGaps } from './server.js';
import type { CoverageReport, ScannedComponent } from '../scan/types.js';

function component(
  name: string,
  gaps: { rule: string; severity: 'warning' | 'info' }[],
): ScannedComponent {
  return {
    name,
    file: `Sources/${name}.swift`,
    line: 1,
    previews: [],
    gaps: gaps.map((g) => ({ ...g, message: `${name} message`, suggestion: `${name} suggestion` })),
  };
}

function report(components: ScannedComponent[]): CoverageReport {
  return {
    platform: 'ios',
    components,
    orphanPreviews: [],
    extraLocales: [],
    stats: {
      components: components.length,
      withPreview: 0,
      withDarkPreview: 0,
      totalPreviews: 0,
      hintCount: 0,
      gapCount: components.reduce((sum, c) => sum + (c.gaps ?? []).length, 0),
      componentsWithGaps: components.length,
      selfPreviewed: 0,
    },
  };
}

describe('summarizeGaps', () => {
  it('says so plainly when nothing is missing', () => {
    expect(summarizeGaps(report([]))).toBe('Missing previews (0)');
  });

  it('groups every gap under its component', () => {
    const text = summarizeGaps(
      report([
        component('StatusRow', [
          { rule: 'no-preview', severity: 'warning' },
          { rule: 'state-bool', severity: 'warning' },
        ]),
      ]),
    );

    expect(text).toContain('Sources/StatusRow.swift:1 StatusRow (2 missing)');
    expect(text).toContain('  [no-preview]');
    expect(text).toContain('  [state-bool]');
    expect(text).toContain('Missing previews (2 across 1 component)');
  });

  it('puts the components missing the most first', () => {
    const text = summarizeGaps(
      report([
        component('Thin', [{ rule: 'no-preview', severity: 'warning' }]),
        component('Rich', [
          { rule: 'no-preview', severity: 'warning' },
          { rule: 'state-bool', severity: 'warning' },
          { rule: 'state-enum', severity: 'warning' },
        ]),
      ]),
    );

    expect(text.indexOf('Rich')).toBeLessThan(text.indexOf('Thin'));
  });

  it('caps components, not lines, so a capped report still shows whole components', () => {
    const many = Array.from({ length: 75 }, (_, i) =>
      component(`View${String(i).padStart(2, '0')}`, [
        { rule: 'no-preview', severity: 'warning' },
        { rule: 'state-bool', severity: 'warning' },
      ]),
    );
    const text = summarizeGaps(report(many));

    expect(text).toContain('... and 15 more components (see JSON)');
    // Every component that is shown carries both of its gaps.
    const headers = text.split('\n').filter((l) => l.includes(' (2 missing)'));
    expect(headers).toHaveLength(60);
    expect(text).toContain('Missing previews (150 across 75 components)');
  });
});
