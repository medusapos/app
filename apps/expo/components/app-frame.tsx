// v2's app frame, from TallyUI's NavRail and NavDrawer: the icon rail beside every signed-in area on a wide window, a
// slide-over drawer opened from the header's menu button on a phone. Not TallyUI's AppShell: its menu state is read
// only by TallyUI's RegisterBar (an unexported hook), which would add a second menu button to the register bar.
// Navigation is modelled on the Tally Woo app's rail-routes.ts: the stack stays at most Sale plus one area.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { router, usePathname, type Href } from 'expo-router';
import { Circle, Line, Path, Rect } from 'react-native-svg';
import { createSvgIcon, IconButton, NavDrawer, NavRail, Text, type ShellNavItem } from '@tallyui/components';
import { version as appVersion } from '../package.json';
import { AccountButton } from './account-button';

// TallyUI's one layout boundary (AppShell's WIDE_MIN_WIDTH / WIDE_MIN_HEIGHT, @tallyui/components 3.18.0
// src/shell/app-shell.tsx l.16-17): at least 768 wide AND 480 tall gets the rail, anything smaller the drawer.
const WIDE_MIN_WIDTH = 768;
const WIDE_MIN_HEIGHT = 480;

const CartIcon = createSvgIcon('CartIcon', () => <><Circle cx={6} cy={19} r={2} /><Circle cx={17} cy={19} r={2} />
  <Path d="M17 17H6V3H4" /><Path d="M6 5l14 1-1 7H6" /></>);
// v2's Products glyph, tabler's `gift`.
const GiftIcon = createSvgIcon('GiftIcon', () => <><Path d="M3 8m0 1a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1z" />
  <Path d="M12 8l0 13" /><Path d="M19 12v7a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-7" />
  <Path d="M7.5 8a2.5 2.5 0 0 1 0 -5a4.8 8 0 0 1 4.5 5a4.8 8 0 0 1 4.5 -5a2.5 2.5 0 0 1 0 5" /></>);
const ReceiptIcon = createSvgIcon('ReceiptIcon', () => <><Path d="M6 2h12v20l-3-2-3 2-3-2-3 2z" />
  <Line x1={9} y1={7} x2={15} y2={7} /><Line x1={9} y1={11} x2={15} y2={11} /><Line x1={9} y1={15} x2={13} y2={15} /></>);
const UsersIcon = createSvgIcon('UsersIcon', () => <><Path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
  <Path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" />
  <Path d="M16 3.13a4 4 0 0 1 0 7.75" /><Path d="M21 21v-2a4 4 0 0 0 -3 -3.85" /></>);
const ChartIcon = createSvgIcon('ChartIcon', () => <><Line x1={4} y1={20} x2={20} y2={20} /><Rect x={5} y={11} width={3} height={6} />
  <Rect x={10.5} y={6} width={3} height={11} /><Rect x={16} y={9} width={3} height={8} /></>);
// v2's `settings` glyph (tabler), as the Woo app's rail draws it.
const GearIcon = createSvgIcon('GearIcon', () => <><Path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.065" /><Path d="M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0" /></>);
// TallyUI draws this glyph for RegisterBar's menu button but does not export it.
const MenuIcon = createSvgIcon('MenuIcon', () => <><Line x1={4} y1={6} x2={20} y2={6} /><Line x1={4} y1={12} x2={20} y2={12} />
  <Line x1={4} y1={18} x2={20} y2={18} /></>);

export const FRAME_AREAS = [
  // v2's menu labels its first entry "POS" (docs/v2-parity/demo-shots/17-menu-demo-phone.jpg).
  { id: 'sale', label: 'POS', href: '/', Icon: CartIcon },
  { id: 'products', label: 'Products', href: '/products', Icon: GiftIcon },
  { id: 'orders', label: 'Orders', href: '/orders', Icon: ReceiptIcon },
  { id: 'customers', label: 'Customers', href: '/customers', Icon: UsersIcon },
  { id: 'reports', label: 'Reports', href: '/reports', Icon: ChartIcon },
  { id: 'settings', label: 'Settings', href: '/settings', Icon: GearIcon, group: 'bottom' },
] as const;
export type FrameAreaId = (typeof FRAME_AREAS)[number]['id'];
const hrefOf = (id: FrameAreaId) => FRAME_AREAS.find((area) => area.id === id)!.href;

/** The area a pathname is, or null off the six areas (/login, /demo). */
export function frameAreaFor(pathname: string): FrameAreaId | null {
  return FRAME_AREAS.find((area) => area.href === pathname)?.id ?? null;
}

/**
 * null when from === to; back to the sale dismisses to it (keeping its sale; with no sale under the area, opened by
 * URL, dismissTo replaces); from the sale an area is pushed over it; an area replaces an area, so Back never cycles.
 */
export function frameStep(from: FrameAreaId, to: FrameAreaId): { method: 'push' | 'replace' | 'dismissTo'; href: string } | null {
  if (from === to) return null;
  if (to === 'sale') return { method: 'dismissTo', href: '/' };
  return { method: from === 'sale' ? 'push' : 'replace', href: hrefOf(to) };
}

/** The Sale's account: the avatar's name and initials, and how to open the Sale's user sheet from an area. */
export type FrameAccount = { displayName: string; initials: string; open: () => void };
type FrameState = {
  openMenu?: () => void; setBadge: (id: FrameAreaId, count: number) => void;
  account: FrameAccount | null; setAccount: (account: FrameAccount | null) => void;
};
const FrameContext = createContext<FrameState>({ setBadge: () => {}, account: null, setAccount: () => {} });

/** Opens the phone's drawer; undefined on a wide window and off the frame. */
export function useFrameMenu(): (() => void) | undefined {
  return useContext(FrameContext).openMenu;
}

/** Publishes an area's badge count to the frame (cleared on unmount). */
export function useFrameBadge(id: FrameAreaId, count: number) {
  const { setBadge } = useContext(FrameContext);
  useEffect(() => setBadge(id, count), [setBadge, id, count]);
  useEffect(() => () => setBadge(id, 0), [setBadge, id]);
}

/** The Sale publishes its account to the frame (cleared on unmount); `open` is read through a ref, so it may change. */
export function useFrameAccountPublisher(account: FrameAccount | null) {
  const { setAccount } = useContext(FrameContext);
  const openRef = useRef(account?.open);
  openRef.current = account?.open;
  const open = useCallback(() => openRef.current?.(), []);
  const { displayName, initials } = account ?? {};
  const published = !!account;
  useEffect(() => setAccount(published ? { displayName: displayName!, initials: initials!, open } : null),
    [setAccount, published, displayName, initials, open]);
  useEffect(() => () => setAccount(null), [setAccount]);
}

/** The Sale's account, or null with no Sale under the area, off the frame or signed out. */
export function useFrameAccount(): FrameAccount | null {
  return useContext(FrameContext).account;
}

/** An area's account avatar, opening the Sale's user sheet; nothing when there is no Sale under the area. */
export function AreaAccountButton() {
  const account = useFrameAccount();
  if (!account) return null;
  return <AccountButton testID="area-user-menu" displayName={account.displayName} initials={account.initials} onPress={account.open} />;
}

/** An area header's headerLeft: the drawer's 44 px menu button on a phone, nothing on a wide window. */
export function FrameMenuButton() {
  const openMenu = useFrameMenu();
  if (!openMenu) return null;
  return <IconButton testID="frame-menu" accessibilityLabel="Menu" onPress={openMenu} className="ml-1 h-11 w-11">
    <View className="text-foreground"><MenuIcon size={24} /></View>
  </IconButton>;
}

export function AppFrame({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const { width, height } = useWindowDimensions();
  const wide = width >= WIDE_MIN_WIDTH && height >= WIDE_MIN_HEIGHT;
  const active = signedIn ? frameAreaFor(pathname) : null;
  const [menuOpen, setMenuOpen] = useState(false);
  // Widening past the boundary swaps the drawer for the rail; it must not reopen on the next shrink (as AppShell).
  if ((wide || !active) && menuOpen) setMenuOpen(false);
  const [badges, setBadges] = useState<Partial<Record<FrameAreaId, number>>>({});
  const setBadge = useCallback((id: FrameAreaId, count: number) =>
    setBadges((prev) => (prev[id] ?? 0) === count ? prev : { ...prev, [id]: count }), []);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const [account, setAccount] = useState<FrameAccount | null>(null);
  const state = useMemo(() => ({ setBadge, openMenu: active && !wide ? openMenu : undefined,
    account: signedIn ? account : null, setAccount }), [setBadge, openMenu, active, wide, signedIn, account]);
  const items: ShellNavItem[] = FRAME_AREAS.map(({ id, label, Icon, ...area }) => ({
    id, label, icon: <Icon size={24} />, badge: badges[id] || undefined, group: 'group' in area ? area.group : 'top',
  }));
  const navigate = (to: string) => {
    const step = active && frameStep(active, to as FrameAreaId);
    if (step) router[step.method](step.href as Href);
  };
  // One tree whether or not the frame shows, so signing in or out never remounts the Stack under it.
  return <FrameContext.Provider value={state}>
    <View testID={active ? 'app-frame' : undefined} className="flex-1 flex-row bg-background">
      {active && wide ? (
        // The version sits under the rail because TallyUI's NavRail has no footer slot (v2 shows it at the rail's foot).
        <View testID="frame-rail" className="z-10 w-16 border-r border-border bg-card">
          <NavRail items={items} activeId={active} onNavigate={navigate} className="flex-1 border-r-0 bg-transparent" />
          <Text testID="frame-version" className="text-xs text-muted-foreground text-center pb-3" numberOfLines={1}>
            {`v ${appVersion}`}
          </Text>
        </View>
      ) : null}
      <View className="min-w-0 flex-1">{children}</View>
      {/* v2's phone drawer starts on its POS row; the phone header names the store and register (DEMO-PARITY row 17b). */}
      {active && !wide ? <NavDrawer open={menuOpen} onOpenChange={setMenuOpen} items={items} activeId={active}
        onNavigate={navigate} /> : null}
    </View>
  </FrameContext.Provider>;
}
