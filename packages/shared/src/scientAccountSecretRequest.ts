/**
 * Secret cards that save into Scient Accounts carry this `clientRequestId` prefix. Only the
 * Accounts tool may use it; upstream's `request_secret` rejects it, so no agent can make an
 * ordinary card read as an Accounts one.
 */
export const ACCOUNT_SECRET_REQUEST_PREFIX = "scient-account:";

/** A card asking for a sign-in code, which goes straight into a page and is never saved. */
export const SIGN_IN_CODE_REQUEST_PREFIX = `${ACCOUNT_SECRET_REQUEST_PREFIX}sign-in-code:`;

/**
 * The card's own request id. Turn items end with the encoded `<run>:<request id>`
 * (`turn-item:secret-request:<thread>:<run%3Arequest>`); an older form encodes only the request.
 */
export const secretRequestIdOf = (turnItemId: string | undefined): string | undefined => {
  const last = turnItemId?.split(":").at(-1);
  if (!last) return undefined;
  let key: string;
  try {
    key = decodeURIComponent(last);
  } catch {
    return undefined;
  }
  const at = key.indexOf(ACCOUNT_SECRET_REQUEST_PREFIX);
  return at === 0 || (at > 0 && key[at - 1] === ":") ? key.slice(at) : undefined;
};

export const isSignInCodeRequest = (turnItemId: string | undefined) =>
  secretRequestIdOf(turnItemId)?.startsWith(SIGN_IN_CODE_REQUEST_PREFIX) === true;

export const isAccountSecretRequest = (turnItemId: string | undefined) =>
  secretRequestIdOf(turnItemId) !== undefined && !isSignInCodeRequest(turnItemId);

/** What an Accounts card saves; its request id names it after the prefix (`password:<id>`). */
export type AccountSecretKind = "key" | "password" | "totp";

export const accountSecretRequestId = (kind: AccountSecretKind, id: string) =>
  `${ACCOUNT_SECRET_REQUEST_PREFIX}${kind}:${id}`;

/** An Accounts card's kind; an older server's cards name none and save keys. */
export const accountSecretKind = (
  turnItemId: string | undefined,
): AccountSecretKind | undefined => {
  if (!isAccountSecretRequest(turnItemId)) return undefined;
  const rest = secretRequestIdOf(turnItemId)!.slice(ACCOUNT_SECRET_REQUEST_PREFIX.length);
  return rest.startsWith("password:") ? "password" : rest.startsWith("totp:") ? "totp" : "key";
};
