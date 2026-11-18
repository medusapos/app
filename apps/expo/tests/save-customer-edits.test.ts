import { describe, expect, it, vi } from 'vitest';
import type { Customer, CustomerPatch } from '@tallyui/core';
import { saveCustomerEdits } from '../lib/save-customer-edits';

const ada: Customer = { id: 'ada', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+44 1' };
const same = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+44 1', address: '' };
const fakeUpdate = () => vi.fn(async (_id: string, patch: CustomerPatch): Promise<Customer> => ({ ...ada, ...patch }));

describe('saveCustomerEdits', () => {
  it('sends only the changed fields, trimmed', async () => {
    const update = fakeUpdate();
    await saveCustomerEdits(update, ada, { ...same, firstName: '  Augusta ', email: ' ada@example.com ' }, undefined, undefined);
    expect(update).toHaveBeenCalledExactlyOnceWith('ada', { firstName: 'Augusta' });
  });

  it('adds billing and shipping when given', async () => {
    const update = fakeUpdate();
    const billing = { address1: '1 Market St', city: 'Leeds', country: 'GB' };
    const shipping = { address1: '2 Dock Rd', city: 'Hull', country: 'GB' };
    await saveCustomerEdits(update, ada, same, billing, shipping);
    expect(update).toHaveBeenCalledExactlyOnceWith('ada', { billing, shipping });
  });

  it('returns null without calling update when nothing changed', async () => {
    const update = fakeUpdate();
    expect(await saveCustomerEdits(update, ada, same, undefined, undefined)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('sends an empty phone as an empty string to clear it', async () => {
    const update = fakeUpdate();
    await saveCustomerEdits(update, ada, { ...same, phone: '  ' }, undefined, undefined);
    expect(update).toHaveBeenCalledExactlyOnceWith('ada', { phone: '' });
  });

  it('returns the updated customer', async () => {
    const updated = { ...ada, lastName: 'King', name: 'Ada King' };
    const update = vi.fn(async () => updated);
    expect(await saveCustomerEdits(update, ada, { ...same, lastName: 'King' }, undefined, undefined)).toBe(updated);
  });
});
