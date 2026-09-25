import { describe, expect, it } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import type { StorageHealth } from '@tallyui/database';
import { storageHealth$, watchStorageHealth } from './storage-health';

function health(status: StorageHealth['status']): StorageHealth {
  return { status, stalledWrites: status === 'stalled' ? 1 : 0 };
}

describe('storageHealth$', () => {
  it('is ok when there are no sources', () => {
    const statuses: string[] = [];
    const subscription = storageHealth$.subscribe((status) => statuses.push(status));
    subscription.unsubscribe();
    expect(statuses).toEqual(['ok']);
  });

  it('reports the worst status across two sources', () => {
    const a = new BehaviorSubject<StorageHealth>(health('ok'));
    const b = new BehaviorSubject<StorageHealth>(health('ok'));
    const statuses: string[] = [];
    const subscription = storageHealth$.subscribe((status) => statuses.push(status));
    const unregisterA = watchStorageHealth(a);
    const unregisterB = watchStorageHealth(b);
    try {
      a.next(health('stalled'));
      expect(statuses.at(-1)).toBe('stalled');
      // b staying ok leaves the worst of the two at a's 'stalled'.
      b.next(health('ok'));
      expect(statuses.at(-1)).toBe('stalled');
      a.next(health('ok'));
      expect(statuses.at(-1)).toBe('ok');
    } finally {
      unregisterA();
      unregisterB();
      subscription.unsubscribe();
    }
  });

  it('unregister removes a (non-dead) source', () => {
    const a = new BehaviorSubject<StorageHealth>(health('stalled'));
    const statuses: string[] = [];
    const subscription = storageHealth$.subscribe((status) => statuses.push(status));
    const unregister = watchStorageHealth(a);
    try {
      expect(statuses.at(-1)).toBe('stalled');
      unregister();
      expect(statuses.at(-1)).toBe('ok');
    } finally {
      subscription.unsubscribe();
    }
  });

  it('dead is sticky even after its source unregisters', () => {
    // `StorageHealth`'s own dead branch unmounts the database that went dead (its `children`),
    // which unregisters that source; losing it must never read as recovery (reload is the only
    // one, ADR-061).
    const a = new BehaviorSubject<StorageHealth>(health('ok'));
    const statuses: string[] = [];
    const subscription = storageHealth$.subscribe((status) => statuses.push(status));
    const unregister = watchStorageHealth(a);
    try {
      a.next(health('dead'));
      expect(statuses.at(-1)).toBe('dead');
      unregister();
      expect(statuses.at(-1)).toBe('dead');
    } finally {
      subscription.unsubscribe();
    }
  });
});
