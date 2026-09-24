// The GitHub issue-form field ids double as prefill query params; see
// .github/ISSUE_TEMPLATE/tester-feedback.yml.
const ISSUE_FORM_URL = 'https://github.com/medusapos/app/issues/new';
const TEMPLATE = 'tester-feedback.yml';

export type FeedbackUrlOptions = {
  /** The app's own version, e.g. from apps/expo/package.json. */
  appVersion: string;
  /** The backend URL to reduce to a host, or empty/invalid if unknown. */
  backendUrl?: string;
  /** The OS/platform, e.g. Platform.OS ('web', 'ios', 'android'). */
  platform: string;
  /** The browser's user agent; pass only on web. */
  userAgent?: string;
};

/** Never the credentials or path: only the backend URL's host (and port, if any). */
function backendHost(backendUrl: string | undefined): string {
  if (!backendUrl) return '';
  try {
    return new URL(backendUrl).host;
  } catch {
    return '';
  }
}

/** Builds the tester-feedback issue form URL, prefilled and never carrying credentials or a path. */
export function feedbackUrl({ appVersion, backendUrl, platform, userAgent }: FeedbackUrlOptions): string {
  const params = new URLSearchParams({
    template: TEMPLATE,
    'app-version': appVersion,
    'backend-host': backendHost(backendUrl),
    device: userAgent ? `${platform} - ${userAgent}` : platform,
  });
  return `${ISSUE_FORM_URL}?${params.toString()}`;
}
