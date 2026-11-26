import { Text } from '@tallyui/components';
import { SettingsGroup, SettingsRow } from '../lib/settings-layout';
import type { PaymentProvider } from '../lib/payment-providers';

// The till region's payment providers that are not card readers; Card readers lists the terminal ones above it.
export function PaymentProvidersGroup({ providers }: { providers: PaymentProvider[] }) {
  const listed = providers.filter((provider) => provider.terminal === false);
  if (!listed.length) return null;
  return <SettingsGroup title="Payment providers" testID="settings-payment-providers" description="The store's payment providers in Medusa. Read-only.">
    {listed.map((provider, index) => <SettingsRow key={provider.id} label={provider.name} testID={`settings-payment-provider-${provider.id}`}
      divider={index > 0} action={
        <Text testID={`settings-payment-provider-${provider.id}-state`}
          className={`max-w-40 text-right text-sm ${provider.tillCanTake ? 'text-foreground' : 'text-muted-foreground'}`}>
          {provider.tillCanTake ? 'Taken at this till' : 'Not at this till'}
        </Text>
      } />)}
  </SettingsGroup>;
}
