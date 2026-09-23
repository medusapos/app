import { uuidv7 } from '@tallyui/pos';
import type { SessionStorage } from './session';

const STORAGE_KEY = 'medusapos.register_id';
let processId: string | undefined;

export function getRegisterId(storage: SessionStorage | null): string {
  try {
    if (storage) {
      const existing = storage.getItem(STORAGE_KEY);
      if (existing) return existing;
      const id = uuidv7();
      storage.setItem(STORAGE_KEY, id);
      return id;
    }
  } catch { /* Use the process id when web storage is unavailable. */ }
  return processId ??= uuidv7();
}
