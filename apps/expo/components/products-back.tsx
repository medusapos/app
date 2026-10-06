import { Pressable, Text } from 'react-native';
import { router } from 'expo-router';

export function ProductsBack() {
  return <>
    {/* Back to the Products screen under this one: a replace would mount a second, empty one over it, hiding the
        sale (and any pending save). Replace only with no history, opened by URL, where no sale exists yet. */}
    <Pressable accessibilityRole="button" accessibilityLabel="Products"
      onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }}
      className="min-h-11 self-start justify-center px-3"><Text className="text-primary">‹ Products</Text></Pressable>
  </>;
}
