import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Circle, Line, Path } from 'react-native-svg';
import { formatMoney } from '@tallyui/core';
import type { useSale } from '@tallyui/pos';
import { Portal } from '@tallyui/primitives';
import {
  Button, ChargeForm, createSvgIcon, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DiscountForm, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, Text,
} from '@tallyui/components';
import { CouponCodeInput, couponsEnabled, useCouponEntry } from './coupon-field';
import type { StoreCoupon } from '../lib/store-coupons';

const PlusIcon = createSvgIcon('PlusIcon', () => <><Line x1={12} y1={5} x2={12} y2={19} /><Line x1={5} y1={12} x2={19} y2={12} /></>);
// lucide user-plus
const UserPlusIcon = createSvgIcon('UserPlusIcon', () => <><Path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><Circle cx={9} cy={7} r={4} />
  <Line x1={19} y1={8} x2={19} y2={14} /><Line x1={22} y1={11} x2={16} y2={11} /></>);
// lucide box
const BoxIcon = createSvgIcon('BoxIcon', () => <><Path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
  <Path d="m3.3 7 8.7 5 8.7-5" /><Path d="M12 22V12" /></>);
// lucide receipt-text
const ReceiptIcon = createSvgIcon('ReceiptIcon', () => <><Path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
  <Path d="M14 8H8" /><Path d="M16 12H8" /><Path d="M13 16H8" /></>);
// lucide tag
const TagIcon = createSvgIcon('TagIcon', () => <><Path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
  <Circle cx={7.5} cy={7.5} r={0.5} fill="currentColor" /></>);
// lucide ticket-percent
const TicketPercentIcon = createSvgIcon('TicketPercentIcon', () => <><Path d="M2 9a3 3 0 1 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 1 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
  <Path d="M9 9h.01" /><Path d="m15 9-6 6" /><Path d="M15 15h.01" /></>);
// lucide truck
const TruckIcon = createSvgIcon('TruckIcon', () => <><Path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><Path d="M15 18H9" />
  <Path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" /><Circle cx={17} cy={18} r={2} /><Circle cx={7} cy={18} r={2} /></>);

/** The dialog's coupon entry: the inline field's own apply path, closing the dialog once a code applies. */
function CouponDialogBody({ sale, onClose }: { sale: ReturnType<typeof useSale>; onClose: () => void }) {
  const entry = useCouponEntry(sale, onClose);
  return <View className="gap-2"><CouponCodeInput entry={entry} /></View>;
}

/** v2's cart "+" menu: Add new customer, then the charges and the order discount (offered on an empty cart too). */
export function CartAddMenu({ sale, onAddCustomer, readCoupons }: { sale: ReturnType<typeof useSale>; onAddCustomer?: () => void;
  readCoupons?: () => Promise<{ coupons: StoreCoupon[]; truncated: boolean } | null> }) {
  const [kind, setKind] = useState<'custom' | 'fee' | 'discount' | 'coupon' | 'shipping' | null>(null);
  const [open, setOpen] = useState(false);
  const chargesOffered = (sale.capabilities?.orderCreate ?? 0) >= 5;
  const coupons = couponsEnabled(sale.capabilities);
  const [listed, setListed] = useState<StoreCoupon[] | null>(null);
  const opening = useRef(0);
  const close = () => { opening.current++; setKind(null); };
  const openDiscount = () => {
    const current = ++opening.current;
    setListed(null);
    setKind('discount');
    if (coupons && readCoupons) void readCoupons().catch(() => null).then(result => {
      if (opening.current === current) setListed(result?.coupons ?? null);
    });
  };
  const title = kind === 'fee' ? 'Add fee' : kind === 'shipping' ? 'Add shipping' : 'Add custom item';
  return <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {/* v2 keeps the button tinted while its menu is open. */}
        <IconButton testID="cart-add-menu" accessibilityLabel="Add to cart" dataSet={{ open: open ? 'true' : 'false' }}
          className={open ? 'bg-primary/10' : undefined}>
          <View className={open ? 'text-primary' : 'text-foreground'}><PlusIcon size={20} /></View>
        </IconButton>
      </DropdownMenuTrigger>
      {/* As in v2, a press anywhere else closes the menu and does nothing more. TU's DropdownMenuContent mounts no
          overlay, and the primitive DropdownMenu.Overlay only gets the menu's context inside the menu's own portal,
          which the content already holds. So this full-screen press catcher sits in its own root portal, added
          before the content's so the menu stays above it. Hidden from the keyboard and screen readers. */}
      {open && <Portal name="cart-add-menu-overlay">
        <Pressable testID="cart-add-menu-overlay" style={styles.overlay} onPress={() => setOpen(false)} tabIndex={-1}
          aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      </Portal>}
      <DropdownMenuContent align="end">
        {/* Greyed when customers can't be created here (no createCustomer, or offline). */}
        <DropdownMenuItem testID="cart-add-new-customer" disabled={!onAddCustomer} className={onAddCustomer ? 'gap-2' : 'gap-2 opacity-50'}
          onPress={() => onAddCustomer?.()}><View className="text-foreground"><UserPlusIcon size={16} /></View><Text>Add new customer</Text></DropdownMenuItem>
        <DropdownMenuSeparator />
        {chargesOffered && <DropdownMenuItem className="gap-2" onPress={() => setKind('custom')}>
          <View className="text-foreground"><BoxIcon size={16} /></View><Text>Add Miscellaneous Product</Text></DropdownMenuItem>}
        {chargesOffered && <DropdownMenuItem className="gap-2" onPress={() => setKind('fee')}>
          <View className="text-foreground"><ReceiptIcon size={16} /></View><Text>Add Fee</Text></DropdownMenuItem>}
        <DropdownMenuItem className="gap-2" onPress={openDiscount}>
          <View className="text-foreground"><TagIcon size={16} /></View><Text>Add Discount</Text></DropdownMenuItem>
        {/* Greyed when the till does not offer coupons: the rule that hides the inline coupon field. */}
        <DropdownMenuItem testID="cart-add-coupon" disabled={!coupons} className={coupons ? 'gap-2' : 'gap-2 opacity-50'}
          onPress={() => setKind('coupon')}><View className="text-foreground"><TicketPercentIcon size={16} /></View><Text>Add Coupon</Text></DropdownMenuItem>
        {chargesOffered && <DropdownMenuItem className="gap-2" onPress={() => setKind('shipping')}>
          <View className="text-foreground"><TruckIcon size={16} /></View><Text>Add Shipping</Text></DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={kind !== null && kind !== 'discount'} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent testID="cart-add-dialog">
        {kind === 'coupon' ? <>
          <DialogHeader><DialogTitle>Add coupon</DialogTitle></DialogHeader>
          <CouponDialogBody sale={sale} onClose={close} />
          <DialogFooter><Button variant="outline" onPress={close}><Text>Cancel</Text></Button></DialogFooter>
        </> : <DialogTitle className="sr-only">{title}</DialogTitle>}
        {kind !== null && kind !== 'coupon' && kind !== 'discount' && <ChargeForm kind={kind} currency={sale.order.currency} lineTax={sale.capabilities?.lineTax}
            shippingTaxFromStore={sale.capabilities?.taxRounding?.granularity === 'woocommerce'} onClose={close}
            onApply={({ kind, name, amountMinor, taxStatus, taxClass }) => {
              const result = kind === 'custom' ? sale.addCustomLine({ name, priceMinor: amountMinor, taxStatus, taxClass })
                : kind === 'fee' ? sale.addFee({ name, amountMinor, taxStatus, taxClass })
                  : sale.addShipping({ name, amountMinor, taxStatus, taxClass });
              return typeof result === 'string' ? result : null;
            }} />}
      </DialogContent>
    </Dialog>
    {/* Add Discount offers the Coupon tab when the store returns its list. TU's tab only picks listed codes,
        so typed codes stay on Add Coupon and the inline field. */}
    <Dialog open={kind === 'discount'} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent side="left" showClose testID="cart-add-discount-sheet">
        <DialogHeader><DialogTitle>Add Discount</DialogTitle></DialogHeader>
        <DiscountForm layout="dialog" title="Add Discount" currency={sale.order.currency}
          {...(listed !== null && { onApplyCoupon: (code: string) => sale.applyCoupon(code),
            coupons: listed.map(({ code, type, value, label, endsAt }) => ({ code,
              amountLabel: type === 'percentage' ? `${value}%` : formatMoney({ amount: value, currency: sale.order.currency }),
              detail: [label, endsAt === null ? null : `Ends ${new Date(endsAt).toLocaleDateString()}`].filter(part => part !== null).join(' · ') || undefined,
            })) })}
          onApply={(discount) => sale.applyDiscount(null, discount)} onClose={close} />
      </DialogContent>
    </Dialog>
  </>;
}

// zIndex matches the content's z-50; the content's portal comes later, so it draws on top.
const styles = StyleSheet.create({ overlay: { ...StyleSheet.absoluteFillObject, zIndex: 50 } });
