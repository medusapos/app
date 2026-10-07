import { useState } from 'react';
import { View } from 'react-native';
import { Button, Text } from '@tallyui/components';
import { RegisterSessionRequiredError } from '@tallyui/pos';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';

/** Resolve a refused register open without treating the conflict as a sale session (ADR-078). */
export function RegisterConflictCard() {
  const { register: { conflict, actions }, unbind } = useRegister();
  const { session } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: 'takeOver' | 'chooseAnotherRegister') => {
    setBusy(true);
    setError('');
    try {
      await actions[action]();
      if (action === 'chooseAnotherRegister') await unbind();
    } catch (error) {
      setError(error instanceof RegisterSessionRequiredError ? 'The register changed. Try again.'
        : error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return <View testID="register-conflict-card" className="bg-card gap-3 rounded-md p-4">
    <Text className="text-lg font-semibold">This register is open on another till.</Text>
    {conflict?.openedBy ? <Text>{conflict.openedBy}</Text> : null}
    {conflict?.deviceName ? <Text>{conflict.deviceName}</Text> : null}
    {error ? <Text accessibilityRole="alert" className="text-destructive">{error}</Text> : null}
    {conflict?.takingOver ? <Text testID="register-conflict-waiting">Taking over… waiting for the store</Text> : <>
      {(session?.capabilities?.register ?? 0) >= 2 ?
        <Button testID="register-conflict-take-over" className="min-h-11" disabled={busy} onPress={() => { void run('takeOver'); }}>
          <Text>Take over</Text>
        </Button> : null}
      <Button testID="register-conflict-choose" variant="outline" className="min-h-11" disabled={busy}
        onPress={() => { void run('chooseAnotherRegister'); }}>
        <Text>Choose another register</Text>
      </Button>
    </>}
  </View>;
}
