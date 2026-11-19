/**
 * Secret cards that save into Scient Accounts carry this `clientRequestId` prefix. Only the
 * Accounts tool may use it; upstream's `request_secret` rejects it, so no agent can make an
 * ordinary card read as an Accounts one.
 */
export const ACCOUNT_SECRET_REQUEST_PREFIX = "scient-account:";

/** A card asking for a sign-in code, which goes straight into a page and is never saved. */
export const SIGN_IN_CODE_REQUEST_PREFIX = `${ACCOUNT_SECRET_REQUEST_PREFIX}sign-in-code:`;

/** Card turn items end with the encoded request id (`turn-item:secret-request:<thread>:<id>`). */
export const isSignInCodeRequest = (turnItemId: string | undefined) =>
  turnItemId?.includes(`:${encodeURIComponent(SIGN_IN_CODE_REQUEST_PREFIX)}`) === true;

export const isAccountSecretRequest = (turnItemId: string | undefined) =>
  turnItemId?.includes(`:${encodeURIComponent(ACCOUNT_SECRET_REQUEST_PREFIX)}`) === true &&
  !isSignInCodeRequest(turnItemId);
