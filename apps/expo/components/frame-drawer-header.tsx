import { View } from 'react-native';
import { Text } from '@tallyui/components';
import { useSession } from '../lib/session-context';
import { useRegister } from '../lib/register-context';
import { defaultStorage } from '../lib/session';
import { loadCachedSettings } from '../lib/store-settings';

export function registerStateLabel(status: string | null | undefined): 'Open' | 'Counting' | 'Closed' {
  return status === 'open' ? 'Open' : status === 'counting' ? 'Counting' : 'Closed';
}

// v2's title bar names the store and register: "US Store · Front Counter" (row 14a).
export function storeRegisterTitle(storeName: string, boundRegisterId: string | null | undefined, registerName: string | null): string {
  return typeof boundRegisterId === 'string' ? `${storeName} · ${registerName ?? 'Register'}` : storeName;
}

export function FrameDrawerHeader() {
  const { session } = useSession();
  const { register, boundRegisterId, registerName } = useRegister();
  if (!session) return null;
  const storeName = loadCachedSettings(defaultStorage(), session.baseUrl)?.storeName;
  return <View testID="frame-drawer-header" className="gap-1 border-b border-border px-4 pb-3 pt-4">
    <Text testID="frame-drawer-store" numberOfLines={1} className="font-semibold text-foreground">
      {storeName?.trim() ? storeName : new URL(session.baseUrl).host}
    </Text>
    {boundRegisterId !== undefined && <Text testID="frame-drawer-register" numberOfLines={1} className="text-sm text-muted-foreground">
      {boundRegisterId === null ? 'No register chosen' : `${registerName ?? 'Register'} · ${registerStateLabel(register.session?.status)}`}
    </Text>}
  </View>;
}
