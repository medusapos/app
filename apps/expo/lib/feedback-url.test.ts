import { describe, expect, it } from 'vitest';
import { feedbackUrl } from './feedback-url';

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('feedbackUrl', () => {
  it('opens the tester-feedback issue form', () => {
    const url = feedbackUrl({ appVersion: '0.1.0', backendUrl: undefined, platform: 'web' });
    expect(url.startsWith('https://github.com/medusapos/app/issues/new?')).toBe(true);
    expect(params(url).get('template')).toBe('tester-feedback.yml');
  });

  it('reduces a backend URL with a path, query, port and credentials to just host and port', () => {
    const url = feedbackUrl({
      appVersion: '0.1.0', platform: 'web',
      backendUrl: 'https://admin:secret@store.example.com:9100/some/path?x=1',
    });
    expect(params(url).get('backend-host')).toBe('store.example.com:9100');
    expect(url).not.toContain('secret');
    expect(url).not.toContain('admin');
    expect(url).not.toContain('some%2Fpath');
    expect(url).not.toContain('some/path');
  });

  it.each(['', undefined, 'not a url', 'ftp://'])('yields an empty host for an invalid or empty backend URL: %s', (backendUrl) => {
    const url = feedbackUrl({ appVersion: '0.1.0', platform: 'web', backendUrl });
    expect(params(url).get('backend-host')).toBe('');
  });

  it('URL-encodes the app version and device values', () => {
    const url = feedbackUrl({ appVersion: '0.1.0 (dev)', platform: 'web', userAgent: 'Mozilla/5.0 Chrome/1' });
    expect(params(url).get('app-version')).toBe('0.1.0 (dev)');
    expect(params(url).get('device')).toBe('web - Mozilla/5.0 Chrome/1');
    expect(url).toContain('app-version=0.1.0');
    expect(url).not.toContain(' ');
  });

  it('omits the user agent on non-web platforms', () => {
    const url = feedbackUrl({ appVersion: '0.1.0', platform: 'ios' });
    expect(params(url).get('device')).toBe('ios');
  });
});
