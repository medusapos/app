import '../global.css';
import '../lib/app-store-dump';
import { Slot, Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PortalHost } from '@tallyui/primitives';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Uniwind, useCSSVariable } from 'uniwind';
import { AppFrame } from '../components/app-frame';
import { AppScale } from '../components/app-scale';
import { useHeaderTitleStyle } from '../components/app-text';
import { ClearLocalDataGate } from '../components/clear-local-data';
import { DeviceScannerProvider } from '../components/device-scanner';
import { AppFontProvider } from '../components/font-choice';
import { LiveTabGate } from '../components/live-tab-gate';
import { StorageHealth } from '../components/storage-health';
import { installLogSinks } from '../lib/logging';
import { defaultStorage } from '../lib/session';
import { loadThemeChoice, subscribeThemeChoice } from '../lib/theme-choice';
import { SessionProvider, useSession } from '../lib/session-context';
import { OutboxProvider } from '../lib/outbox-context';
import { CustomerDisplayProvider } from '../lib/customer-display-context';
import { OutboxStrip } from '../components/store-refused';

// At module load, before the layout's first render, so the first frame uses this till's saved theme (Settings › Theme, one device-wide key).
Uniwind.setTheme(loadThemeChoice(defaultStorage()));
// Settings › Theme applies a new choice app-wide at once.
subscribeThemeChoice((choice) => Uniwind.setTheme(choice));
// Once at app start: the sale and outbox loggers' warn and error reach the console.
installLogSinks();

// Needs SessionProvider above it, so it is its own component under RootLayout.
function GatedApp() {
  const { session } = useSession();
  const card = useCSSVariable('--color-card');
  const foreground = useCSSVariable('--color-foreground');
  const background = useCSSVariable('--color-background');
  const headerTitleStyle = useHeaderTitleStyle();
  return (
    <LiveTabGate scope={session?.baseUrl}>
      <DeviceScannerProvider><StorageHealth backendUrl={session?.baseUrl}><OutboxProvider><CustomerDisplayProvider><AppFrame signedIn={session !== null}><Stack
        screenLayout={({ children, options, navigation }) => <SafeAreaView style={{ flex: 1 }}
          edges={options.headerShown === false ? ['top', 'left', 'right'] : ['left', 'right']}>
          <OutboxStrip header={options.headerShown === false ? undefined : navigation}>{children}</OutboxStrip>
        </SafeAreaView>}
        screenOptions={{
          headerStyle: { backgroundColor: card as string },
          headerTintColor: foreground as string,
          contentStyle: { backgroundColor: background as string },
          headerTitleStyle,
        }}
      ><Stack.Screen name="index" options={{ title: 'Sale' }} />
      </Stack></AppFrame></CustomerDisplayProvider></OutboxProvider></StorageHealth></DeviceScannerProvider>
    </LiveTabGate>
  );
}

export default function RootLayout() {
  // The display device has no login, so it renders outside the till's session and gates.
  if (usePathname() === '/display') return (
    <AppScale><AppFontProvider><ClearLocalDataGate>
      <StatusBar style="auto" /><Slot /><PortalHost />
    </ClearLocalDataGate></AppFontProvider></AppScale>
  );
  // Above PortalHost so dialogs and sheets get the chosen font too.
  return (
    <AppScale><AppFontProvider><ClearLocalDataGate><SessionProvider>
      <StatusBar style="auto" />
      <GatedApp />
      {/* One root host, after navigation and outside every gate (TallyUI's integration doc at 451a0ca): the
          register panel and movement sheet (Dialog) render here, above the screen's header. */}
      <PortalHost />
    </SessionProvider></ClearLocalDataGate></AppFontProvider></AppScale>
  );
}
