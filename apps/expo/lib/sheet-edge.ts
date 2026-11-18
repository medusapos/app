// v2's side sheets cover the products, never the cart; a phone keeps the right edge.
export function sheetEdge(cartSide: 'left' | 'right', phone: boolean): 'left' | 'right' {
  return phone ? 'right' : cartSide === 'left' ? 'right' : 'left';
}

// TallyUI's DialogContent side="right" has no left variant; these classes move it to the left edge.
export function sheetEdgeClass(edge: 'left' | 'right'): string {
  return edge === 'left' ? 'left-0 right-auto border-l-0 border-r' : '';
}
