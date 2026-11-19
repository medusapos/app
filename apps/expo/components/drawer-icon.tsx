import { Circle, Path, Rect } from 'react-native-svg';
import { createSvgIcon } from '@tallyui/components';

// Lucide's banknote: the cash drawer's badge in the user sheet, as v2.
export const DrawerIcon = createSvgIcon('DrawerIcon', () => <>
  <Rect width="20" height="12" x="2" y="6" rx="2" />
  <Circle cx="12" cy="12" r="2" />
  <Path d="M6 12h.01M18 12h.01" />
</>);
