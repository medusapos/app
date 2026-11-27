import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { getLocales } from 'expo-localization';
import { createTillDevice, createTillDisplayService, createTillPairing, getDeviceId, type TillDisplayService, type TillPairing } from '@tallyui/pos';
import { displayConfigFor, displayKeyStore, hasDisplayDeviceKey, loadDisplayPaired, saveDisplayPaired } from './customer-display';
import { authHeaders, createPosConnector } from './pos-connector';
import { defaultStorage, REGISTER_ID_KEY } from './session';
import { useSession } from './session-context';
import { loadCachedSettings } from './store-settings';

const CustomerDisplayContext = createContext({ available: false, service: null as TillDisplayService | null,
  pairing: null as TillPairing | null, startPairing: (): void => {} });
export const useCustomerDisplay = () => useContext(CustomerDisplayContext);

export function CustomerDisplayProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const latest = useRef(session);
  latest.current = session;
  const baseUrl = session?.baseUrl;
  const advertisement = session?.capabilities?.customerDisplay;
  const advertised = Platform.OS === 'web' && !!advertisement;
  const connector = useMemo(() => advertised ? createPosConnector() : null, [advertised]);
  const signalling = connector?.displaySignalling;
  const available = !!signalling;
  const signature = JSON.stringify(advertisement);
  const [startedStore, setStartedStore] = useState<string>();
  const [pairedStore, setPairedStore] = useState<string>();
  useEffect(() => {
    const storage = defaultStorage();
    const paired = baseUrl !== undefined && (loadDisplayPaired(storage, baseUrl) ?? hasDisplayDeviceKey(storage, baseUrl));
    setPairedStore(paired ? baseUrl : undefined);
  }, [baseUrl]);
  const pending = useRef<string | undefined>(undefined);
  const active = available && baseUrl !== undefined && (startedStore === baseUrl || pairedStore === baseUrl);
  const [live, setLive] = useState<{ baseUrl: string; signature: string; service: TillDisplayService; pairing: TillPairing } | null>(null);

  useEffect(() => {
    if (!active || !connector || !signalling || !advertisement) { setLive(null); return; }
    const context = () => latest.current?.baseUrl === baseUrl
      ? { connectorId: connector.id, baseUrl, headers: authHeaders(latest.current.token) } : null;
    const storage = defaultStorage();
    const device = createTillDevice({ signalling, deviceId: getDeviceId(storage, REGISTER_ID_KEY), keys: displayKeyStore(storage, baseUrl) });
    const service = createTillDisplayService({ signalling, context, device, advertisement,
      configFor: (display) => displayConfigFor(display, loadCachedSettings(defaultStorage(), baseUrl), getLocales()[0]?.languageTag ?? 'en') });
    const pairing = createTillPairing({ signalling, context, device, service });
    let listed = false;
    const syncPaired = (serviceChanged = false) => {
      if (service.status !== 'online') return;
      if (serviceChanged) listed = true;
      if (!listed) return;
      const paired = service.displays.length > 0;
      if (!paired && (pairing.phase.phase !== 'idle' || pairing.phase.error !== undefined)) return;
      saveDisplayPaired(storage, baseUrl, paired);
      setPairedStore(paired ? baseUrl : undefined);
      if (!paired) setStartedStore(undefined);
    };
    const offService = service.onChange(() => syncPaired(true));
    const offPairing = pairing.onChange(syncPaired);
    setLive({ baseUrl, signature, service, pairing });
    if (pending.current === baseUrl) { pending.current = undefined; void pairing.start(); }
    return () => { offService(); offPairing(); pairing.close(); service.close(); };
  }, [active, baseUrl, signature, connector, signalling]);

  const current = active && live?.baseUrl === baseUrl && live.signature === signature ? live : null;
  function startPairing() {
    if (!available || baseUrl === undefined) return;
    setStartedStore(baseUrl);
    if (current) void current.pairing.start();
    else pending.current = baseUrl;
  }
  return <CustomerDisplayContext.Provider value={{ available, service: current?.service ?? null, pairing: current?.pairing ?? null, startPairing }}>
    {children}
  </CustomerDisplayContext.Provider>;
}
