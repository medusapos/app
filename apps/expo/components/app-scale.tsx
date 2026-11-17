import type { ReactNode } from 'react';
import { ScaleProvider } from '@tallyui/components';
import { defaultStorage } from '../lib/session';
import { useScaleChoice } from '../lib/scale-choice';

// Settings › Theme › Scale uses one device-wide key; on web TallyUI mirrors the variables onto <html>.
export function AppScale({ children }: { children?: ReactNode }) {
  const { choice } = useScaleChoice(defaultStorage());
  return <ScaleProvider scale={choice}>{children}</ScaleProvider>;
}
