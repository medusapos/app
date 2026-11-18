import { describe, expect, it, vi } from 'vitest';
import type { Customer } from '@tallyui/core';
import { saveNewCustomer } from './save-new-customer';

const values = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '', address: '' };
const customer: Customer = { id: 'cus_1', name: 'Ada Lovelace', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const billing = { address1: '1 Old St', city: 'London', country: 'GB' };
const shipping = { address1: '9 Dock Rd', city: 'Leeds', country: 'GB' };

describe('saveNewCustomer', () => {
  it('sends a defined shipping address in the same update patch as billing', async () => {
    const create = vi.fn(async () => customer);
    const update = vi.fn(async () => ({ ...customer, billing, shipping }));
    await saveNewCustomer({ create, update }, values, billing, shipping, { current: null });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('cus_1', { billing, shipping });
  });
  it('updates for a shipping address alone, with no billing and no field change', async () => {
    const create = vi.fn(async () => customer);
    const update = vi.fn(async () => ({ ...customer, shipping }));
    const saved = await saveNewCustomer({ create, update }, values, undefined, shipping, { current: null });
    expect(update).toHaveBeenCalledWith('cus_1', { shipping });
    expect(saved.shipping).toEqual(shipping);
  });
});
