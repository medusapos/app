import { useEffect, useState } from 'react';
import type { ScannerConnectionType, ScannerProfile, ScannerProfileStore } from '@tallyui/pos';
import type { SessionStorage } from './session';

// The directly connected scanners this device knows (Settings > Scanner > Direct connection). Device-local like
// WCPOS v2's `scanner_profiles`: one device-wide key, never replicated, never an RxDB collection.
const KEY = 'medusapos.scanner-profiles';
const CONNECTION_TYPES: readonly ScannerConnectionType[] = ['keyboard', 'usb-serial', 'bluetooth-spp', 'bluetooth-le', 'hid-pos'];
const isProfile = (v: unknown): v is ScannerProfile => typeof v === 'object' && v !== null
  && typeof (v as ScannerProfile).deviceKey === 'string'
  && CONNECTION_TYPES.includes((v as ScannerProfile).connectionType);

/** Tolerates a missing or corrupt value: anything that is not a profile is dropped. */
export function loadScannerProfiles(storage: SessionStorage | null): ScannerProfile[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(isProfile) : [];
  } catch { return []; }
}

// Every mounted useScannerProfiles in this tab, so a save (from a controller) or a forget re-renders them all.
const listeners = new Set<() => void>();
function write(storage: SessionStorage | null, profiles: ScannerProfile[]): void {
  storage?.setItem(KEY, JSON.stringify(profiles));
  listeners.forEach((listener) => listener());
}

/** TallyUI's ScannerProfileStore over this device's key: `save` upserts on deviceKey, never adding a twin. */
export function scannerProfileStoreFor(storage: SessionStorage | null): ScannerProfileStore {
  return {
    read: async (types) => loadScannerProfiles(storage).filter((profile) => types.length === 0 || types.includes(profile.connectionType)),
    save: async (profile) => {
      const profiles = loadScannerProfiles(storage), at = profiles.findIndex((p) => p.deviceKey === profile.deviceKey);
      write(storage, at === -1 ? [...profiles, profile] : profiles.map((p, i) => (i === at ? profile : p)));
    },
  };
}

/** Named apart from TallyUI's `removeScannerProfile` (the RxDB one). */
export function forgetScannerProfile(storage: SessionStorage | null, deviceKey: string): void {
  write(storage, loadScannerProfiles(storage).filter((profile) => profile.deviceKey !== deviceKey));
}

/** The saved profiles, live. */
export function useScannerProfiles(storage: SessionStorage | null): ScannerProfile[] {
  const [profiles, setProfiles] = useState(() => loadScannerProfiles(storage));
  useEffect(() => {
    const reload = () => setProfiles(loadScannerProfiles(storage));
    reload(); listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage]);
  return profiles;
}
