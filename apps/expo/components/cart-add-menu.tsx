import { useState } from 'react';
import { View } from 'react-native';
import { Line } from 'react-native-svg';
import type { useSale } from '@tallyui/pos';
import {
  Button, ChargeForm, createSvgIcon, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DiscountForm, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, Text,
} from '@tallyui/components';
import { CouponCodeInput, couponsEnabled, useCouponEntry } from './coupon-field';

const PlusIcon = createSvgIcon('PlusIcon', () => <><Line x1={12} y1={5} x2={12} y2={19} /><Line x1={5} y1={12} x2={19} y2={12} /></>);

/** The dialog's coupon entry: the inline field's own apply path, closing the dialog once a code applies. */
function CouponDialogBody({ sale, onClose }: { sale: ReturnType<typeof useSale>; onClose: () => void }) {
  const entry = useCouponEntry(sale, onClose);
  return <View className="gap-2"><CouponCodeInput entry={entry} /></View>;
}

/** v2's cart "+" menu: Add new customer, then the charges and the order discount (offered on an empty cart too). */
export function CartAddMenu({ sale, onAddCustomer }: { sale: ReturnType<typeof useSale>; onAddCustomer?: () => void }) {
  const [kind, setKind] = useState<'custom' | 'fee' | 'discount' | 'coupon' | 'shipping' | null>(null);
  const [open, setOpen] = useState(false);
  const chargesOffered = (sale.capabilities?.orderCreate ?? 0) >= 5;
  const coupons = couponsEnabled(sale.capabilities);
  const close = () => setKind(null);
  const title = kind === 'discount' ? 'Order discount' : kind === 'fee' ? 'Add fee'
    : kind === 'shipping' ? 'Add shipping' : 'Add custom item';
  return <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {/* v2 keeps the button tinted while its menu is open. */}
        <IconButton testID="cart-add-menu" accessibilityLabel="Add to cart" dataSet={{ open: open ? 'true' : 'false' }}
          className={open ? 'bg-primary/10' : undefined}>
          <View className={open ? 'text-primary' : 'text-foreground'}><PlusIcon size={20} /></View>
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Greyed when customers can't be created here (no createCustomer, or offline). */}
        <DropdownMenuItem testID="cart-add-new-customer" disabled={!onAddCustomer} className={onAddCustomer ? undefined : 'opacity-50'}
          onPress={() => onAddCustomer?.()}><Text>Add new customer</Text></DropdownMenuItem>
        <DropdownMenuSeparator />
        {chargesOffered && <DropdownMenuItem onPress={() => setKind('custom')}><Text>Add Miscellaneous Product</Text></DropdownMenuItem>}
        {chargesOffered && <DropdownMenuItem onPress={() => setKind('fee')}><Text>Add Fee</Text></DropdownMenuItem>}
        <DropdownMenuItem onPress={() => setKind('discount')}><Text>Add Discount</Text></DropdownMenuItem>
        {/* Greyed when the till does not offer coupons: the rule that hides the inline coupon field. */}
        <DropdownMenuItem testID="cart-add-coupon" disabled={!coupons} className={coupons ? undefined : 'opacity-50'}
          onPress={() => setKind('coupon')}><Text>Add Coupon</Text></DropdownMenuItem>
        {chargesOffered && <DropdownMenuItem onPress={() => setKind('shipping')}><Text>Add Shipping</Text></DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={kind !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent testID="cart-add-dialog">
        {kind === 'coupon' ? <>
          <DialogHeader><DialogTitle>Add coupon</DialogTitle></DialogHeader>
          <CouponDialogBody sale={sale} onClose={close} />
          <DialogFooter><Button variant="outline" onPress={close}><Text>Cancel</Text></Button></DialogFooter>
        </> : <DialogTitle className="sr-only">{title}</DialogTitle>}
        {kind === 'discount' ? <DiscountForm title="Order discount" currency={sale.order.currency}
          onApply={(discount) => sale.applyDiscount(null, discount)} onClose={close} />
          : kind !== null && kind !== 'coupon' && <ChargeForm kind={kind} currency={sale.order.currency} lineTax={sale.capabilities?.lineTax}
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
