import type { ComponentType } from 'react';
import type { ViewfinderProps } from '@tallyui/components';

// Web keeps TallyUI's own viewfinder and has no permission gate.
export const NativeViewfinder: ComponentType<ViewfinderProps> | undefined = undefined;

export function useNativeCameraPermission(): { granted: boolean; request: () => void } | undefined {
  return undefined;
}
