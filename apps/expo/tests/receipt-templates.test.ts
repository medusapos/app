// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SYSTEM_PRINTER_ID } from '@tallyui/pos';
import { loadReceiptPrinter, loadReceiptTemplate, saveReceiptPrinter, saveReceiptTemplate, useReceiptPrinter, useReceiptTemplate } from '../lib/receipt-templates';

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

it('uses the print dialog for missing or corrupt printer choices', () => {
  expect(loadReceiptPrinter(sessionStorage, baseUrl, 'thermal-80mm')).toBe(SYSTEM_PRINTER_ID);
  saveReceiptPrinter(null, baseUrl, 'thermal-80mm', 'counter');
  expect(loadReceiptPrinter(null, baseUrl, 'thermal-80mm')).toBe(SYSTEM_PRINTER_ID);
  for (const value of ['{', 'null', '{"thermal-80mm":42}']) {
    sessionStorage.setItem('medusapos.receipt-printer.' + baseUrl, value);
    expect(loadReceiptPrinter(sessionStorage, baseUrl, 'thermal-80mm')).toBe(SYSTEM_PRINTER_ID);
  }
});

it('keeps each template’s printer per store and notifies mounted readers', () => {
  const reader = renderHook(() => useReceiptPrinter(sessionStorage, baseUrl, 'thermal-80mm'));
  act(() => saveReceiptPrinter(sessionStorage, baseUrl, 'thermal-80mm', 'counter'));
  expect(reader.result.current.printerId).toBe('counter');
  expect(loadReceiptPrinter(sessionStorage, baseUrl, 'thermal-58mm')).toBe(SYSTEM_PRINTER_ID);
  act(() => saveReceiptPrinter(sessionStorage, baseUrl, 'thermal-58mm', 'back'));
  expect(loadReceiptPrinter(sessionStorage, baseUrl, 'thermal-80mm')).toBe('counter');
  expect(loadReceiptPrinter(sessionStorage, baseUrl, 'thermal-58mm')).toBe('back');
  expect(loadReceiptPrinter(sessionStorage, 'https://other.test', 'thermal-80mm')).toBe(SYSTEM_PRINTER_ID);
});
