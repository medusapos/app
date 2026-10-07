import { LoginError, NO_POS_ACCESS_MESSAGE, type LoginErrorCode } from './session';

export const LOGIN_ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  no_pos_access: NO_POS_ACCESS_MESSAGE,
  invalid_credentials: 'Incorrect email or password.',
  unsupported_account: 'This account needs multi-factor authentication or verification, which the POS does not support yet.',
  unreachable: 'Could not reach the backend. Check the URL and your connection.',
  server_error: 'The backend could not sign you in. Please try again.',
  invalid_url: 'Enter a valid backend URL starting with https://.',
  insecure_url: 'Use https://. Plain http:// is only allowed for localhost and private network addresses.',
};

export function loginErrorMessage(error: unknown): string {
  return LOGIN_ERROR_MESSAGES[error instanceof LoginError ? error.code : 'server_error'];
}
