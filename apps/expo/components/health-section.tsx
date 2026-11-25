import { useEffect, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { summarizeOutboxHealth, type LogEntry } from '@tallyui/pos';
import { Button, Text as TallyText } from '@tallyui/components';
import { AppText as Text } from './app-text';
import { version as appVersion } from '../package.json';
import { formatLogLine, recentLogs, subscribeRecentLogs } from '../lib/logging';
import { useOutboxContext } from '../lib/outbox-context';
import { readPluginContractVersion } from '../lib/plugin-contract';
import { useRegister } from '../lib/register-context';
import type { Session } from '../lib/session';
import { SettingsGroup, SettingsRow } from '../lib/settings-layout';
import { formatBytes, storageUsageBytes } from '../lib/storage-usage';

function Value({ testID, children }: { testID: string; children: string | number }) {
  return <Text testID={testID} className="text-sm text-foreground">{String(children)}</Text>;
}

// The line without its data part: the list stays one line per entry; Copy logs carries the data.
const shortLine = (entry: LogEntry) => formatLogLine({ ...entry, data: undefined });

async function copyText(text: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (!globalThis.navigator?.clipboard?.writeText) throw new Error('No clipboard');
    await globalThis.navigator.clipboard.writeText(text);
  } else {
    await Share.share({ message: text });
  }
}

/** Settings › Health: what this till talks to, what it holds and waits to send, and its recent warnings and errors. Read only. */
export function HealthSection({ session }: { session: Session }) {
  const { state: sales } = useOutboxContext();
  const { registerOutbox } = useRegister();
  const health = summarizeOutboxHealth(sales, registerOutbox.state);
  const [contract, setContract] = useState<number | null>(null);
  const [storage, setStorage] = useState<number | null>(null);
  const [logs, setLogs] = useState(recentLogs);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readPluginContractVersion(session).then((version) => { if (live) setContract(version); });
    void storageUsageBytes().then((bytes) => { if (live) setStorage(bytes); });
    return () => { live = false; };
  }, [session]);
  useEffect(() => {
    setLogs(recentLogs());
    return subscribeRecentLogs(() => setLogs(recentLogs()));
  }, []);
  const onCopy = () => {
    setCopyStatus(null);
    copyText(logs.map(formatLogLine).join('\n')).then(() => setCopyStatus('Copied'), () => setCopyStatus('Could not copy'));
  };
  return <>
    <SettingsGroup title="Store connection" description="Read-only." testID="settings-health">
      <SettingsRow label="Store URL" action={<Value testID="settings-health-store-url">{session.baseUrl}</Value>} />
      <SettingsRow label="Plugin contract" divider
        action={<Value testID="settings-health-plugin-contract">{contract ?? 'Unknown'}</Value>} />
      <SettingsRow label="App version" divider action={<Value testID="settings-health-app-version">{appVersion}</Value>} />
    </SettingsGroup>
    <SettingsGroup title="This device"
      description="Sales keep working when the store cannot be reached; waiting changes send when it can.">
      <SettingsRow label="Storage used" action={<Value testID="settings-health-storage">{formatBytes(storage)}</Value>} />
      <SettingsRow label="Sales waiting to send" divider
        action={<Value testID="settings-health-sales-pending">{health.sales.pending}</Value>} />
      <SettingsRow label="Till updates waiting to send" divider
        action={<Value testID="settings-health-till-pending">{health.tillUpdates.pending}</Value>} />
      <SettingsRow label="Need attention" divider action={<Value testID="settings-health-attention">{health.attention}</Value>} />
    </SettingsGroup>
    <SettingsGroup title="Logs" description="Warnings and errors since the app started. Kept in memory on this device only.">
      <View className="gap-3 px-4 py-3">
        {logs.length === 0
          ? <Text testID="settings-health-logs-empty" className="text-sm text-muted-foreground">No warnings or errors since the app started.</Text>
          : <View className="gap-1">
            {[...logs].reverse().map((entry, index) => <Text key={`${entry.timestamp}-${logs.length - index}`} testID="settings-health-log-line"
              className={`text-sm ${entry.level === 'error' ? 'text-destructive' : 'text-foreground'}`}>{shortLine(entry)}</Text>)}
          </View>}
        <View className="flex-row items-center gap-3">
          <Button variant="outline" testID="settings-health-copy" className="min-h-11" disabled={logs.length === 0} onPress={onCopy}>
            <TallyText>Copy logs</TallyText>
          </Button>
          <Text testID="settings-health-copy-status" accessibilityLiveRegion="polite" aria-live="polite"
            className="text-sm text-muted-foreground">{copyStatus ?? ''}</Text>
        </View>
      </View>
    </SettingsGroup>
  </>;
}
