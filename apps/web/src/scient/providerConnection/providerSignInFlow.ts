/**
 * Opens a provider's sign-in page once, for the window that started the
 * sign-in, whatever setup view is mounted when the page becomes available.
 *
 * A start sends a fresh request id, which the server stamps on the operation it
 * creates. Whenever the start reply or a streamed snapshot shows an operation
 * stamped with an id this window holds, waiting on a primary page, the window
 * asks the server to claim the opening. The server decides: it grants once per
 * operation, only while that operation is current and waits on the page, and
 * the grant carries the URL to open. An id is released on the claim's answer,
 * when its operation is shown ended, when the start is rejected, when the user
 * opens the page by hand, or on expiry; an unknown answer keeps it for the next
 * report.
 */
import type {
  EnvironmentId,
  ProviderConnectionOperation,
  ProviderSignInPageClaimInput,
  ProviderSignInPageClaimResult,
  ServerProvider,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import {
  hasOpenedProviderSignInPage,
  openProviderSignInPage,
  resetProviderSignInOpeningsForTests,
} from "./providerSignInOpenings";
import {
  dropExpiredSignInRequests,
  holdNewSignInRequest,
  holdsAnySignInRequest,
  holdsSignInRequest,
  notifyProviderSignIn,
  type ProviderSignInKey,
  releaseSignInRequest,
  resetSignInRequestsForTests,
  signInKeyOf,
  subscribeToProviderSignIn,
} from "./providerSignInRequests";
import {
  beginProviderSignInStart,
  resetProviderSignInStartsForTests,
} from "./providerSignInStarting";

/** The server's claim command; a rejected promise is an unknown outcome. */
export type ProviderSignInPageClaimer = (
  environmentId: EnvironmentId,
  input: ProviderSignInPageClaimInput,
) => Promise<ProviderSignInPageClaimResult>;

let claimPage: ProviderSignInPageClaimer | null = null;
/** One claim in flight per operation; a later report asks again only after it settles. */
const claimsInFlight = new Set<string>();

/** Registered by the app-level coordinator, which holds the command. */
export function setProviderSignInPageClaimer(claimer: ProviderSignInPageClaimer | null): void {
  claimPage = claimer;
  notifyProviderSignIn();
}

const readClaimerReady = () => claimPage !== null;

/** Whether the claim command is registered, so snapshots can be observed. */
export function useProviderSignInPageClaimerReady(): boolean {
  return useSyncExternalStore(subscribeToProviderSignIn, readClaimerReady, readClaimerReady);
}

function opensPage(
  operation: ProviderConnectionOperation,
): operation is ProviderConnectionOperation & { readonly authorizationUrl: string } {
  return (
    (operation.status === "waiting_for_browser" ||
      operation.status === "waiting_for_device_code") &&
    operation.authorizationUrlKind === "primary" &&
    operation.authorizationUrl !== undefined
  );
}

const TERMINAL_STATUSES = new Set<ProviderConnectionOperation["status"]>([
  "connected",
  "failed",
  "cancelled",
]);

/** Acts on a reply or snapshot showing an operation, if it carries an id this window holds. */
async function considerOwnOperation(
  key: ProviderSignInKey,
  operation: ProviderConnectionOperation,
  providerName: string,
): Promise<void> {
  const requestId = operation.signInRequestId;
  if (requestId === undefined || !holdsSignInRequest(key, requestId)) return;
  if (TERMINAL_STATUSES.has(operation.status)) {
    releaseSignInRequest(key, requestId);
    return;
  }
  if (!opensPage(operation)) return;
  // Opened here already, by hand or from an unstamped reply: nothing to claim.
  if (hasOpenedProviderSignInPage(key, operation.operationId)) {
    releaseSignInRequest(key, requestId);
    return;
  }
  const claimKey = `${signInKeyOf(key)}\u0000${operation.operationId}`;
  if (claimsInFlight.has(claimKey) || claimPage === null) return;
  claimsInFlight.add(claimKey);
  let result: ProviderSignInPageClaimResult | undefined;
  try {
    result = await claimPage(key.environmentId, {
      instanceId: key.instanceId,
      operationId: operation.operationId,
      signInRequestId: requestId,
    });
  } catch {
    // An unknown outcome keeps the id; the next reply or snapshot asks again.
  } finally {
    claimsInFlight.delete(claimKey);
  }
  if (result === undefined) return;
  // Released meanwhile: the operation ended, or the user opened the page by hand.
  const stillHeld = holdsSignInRequest(key, requestId);
  releaseSignInRequest(key, requestId);
  if (result.granted && stillHeld && !hasOpenedProviderSignInPage(key, operation.operationId)) {
    await openProviderSignInPage({
      key,
      operationId: operation.operationId,
      url: result.authorizationUrl,
      providerName,
    });
  }
}

/**
 * The user's own opening of an operation's page. It spends this window's id for
 * the operation, so a grant still on its way opens nothing more.
 */
export async function openProviderSignInPageByHand(input: {
  readonly key: ProviderSignInKey;
  readonly operationId: string;
  readonly signInRequestId: string | undefined;
  readonly url: string;
  readonly providerName: string;
}): Promise<void> {
  if (input.signInRequestId !== undefined) releaseSignInRequest(input.key, input.signInRequestId);
  await openProviderSignInPage(input);
}

/** Feeds the streamed provider snapshots of one environment. */
export function observeProviderSignInSnapshots(
  environmentId: EnvironmentId,
  providers: ReadonlyArray<ServerProvider>,
): void {
  dropExpiredSignInRequests();
  for (const provider of providers) {
    const key = { environmentId, instanceId: provider.instanceId };
    if (!holdsAnySignInRequest(key)) continue;
    const providerName = provider.displayName?.trim() || String(provider.driver);
    for (const operation of [
      provider.connection?.operation,
      provider.connection?.accountOperation,
    ]) {
      if (operation) void considerOwnOperation(key, operation, providerName);
    }
  }
}

function isServerRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ProviderConnectionError"
  );
}

/**
 * Runs this window's start command with a fresh request id and opens the page
 * it leads to. A rejected start releases its id; an unknown outcome (a lost
 * reply) keeps it, so the stream can still open the page.
 */
export async function startProviderSignIn<T>(input: {
  readonly key: ProviderSignInKey;
  readonly providerName: string;
  readonly previousOperationId: string | null;
  readonly start: (signInRequestId: string) => Promise<T>;
  readonly operationOf: (result: T) => ProviderConnectionOperation | null | undefined;
}): Promise<T> {
  dropExpiredSignInRequests();
  const requestId = holdNewSignInRequest(input.key);
  const endStart = beginProviderSignInStart(input.key);
  let result: T;
  try {
    result = await input.start(requestId);
  } catch (error) {
    if (isServerRejection(error)) releaseSignInRequest(input.key, requestId);
    throw error;
  } finally {
    endStart();
  }
  const operation = input.operationOf(result);
  if (operation?.signInRequestId !== undefined) {
    // A start joined to one already in flight shares that start's operation, so
    // its own id has nothing left to identify.
    if (operation.signInRequestId !== requestId) releaseSignInRequest(input.key, requestId);
    await considerOwnOperation(input.key, operation, input.providerName);
    return result;
  }
  // A server that does not stamp request ids has no claim either: the reply
  // alone identifies the operation, and only when it is new.
  releaseSignInRequest(input.key, requestId);
  if (
    operation &&
    operation.operationId !== input.previousOperationId &&
    opensPage(operation) &&
    !hasOpenedProviderSignInPage(input.key, operation.operationId)
  ) {
    await openProviderSignInPage({
      key: input.key,
      operationId: operation.operationId,
      url: operation.authorizationUrl,
      providerName: input.providerName,
    });
  }
  return result;
}

/**
 * Test seam: replaces how pages open, the clock and the claim command, and
 * forgets what is held in memory. With `reload`, request ids come back from
 * session storage as after a renderer reload; otherwise it is cleared too.
 */
export function resetProviderSignInForTests(
  options: {
    readonly open?: (url: string) => Promise<void>;
    readonly now?: () => number;
    readonly reload?: boolean;
    readonly claim?: ProviderSignInPageClaimer | null;
  } = {},
): void {
  claimPage = options.claim ?? null;
  claimsInFlight.clear();
  resetProviderSignInOpeningsForTests(options.open);
  resetProviderSignInStartsForTests();
  resetSignInRequestsForTests(options);
  notifyProviderSignIn();
}
