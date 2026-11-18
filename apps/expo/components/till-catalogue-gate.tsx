import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Pressable, View } from 'react-native';
import { AppText as Text } from './app-text';
import { Stack } from 'expo-router';

import { StoreSettingsChoiceScreen } from '@tallyui/components';
import { SignInError, type ServerCapabilities, type StoreSettings as PricingSettings, type SyncContext, type TallyConnector } from '@tallyui/core';
import { TaxProvider, taxProviderProps, useStoreSettings, withPricingContext } from '@tallyui/pos';

import { EarlierSaleNote } from './earlier-sale-note';
import { demoTillChoice, isDemoAccount } from '../lib/demo';
import { authHeaders, createPosConnector } from '../lib/pos-connector';
import { defaultStorage, type Session } from '../lib/session';
import {
  clearSettingsRegion, fetchStoreSettings, loadCachedPricing, loadCachedSettings, loadSettingsChoice, saveCachedPricing,
  saveCachedSettings, saveSettingsChoice, StoreSettingsError, type StoreSettings,
} from '../lib/store-settings';

// TallyUI #339/#341, use-store-settings.ts:48: unknown tax rounding retries until settings resolve.
const SETTINGS_RETRYING = "Can't reach the store's settings yet. Retrying…";
// The till setup screen: its navigation header and its own title say the same words.
const TILL_SETUP_TITLE = 'Set up this till';

type SignedInProps = { session: Session; signOut: () => void; onUnauthorized: () => void; onNoPosAccess: () => void;
  onCapabilities: (fresh: ServerCapabilities | undefined) => void };

type PricingProps = SignedInProps & { connector: TallyConnector; settings: StoreSettings; settingsStatus: string | null };

/** What the gate renders inside the store's TaxProvider: the Sale, or the Products area's own catalogue read. */
export type TillCatalogueLeafProps = PricingProps & {
  pricing: PricingSettings; syncContext: SyncContext; onRetry?: () => void; onBusy: (busy: boolean) => void;
};

type GateProps = SignedInProps & { Leaf: ComponentType<TillCatalogueLeafProps> };

export function StoreSettingsGate(props: GateProps) {
  const { session, onUnauthorized, onNoPosAccess, onCapabilities } = props;
  const [connector] = useState(createPosConnector);
  // Once per store (this screen is keyed by it): re-read the order.create capability a restored session was saved with (ADR-062).
  useEffect(() => {
    let active = true;
    connector.capabilities?.({ connectorId: connector.id, baseUrl: session.baseUrl, headers: authHeaders(session.token) })
      .then((fresh) => { if (active) onCapabilities(fresh); })
      .catch((error: unknown) => { if (active && error instanceof SignInError && error.code === 'invalid_credentials') onUnauthorized(); });
    return () => { active = false; };
  }, [session.baseUrl, onCapabilities, onUnauthorized]);
  const [settings, setSettings] = useState(() => loadCachedSettings(defaultStorage(), session.baseUrl));
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void fetchStoreSettings(session).then((next) => {
      if (!active) return;
      saveCachedSettings(defaultStorage(), session.baseUrl, next);
      setSettings(next);
      setOffline(false);
    }).catch((error: Error) => {
      if (!active) return;
      if (error instanceof StoreSettingsError && error.code === 'unauthorized') onUnauthorized();
      else if (error instanceof StoreSettingsError && error.code === 'forbidden') onNoPosAccess();
      else {
        setError(error.message);
        setOffline(error instanceof StoreSettingsError && error.code === 'unreachable');
      }
    });
    return () => { active = false; };
  }, [session, onUnauthorized, onNoPosAccess, attempt]);
  if (!settings) return <SettingsMessage text={error ?? 'Loading store settings…'} actions={error ? { Retry: () => setAttempt(attempt + 1) } : {}} />;
  return <PricingScreen {...props} connector={connector} settings={settings} settingsStatus={offline ? 'Offline' : error} />;
}

function SettingsMessage({ text, actions }: { text: string; actions: Record<string, () => void> }) {
  const buttons = Object.entries(actions);
  return <>
    <EarlierSaleNote />
    <View dataSet={{ print: 'hide' }} className="flex-1 items-center justify-center gap-4">
      <Text className={buttons.length ? 'text-destructive' : 'text-muted-foreground'}>{text}</Text>
      {buttons.map(([label, onPress]) => <Pressable key={label} accessibilityRole="button" onPress={onPress} className="rounded-md border border-border bg-card px-4 py-3"><Text className="text-center text-foreground">{label}</Text></Pressable>)}
    </View>
  </>;
}

// TallyUI's store settings (TV4) price and tax every sale the way Medusa charges in the till's region.
function PricingScreen({ Leaf, ...props }: PricingProps & { Leaf: ComponentType<TillCatalogueLeafProps> }) {
  const { session, settings, connector } = props;
  const token = useRef(session.token);
  token.current = session.token;
  const [attempt, setAttempt] = useState(0);
  // D1: the plugin taxes each order by the stock location's address, so the till's country is always its country.
  const country = settings.location.countryCode.toLowerCase();
  // Read per request (as the outbox's transport), so a token refresh keeps this identity and never re-resolves; a new country does.
  // The capability is a value dependency: only a new order.create version makes a new context, never a new session object.
  const orderCreate = session.capabilities?.orderCreate;
  const context = useMemo<SyncContext>(() => ({ connectorId: connector.id, baseUrl: session.baseUrl,
    headers: { get Authorization() { return authHeaders(token.current).Authorization; } },
    ...(orderCreate === undefined ? {} : { capabilities: { orderCreate } }) }), [session.baseUrl, attempt, country, orderCreate]);
  const store = useStoreSettings({
    connector, context, loadChoice: () => ({ ...loadSettingsChoice(defaultStorage(), session.baseUrl), country }),
    saveChoice: (choice) => saveSettingsChoice(defaultStorage(), session.baseUrl, choice),
    onSaveError: (error) => console.warn('Could not save the till\'s store settings choice:', error),
  });
  // A Retry never unmounts the POS or ends its sale (a money rule): the POS keeps the settings it shows (the same
  // object, so the tax context and replication stay) while a retry loads or fails, and until it resolves to new ones.
  const shown = useRef<{ pricing: PricingSettings; syncContext: SyncContext } | null>(null);
  const pricing = useMemo(() => {
    const previous = shown.current?.pricing ?? null;
    if (store.state === 'ready') return previous && JSON.stringify(previous) === JSON.stringify(store.settings) ? previous : store.settings;
    if (store.state === 'error') return previous ?? loadCachedPricing(defaultStorage(), session.baseUrl);
    return store.state === 'loading' ? previous : null;
  }, [store, session.baseUrl]);
  useEffect(() => { if (store.state === 'ready') saveCachedPricing(defaultStorage(), session.baseUrl, store.settings); }, [store, session.baseUrl]);
  const live = useMemo(() => pricing && { pricing, syncContext: withPricingContext(context, pricing) }, [context, pricing]);
  // A sale in progress keeps the POS on what it shows (prices, tax, catalogue, currency; a money rule): new
  // settings, and the choose, unsupported or error screens, wait until the sale is idle.
  const [busy, setBusy] = useState(false);
  const held = busy && shown.current !== null;
  if (!held) shown.current = live;
  const regionNames = useRef(new Map<string, string>());
  const again = () => setAttempt(attempt + 1);
  const demoChosen = useRef(false);
  const autoChooseDemo = store.state === 'choose' && !held && !demoChosen.current && isDemoAccount(session.email)
    && (!store.choices.countries || store.choices.countries.includes(country));
  useEffect(() => {
    if (!autoChooseDemo || demoChosen.current || store.state !== 'choose') return;
    demoChosen.current = true;
    store.choose({ ...demoTillChoice(store.choices, store.initial), country });
  }, [autoChooseDemo, store, country]);

  if (store.state === 'choose' && !held) {
    for (const region of store.choices.regions ?? []) regionNames.current.set(region.id, region.name);
    const { countries, ...choices } = store.choices;
    if (countries && !countries.includes(country)) {
      // No region in the choice: Medusa's default region, which wins again after any pick, so only Retry.
      const region = store.initial?.region;
      return <SettingsMessage text={`Stock location ${settings.location.name} is in ${country.toUpperCase()}, which ${region ? `region ${regionNames.current.get(region) ?? region}` : 'the store\'s default region'} does not cover.`}
        actions={region ? { Retry: again, 'Choose another region': () => { clearSettingsRegion(defaultStorage(), session.baseUrl); again(); } } : { Retry: again }} />;
    }
    if (autoChooseDemo) return <SettingsMessage text="Setting up the demo till…" actions={{}} />;
    return <><Stack.Screen options={{ title: TILL_SETUP_TITLE }} /><EarlierSaleNote />
      <StoreSettingsChoiceScreen choices={choices} initial={store.initial} title={TILL_SETUP_TITLE}
      onSubmit={(choice) => store.choose({ ...choice, country })} /></>;
  }
  if (store.state === 'unsupported' && !held) return <SettingsMessage text="This backend can't supply store settings" actions={{ Retry: again }} />;
  const pos = shown.current;
  if (store.state === 'error' && !pos) return <SettingsMessage text={store.nextRetryAt !== undefined ? SETTINGS_RETRYING
    : store.error instanceof Error ? store.error.message : String(store.error)} actions={{ Retry: store.retry }} />;
  if (!pos) return <SettingsMessage text="Loading store settings…" actions={{}} />;
  return <TaxProvider {...taxProviderProps(pos.pricing)}>
    <Leaf {...props} pricing={pos.pricing} syncContext={pos.syncContext} onBusy={setBusy}
      settingsStatus={props.settingsStatus ?? (store.state === 'error' ? 'Offline'
        : store.state === 'choose' || store.state === 'unsupported' ? 'Store settings changed; this applies after the current sale' : null)} onRetry={store.state === 'error' ? store.retry : undefined} />
  </TaxProvider>;
}
