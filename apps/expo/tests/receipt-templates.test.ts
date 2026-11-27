// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { loadReceiptTemplate, saveReceiptTemplate, useReceiptTemplate } from '../lib/receipt-templates';

const baseUrl = 'https://store.test';
afterEach(() => { cleanup(); sessionStorage.clear(); });

it('a till with no saved template opens on Standard, and an unknown or corrupt value reads as Standard', () => {
  expect(loadReceiptTemplate(sessionStorage, baseUrl)).toBe('standard');
  const key = 'medusapos.receipt-template.' + baseUrl;
  for (const value of ['"unknown"', '{']) {
    sessionStorage.setItem(key, value);
    expect(loadReceiptTemplate(sessionStorage, baseUrl)).toBe('standard');
  }
});

it('a saved template is kept per store', () => {
  saveReceiptTemplate(sessionStorage, baseUrl, 'thermal-80mm');
  expect(loadReceiptTemplate(sessionStorage, baseUrl)).toBe('thermal-80mm');
  expect(loadReceiptTemplate(sessionStorage, 'https://other.test')).toBe('standard');
});

it('a picker save updates another mounted reader for the same store', () => {
  const picker = renderHook(() => useReceiptTemplate(sessionStorage, baseUrl));
  const reader = renderHook(() => useReceiptTemplate(sessionStorage, baseUrl));
  act(() => picker.result.current.save('thermal-58mm'));
  expect(reader.result.current.templateId).toBe('thermal-58mm');
});
