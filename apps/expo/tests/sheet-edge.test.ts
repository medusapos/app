import { describe, expect, it } from 'vitest';
import { sheetEdge, sheetEdgeClass } from '../lib/sheet-edge';

describe('sheetEdge', () => {
  it('opens opposite the cart on a wide till', () => {
    expect(sheetEdge('right', false)).toBe('left');
    expect(sheetEdge('left', false)).toBe('right');
  });

  it('keeps the right edge on a phone', () => {
    expect(sheetEdge('right', true)).toBe('right');
    expect(sheetEdge('left', true)).toBe('right');
  });
});

describe('sheetEdgeClass', () => {
  it('moves the sheet to the left edge only for the left', () => {
    expect(sheetEdgeClass('left')).toContain('left-0');
    expect(sheetEdgeClass('left')).toContain('right-auto');
    expect(sheetEdgeClass('right')).toBe('');
  });
});
