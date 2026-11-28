import { useEffect, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { Path } from 'react-native-svg';
import { summarizeOutboxHealth, type LogEntry } from '@tallyui/pos';
import { Button, Text as TallyText, createSvgIcon } from '@tallyui/components';
import { AppText as Text } from './app-text';
import { WarningIcon } from './warning-icon';
import { version as appVersion } from '../package.json';
import { healthReadiness } from '../lib/health-readiness';
import { formatLogLine, recentLogs, subscribeRecentLogs } from '../lib/logging';
import { useOutboxContext } from '../lib/outbox-context';
import { readPluginInfoSummary } from '../lib/plugin-contract';
import { useRegister } from '../lib/register-context';
import type { Session } from '../lib/session';
import { SettingsGroup, SettingsRow } from '../lib/settings-layout';
import { formatBytes, storageUsageBytes } from '../lib/storage-usage';

const TickIcon = createSvgIcon('TickIcon', () => <Path d="M5 12l5 5l10 -10" />);
const banner = {
  checking: { title: 'Checking the store…', strip: 'border-border bg-muted', text: 'text-muted-foreground' },
  ready: { title: 'Ready to sell', strip: 'border-success bg-success/15', text: 'text-success' },
  warning: { title: 'Needs a look', strip: 'border-warning bg-warning/15', text: 'text-foreground' },
};

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
  const [plugin, setPlugin] = useState<Awaited<ReturnType<typeof readPluginInfoSummary>> | null>(null);
  const readiness = healthReadiness(plugin, health);
  const { title, strip, text } = banner[readiness.state];
  const [storage, setStorage] = useState<number | null>(null);
  const [logs, setLogs] = useState(recentLogs);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readPluginInfoSummary(session).then((summary) => { if (live) setPlugin(summary); });
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
    <View testID="settings-health-ready" accessibilityLiveRegion="polite" aria-live="polite"
      className={`gap-1 rounded-md border px-3 py-2 ${strip}`}>
      <View className="flex-row items-center gap-2">
        {readiness.state === 'ready' && <TickIcon size={16} className="text-success" />}
        {readiness.state === 'warning' && <WarningIcon size={16} />}
        <Text testID="settings-health-ready-title" className={`text-sm font-semibold ${text}`}>{title}</Text>
      </View>
      {readiness.state === 'ready' && <Text testID="settings-health-ready-detail" className="text-sm text-muted-foreground">
        The store answers, its plugin is current and nothing is waiting to send.
      </Text>}
      {readiness.state === 'warning' && readiness.reasons.map((reason) =>
        <Text key={reason} testID="settings-health-ready-reason" className="text-sm text-foreground">{reason}</Text>)}
    </View>
    <SettingsGroup title="Store connection" description="Read-only." testID="settings-health">
      <SettingsRow label="Store URL" action={<Value testID="settings-health-store-url">{session.baseUrl}</Value>} />
      <SettingsRow label="Plugin contract" divider
        action={<Value testID="settings-health-plugin-contract">{plugin?.contract ?? 'Unknown'}</Value>} />
      <SettingsRow label="Plugin version" divider
        action={<Value testID="settings-health-plugin-version">{plugin?.version ?? 'Unknown'}</Value>} />
      <SettingsRow label="App version" divider action={<Value testID="settings-health-app-version">{appVersion}</Value>} />
    </SettingsGroup>
    <SettingsGroup divider title="This device"
      description="Sales keep working when the store cannot be reached; waiting changes send when it can.">
      <SettingsRow label="Storage used" action={<Value testID="settings-health-storage">{formatBytes(storage)}</Value>} />
      <SettingsRow label="Sales waiting to send" divider
        action={<Value testID="settings-health-sales-pending">{health.sales.pending}</Value>} />
      <SettingsRow label="Till updates waiting to send" divider
        action={<Value testID="settings-health-till-pending">{health.tillUpdates.pending}</Value>} />
      <SettingsRow label="Need attention" divider action={<Value testID="settings-health-attention">{health.attention}</Value>} />
    </SettingsGroup>
    <SettingsGroup divider title="Logs" description="Warnings and errors since the app started. Kept in memory on this device only.">
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
