// v2's app frame, from TallyUI's NavRail and NavDrawer: the icon rail beside every signed-in area on a wide window, a
// slide-over drawer opened from the header's menu button on a phone. Not TallyUI's AppShell: its menu state is read
// only by TallyUI's RegisterBar (an unexported hook), which would add a second menu button to the register bar.
// Navigation is modelled on the Tally Woo app's rail-routes.ts: the stack stays at most Sale plus one area.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { router, usePathname, type Href } from 'expo-router';
import { Circle, Line, Path, Rect } from 'react-native-svg';
import { createSvgIcon, IconButton, NavDrawer, NavRail, type ShellNavItem } from '@tallyui/components';

// TallyUI's one layout boundary (AppShell's WIDE_MIN_WIDTH / WIDE_MIN_HEIGHT, @tallyui/components 3.18.0
// src/shell/app-shell.tsx l.16-17): at least 768 wide AND 480 tall gets the rail, anything smaller the drawer.
const WIDE_MIN_WIDTH = 768;
const WIDE_MIN_HEIGHT = 480;

const CartIcon = createSvgIcon('CartIcon', () => <><Circle cx={6} cy={19} r={2} /><Circle cx={17} cy={19} r={2} />
  <Path d="M17 17H6V3H4" /><Path d="M6 5l14 1-1 7H6" /></>);
const ReceiptIcon = createSvgIcon('ReceiptIcon', () => <><Path d="M6 2h12v20l-3-2-3 2-3-2-3 2z" />
  <Line x1={9} y1={7} x2={15} y2={7} /><Line x1={9} y1={11} x2={15} y2={11} /><Line x1={9} y1={15} x2={13} y2={15} /></>);
const ChartIcon = createSvgIcon('ChartIcon', () => <><Line x1={4} y1={20} x2={20} y2={20} /><Rect x={5} y={11} width={3} height={6} />
  <Rect x={10.5} y={6} width={3} height={11} /><Rect x={16} y={9} width={3} height={8} /></>);
// v2's `settings` glyph (tabler), as the Woo app's rail draws it.
const GearIcon = createSvgIcon('GearIcon', () => <><Path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.065" /><Path d="M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0" /></>);
// TallyUI draws this glyph for RegisterBar's menu button but does not export it.
const MenuIcon = createSvgIcon('MenuIcon', () => <><Line x1={4} y1={6} x2={20} y2={6} /><Line x1={4} y1={12} x2={20} y2={12} />
  <Line x1={4} y1={18} x2={20} y2={18} /></>);

export const FRAME_AREAS = [
  { id: 'sale', label: 'Sale', href: '/', Icon: CartIcon },
  { id: 'orders', label: 'Orders', href: '/orders', Icon: ReceiptIcon },
  { id: 'reports', label: 'Reports', href: '/reports', Icon: ChartIcon },
  { id: 'settings', label: 'Settings', href: '/settings', Icon: GearIcon, group: 'bottom' },
] as const;
export type FrameAreaId = (typeof FRAME_AREAS)[number]['id'];
const hrefOf = (id: FrameAreaId) => FRAME_AREAS.find((area) => area.id === id)!.href;

/** The area a pathname is, or null off the four areas (/login, /demo). */
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

type FrameState = { openMenu?: () => void; setBadge: (id: FrameAreaId, count: number) => void };
const FrameContext = createContext<FrameState>({ setBadge: () => {} });

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
  const state = useMemo(() => ({ setBadge, openMenu: active && !wide ? openMenu : undefined }), [setBadge, openMenu, active, wide]);
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
      {active && wide ? <NavRail items={items} activeId={active} onNavigate={navigate} /> : null}
      <View className="min-w-0 flex-1">{children}</View>
      {active && !wide ? <NavDrawer open={menuOpen} onOpenChange={setMenuOpen} items={items} activeId={active}
        onNavigate={navigate} /> : null}
    </View>
  </FrameContext.Provider>;
}
