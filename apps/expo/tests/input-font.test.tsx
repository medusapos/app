// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { TextInput } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchInput } from '@tallyui/components';
import { TYPE_SETS } from '@tallyui/theme';
import { AppFontProvider } from '../components/font-choice';
import { inputFontCss } from '../components/input-font';
import { chooseFont } from '../lib/font-choice';

const SELECTOR = 'style[data-medusapos-input-font]';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  vi.stubGlobal('FontFace', class { async load() { return this; } });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add: vi.fn() } });
});

afterEach(() => {
  cleanup();
  document.querySelectorAll(SELECTOR).forEach((element) => element.remove());
  document.body.innerHTML = '';
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function rulesOf(css: string): CSSStyleRule[] {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const rules = Array.from(style.sheet?.cssRules ?? []) as CSSStyleRule[];
  style.remove();
  return rules;
}

async function mount() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<AppFontProvider>
      <SearchInput value="" onChangeText={() => {}} />
      <TextInput testID="plain-input" />
    </AppFontProvider>);
  });
  return view;
}

describe('inputFontCss', () => {
  it('is empty under the system set', () => {
    expect(inputFontCss(TYPE_SETS.system)).toBe('');
  });

  it('gives input and textarea Space Grotesk under grotesk, without !important', () => {
    const css = inputFontCss(TYPE_SETS.grotesk);
    expect(css).toContain('"Space Grotesk"');
    expect(css).toContain('input');
    expect(css).toContain('textarea');
    expect(css).not.toContain('!important');
  });

  it('uses the body face for plain inputs and the num face for tabular-nums under instrument', () => {
    const rules = rulesOf(inputFontCss(TYPE_SETS.instrument));
    const body = rules.find((rule) => !rule.selectorText.includes('input.tabular-nums'));
    const num = rules.find((rule) => rule.selectorText.includes('input.tabular-nums'));
    expect(body?.style.fontFamily).toContain('DM Sans');
    expect(num?.style.fontFamily).toContain('JetBrains Mono');
  });
});

describe('InputFontStyle', () => {
  it('puts the chosen body face on TallyUI and react-native inputs, not on font-mono ones', async () => {
    localStorage.setItem('medusapos.font', 'grotesk');
    await mount();
    await waitFor(() => expect(document.querySelector(SELECTOR)).not.toBeNull());
    const element = document.querySelector<HTMLStyleElement>(SELECTOR)!;
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(1);
    const rule = (Array.from(element.sheet?.cssRules ?? []) as CSSStyleRule[])
      .find((candidate) => candidate.style.fontFamily.includes('Space Grotesk'))!;
    expect(rule).toBeDefined();
    expect(screen.getByRole('searchbox').matches(rule.selectorText)).toBe(true);
    expect(screen.getByTestId('plain-input').matches(rule.selectorText)).toBe(true);
    const mono = document.createElement('input');
    mono.className = 'font-mono';
    document.body.appendChild(mono);
    expect(mono.matches(rule.selectorText)).toBe(false);
  });

  it('removes the style when the till switches back to system, and adds none under system', async () => {
    localStorage.setItem('medusapos.font', 'grotesk');
    await mount();
    await waitFor(() => expect(document.querySelector(SELECTOR)).not.toBeNull());
    await act(async () => { chooseFont(localStorage, 'system'); });
    expect(document.querySelector(SELECTOR)).toBeNull();
    cleanup();
    await mount();
    expect(document.querySelector(SELECTOR)).toBeNull();
  });

  it('removes the style on unmount', async () => {
    localStorage.setItem('medusapos.font', 'grotesk');
    const view = await mount();
    await waitFor(() => expect(document.querySelector(SELECTOR)).not.toBeNull());
    view.unmount();
    expect(document.querySelector(SELECTOR)).toBeNull();
  });
});
