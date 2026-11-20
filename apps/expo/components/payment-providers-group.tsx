import { useEffect, useState } from 'react';
import { SettingsGroup, SettingsRow, Text } from '@tallyui/components';
import { fetchPaymentProviders, type PaymentProvider } from '../lib/payment-providers';
import type { Session } from '../lib/session';

// v2's Settings › Card readers lists the store's readers; on Medusa that is the store's payment providers.
export function PaymentProvidersGroup({ session }: { session: Session }) {
  const [providers, setProviders] = useState<PaymentProvider[] | null>(null);
  useEffect(() => {
    let mounted = true;
    fetchPaymentProviders(session).then((result) => { if (mounted) setProviders(result); });
    return () => { mounted = false; };
  }, [session.baseUrl, session.token]);
  if (!providers?.length) return null;
  return <SettingsGroup title="Payment providers" testID="settings-payment-providers" description="The store's payment providers in Medusa. Read-only.">
    {providers.map((provider, index) => <SettingsRow key={provider.id} label={provider.name} testID={`settings-payment-provider-${provider.id}`}
      className={index > 0 ? 'border-t border-border' : undefined} action={
        <Text testID={`settings-payment-provider-${provider.id}-state`}
          className={`max-w-40 text-right text-sm ${provider.tillCanTake ? 'text-foreground' : 'text-muted-foreground'}`}>
          {provider.tillCanTake ? 'Taken at this till' : 'Not at this till'}
        </Text>
      } />)}
  </SettingsGroup>;
}
