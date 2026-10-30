/**
 * Secret cards that save into Scient Accounts carry this `clientRequestId` prefix. Only the
 * Accounts tool may use it; upstream's `request_secret` rejects it, so no agent can make an
 * ordinary card read as an Accounts one.
 */
export const ACCOUNT_SECRET_REQUEST_PREFIX = "scient-account:";

/** Card turn items end with the encoded request id (`turn-item:secret-request:<thread>:<id>`). */
export const isAccountSecretRequest = (turnItemId: string | undefined) =>
  turnItemId?.includes(`:${encodeURIComponent(ACCOUNT_SECRET_REQUEST_PREFIX)}`) === true;

/** Accounts cards' privacy note: new keys are readable by default, so the card says so. */
export const ACCOUNT_SECRET_REQUEST_NOTE =
  "Saved to Settings ▸ Accounts. Agents can use it, and read it in their commands, as you allow there";
export const ACCOUNT_SECRET_REQUEST_SAVED = "Saved to Accounts";
