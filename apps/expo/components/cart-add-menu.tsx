import { useState } from 'react';
import type { useSale } from '@tallyui/pos';
import {
  ChargeForm, Dialog, DialogContent, DialogTitle, DiscountForm, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger, IconButton, Text,
} from '@tallyui/components';

export function CartAddMenu({ sale }: { sale: ReturnType<typeof useSale> }) {
  const [kind, setKind] = useState<'custom' | 'fee' | 'discount' | 'shipping' | null>(null);
  const chargesOffered = (sale.capabilities?.orderCreate ?? 0) >= 5;
  const showDiscount = sale.order.lineItems.length > 0;
  const close = () => setKind(null);
  if (!chargesOffered && !showDiscount) return null;
  const title = kind === 'discount' ? 'Order discount' : kind === 'fee' ? 'Add fee'
    : kind === 'shipping' ? 'Add shipping' : 'Add custom item';
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton testID="cart-add-menu" accessibilityLabel="Add to cart"><Text>+</Text></IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {chargesOffered && <DropdownMenuItem onPress={() => setKind('custom')}><Text>Add Miscellaneous Product</Text></DropdownMenuItem>}
        {chargesOffered && <DropdownMenuItem onPress={() => setKind('fee')}><Text>Add Fee</Text></DropdownMenuItem>}
        {showDiscount && <DropdownMenuItem onPress={() => setKind('discount')}><Text>Add Discount</Text></DropdownMenuItem>}
        {chargesOffered && <DropdownMenuItem onPress={() => setKind('shipping')}><Text>Add Shipping</Text></DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={kind !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent testID="cart-add-dialog">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {kind === 'discount' ? <DiscountForm title="Order discount" currency={sale.order.currency}
          onApply={(discount) => sale.applyDiscount(null, discount)} onClose={close} />
          : kind !== null && <ChargeForm kind={kind} currency={sale.order.currency} lineTax={sale.capabilities?.lineTax}
            shippingTaxFromStore={sale.capabilities?.taxRounding?.granularity === 'woocommerce'} onClose={close}
            onApply={({ kind, name, amountMinor, taxStatus, taxClass }) => {
              const result = kind === 'custom' ? sale.addCustomLine({ name, priceMinor: amountMinor, taxStatus, taxClass })
                : kind === 'fee' ? sale.addFee({ name, amountMinor, taxStatus, taxClass })
                  : sale.addShipping({ name, amountMinor, taxStatus, taxClass });
              return typeof result === 'string' ? result : null;
            }} />}
      </DialogContent>
    </Dialog>
  </>;
}
