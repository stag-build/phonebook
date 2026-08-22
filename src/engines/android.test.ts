import { describe, expect, it } from 'vitest';
import { checkEmptyEntries, EMPTY_PREVIEWS_MESSAGE } from './android.js';

describe('checkEmptyEntries', () => {
  it('throws with the diagnostic message when there are zero entries and allowEmpty is false', () => {
    expect(() => checkEmptyEntries(0, false)).toThrow(EMPTY_PREVIEWS_MESSAGE);
  });

  it('does not throw when there are zero entries but allowEmpty is true', () => {
    expect(() => checkEmptyEntries(0, true)).not.toThrow();
  });

  it('does not throw when there are entries, regardless of allowEmpty', () => {
    expect(() => checkEmptyEntries(3, false)).not.toThrow();
    expect(() => checkEmptyEntries(3, true)).not.toThrow();
  });
});
