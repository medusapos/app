import { describe, expect, it } from 'vitest';
import { clampNote } from './note-text';

const LONE_SURROGATE = /\p{Cs}/u;

describe('clampNote', () => {
  it('leaves a short note unchanged', () => {
    expect(clampNote('Gift wrap, please')).toBe('Gift wrap, please');
  });
  it('cuts 1001 units to 1000', () => {
    expect(clampNote('x'.repeat(1001))).toBe('x'.repeat(1000));
  });
  it('drops an emoji that unit 1000 would split, keeping 999 well-formed units', () => {
    const note = clampNote('x'.repeat(999) + '😀');
    expect(note).toBe('x'.repeat(999));
    expect(LONE_SURROGATE.test(note)).toBe(false);
  });
  it('keeps an emoji that ends at unit 1000', () => {
    const note = clampNote('x'.repeat(998) + '😀' + 'more');
    expect(note).toHaveLength(1000);
    expect(note.endsWith('😀')).toBe(true);
  });
});
