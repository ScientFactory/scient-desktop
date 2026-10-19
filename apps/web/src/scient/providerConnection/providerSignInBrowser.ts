/**
 * Opens a provider's sign-in page for the client that started the sign-in,
 * once, whatever setup view is mounted when the page becomes available.
 *
 * Starting a sign-in can take a minute (Antigravity unpacks itself first), and
 * the view that started it may close or remount meanwhile, or the start reply
 * may be lost to a brief disconnect. Before sending a start, the client records
 * a random sign-in request id here and sends it along; the server stamps it on
 * the operation it creates. When the start reply or a streamed provider
 * snapshot shows an operation with an id this client holds, waiting on a
 * primary sign-in page, the client asks the server to claim the opening, and
 * opens the page the grant names only if the server grants it. The server
 * decides whether the operation is still current: it grants once per
 * operation, while the operation waits on that page, so windows sharing a
 * copied session, a reload, a second report, or a replaced or cancelled
 * operation never open it again, and clients without the id never get a grant.
 * Ids live in session storage until the server answers, a reply or snapshot
 * shows the operation ended, the start is rejected, or they expire; an unknown
 * answer keeps the id for the next report. A window that dies between the grant
 * and the opening leaves the card's open action.
 */
import type {
  EnvironmentId,
  ProviderConnectionMethod,
  ProviderConnectionOperation,
  ProviderInstanceId,
  ProviderSignInPageClaimInput,
  ProviderSignInPageClaimResult,
  ServerProvider,
} from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { toastManager } from "../../components/ui/toast";
import { randomUUID } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { isSafeProviderAuthorizationUrl } from "./providerConnectionPresentation";

export interface ProviderSignInKey {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderSignInBrowserOpening {
  readonly status: "opening" | "opened" | "failed";
  readonly error: string | null;
  /** The browser blocked the page: the user's own click opens it. */
  readonly blocked?: boolean;
}

const PROVIDER_SIGN_IN_PAGE_OPEN_FAILURE =
  "Scient could not open the sign-in page in your browser. Try opening it again.";
const PROVIDER_SIGN_IN_PAGE_BLOCKED = "Your browser blocked the sign-in page. Open it to continue.";

/** A browser refused to open a window that no click of the user's asked for. */
class SignInPageBlocked extends Error {}

/**
 * Methods that sign in through a page Scient opens, with nothing to choose or
 * enter first. Any other method shows a choice, a code or a pairing in its
 * setup view.
 */
const BROWSER_SIGN_IN_METHODS: ReadonlySet<ProviderConnectionMethod> = new Set([
  "codex_browser",
  "cursor_browser",
  "antigravity_google",
]);

/** The one method a single click can start for this provider, if there is exactly one. */
export function oneClickSignInMethod(provider: ServerProvider): ProviderConnectionMethod | null {
  const methods = (provider.connection?.methods ?? []).filter((method) =>
    BROWSER_SIGN_IN_METHODS.has(method),
  );
  return methods.length === 1 ? methods[0]! : null;
}

export async function openProviderAuthorizationPage(url: string): Promise<void> {
  if (!isSafeProviderAuthorizationUrl(url)) {
    throw new Error("Scient refused an invalid or insecure provider sign-in link.");
  }
  if (window.desktopBridge) {
    await ensureLocalApi().shell.openExternal(url);
    return;
  }
  // Preview hosts distinguish a popup from a new-tab link. `noopener` would hide
  // whether the browser blocked it, so a blank window is opened, checked and cut
  // from its opener before it goes to the sign-in page.
  const opened = window.open("about:blank", "_blank", "popup");
  if (opened === null || opened.closed) throw new SignInPageBlocked();
  try {
    opened.opener = null;
    navigateWithoutReferrer(opened, url);
  } catch (error) {
    // Never leave a blank window behind; the failure offers the page again.
    try {
      opened.close();
    } catch {
      // Closing is best effort.
    }
    throw error;
  }
}

/**
 * Navigates a same-origin window without sending a referrer. A navigation this
 * window starts would carry its own URL as the referrer; a `noreferrer` link
 * followed inside the target sends none.
 */
export function navigateWithoutReferrer(target: Window, url: string): void {
  const link = target.document.createElement("a");
  link.href = url;
  link.rel = "noreferrer";
  (target.document.body ?? target.document.documentElement).append(link);
  link.click();
}

interface PendingRequest {
  readonly id: string;
  readonly createdAt: number;
}

/**
 * Longer than any provider's sign-in window plus its start (Antigravity allows
 * five minutes after a start of up to a minute). The server operation carries no
 * deadline, so an id whose operation never reports a terminal state ends here.
 */
const PENDING_REQUEST_LIFETIME_MS = 15 * 60_000;
const STORAGE_KEY = "scient.providerSignIn.pendingRequests.v1";
const MAX_RETAINED_OPENINGS = 64;

const openings = new Map<string, ProviderSignInBrowserOpening>();
const pending = new Map<string, ReadonlyArray<PendingRequest>>();
const surfaces = new Map<string, number>();
const startsInFlight = new Map<string, number>();
const listeners = new Set<() => void>();
let openPage: (url: string) => Promise<void> = openProviderAuthorizationPage;
let now: () => number = Date.now;
let pendingKeysSnapshot: ReadonlyArray<ProviderSignInKey> = [];

const keyOf = (key: ProviderSignInKey) => `${key.environmentId}\u0000${key.instanceId}`;
const openingKeyOf = (key: ProviderSignInKey, operationId: string) =>
  `${keyOf(key)}\u0000${operationId}`;

function notify() {
  for (const listener of listeners) listener();
}

function adjustCount(counts: Map<string, number>, id: string, delta: number) {
  const next = (counts.get(id) ?? 0) + delta;
  if (next > 0) counts.set(id, next);
  else counts.delete(id);
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Asks the server for the one opening of an operation's page. A grant carries
 * the page to open; a denial means another client or an earlier load has it, or
 * the operation no longer waits on it. A rejected promise is an unknown outcome.
 */
export type ProviderSignInPageClaimer = (
  environmentId: EnvironmentId,
  input: ProviderSignInPageClaimInput,
) => Promise<ProviderSignInPageClaimResult>;

let claimPage: ProviderSignInPageClaimer | null = null;

/** Registered by the app-level coordinator, which holds the command. */
export function setProviderSignInPageClaimer(claimer: ProviderSignInPageClaimer | null): void {
  claimPage = claimer;
  notify();
}

const readClaimerReady = () => claimPage !== null;

/** Whether the claim command is registered, so snapshots can be observed. */
export function useProviderSignInPageClaimerReady(): boolean {
  return useSyncExternalStore(subscribe, readClaimerReady, readClaimerReady);
}

/** One claim in flight per operation; a later report asks again only after it settles. */
const claimsInFlight = new Set<string>();

function isPendingRequest(value: unknown): value is PendingRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    /^[A-Za-z0-9-]{8,64}$/.test(value.id) &&
    "createdAt" in value &&
    typeof value.createdAt === "number"
  );
}

function refreshPendingKeys() {
  pendingKeysSnapshot = [...pending.keys()].map((id) => {
    const [environmentId, instanceId] = id.split("\u0000");
    return {
      environmentId: environmentId as EnvironmentId,
      instanceId: instanceId as ProviderInstanceId,
    };
  });
}

function persistPending() {
  const storage = sessionStore();
  if (!storage) return;
  try {
    if (pending.size === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(pending)));
  } catch {
    // Storage can be full or unavailable; the ids still work until a reload.
  }
}

function hydratePending() {
  pending.clear();
  const raw = sessionStore()?.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [id, requests] of Object.entries(parsed)) {
          if (!Array.isArray(requests)) continue;
          const valid = requests.filter(isPendingRequest);
          if (valid.length > 0) pending.set(id, valid);
        }
      }
    } catch {
      // A malformed entry only loses ids from before the reload.
    }
  }
  refreshPendingKeys();
  dropExpired();
}

function setPending(id: string, requests: ReadonlyArray<PendingRequest>) {
  if (requests.length > 0) pending.set(id, requests);
  else pending.delete(id);
  refreshPendingKeys();
  persistPending();
}

function dropExpired() {
  const cutoff = now() - PENDING_REQUEST_LIFETIME_MS;
  let changed = false;
  for (const [id, requests] of pending) {
    const live = requests.filter((request) => request.createdAt > cutoff);
    if (live.length === requests.length) continue;
    setPending(id, live);
    changed = true;
  }
  if (changed) notify();
}

function holds(key: ProviderSignInKey, requestId: string | undefined): boolean {
  return (
    requestId !== undefined &&
    (pending.get(keyOf(key)) ?? []).some((request) => request.id === requestId)
  );
}

function release(key: ProviderSignInKey, requestId: string) {
  const id = keyOf(key);
  const requests = pending.get(id) ?? [];
  if (!requests.some((request) => request.id === requestId)) return;
  setPending(
    id,
    requests.filter((request) => request.id !== requestId),
  );
  notify();
}

function setOpening(id: string, opening: ProviderSignInBrowserOpening) {
  openings.delete(id);
  openings.set(id, opening);
  while (openings.size > MAX_RETAINED_OPENINGS) {
    openings.delete(openings.keys().next().value!);
  }
  notify();
}

async function openFor(input: {
  readonly key: ProviderSignInKey;
  readonly operationId: string;
  readonly url: string;
  readonly providerName: string;
}): Promise<void> {
  const id = openingKeyOf(input.key, input.operationId);
  setOpening(id, { status: "opening", error: null });
  try {
    await openPage(input.url);
    setOpening(id, { status: "opened", error: null });
  } catch (error) {
    // The native error can name the link or local paths; users see fixed guidance.
    const blocked = error instanceof SignInPageBlocked;
    const message = blocked ? PROVIDER_SIGN_IN_PAGE_BLOCKED : PROVIDER_SIGN_IN_PAGE_OPEN_FAILURE;
    setOpening(id, { status: "failed", error: message, ...(blocked ? { blocked } : {}) });
    // A setup view that is showing presents the failure itself.
    if ((surfaces.get(keyOf(input.key)) ?? 0) > 0) return;
    toastManager.add({
      type: blocked ? "warning" : "error",
      title: blocked
        ? `${input.providerName} sign-in page blocked`
        : `${input.providerName} sign-in page didn’t open`,
      actionProps: { children: "Open", onClick: () => void openFor(input) },
    });
  }
}

function opensPage(
  operation: ProviderConnectionOperation,
): operation is ProviderConnectionOperation & {
  readonly authorizationUrl: string;
} {
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

/**
 * Acts on a reply or snapshot showing an operation stamped with one of this
 * client's request ids. Whether the operation is still current is the server's
 * call when it answers the claim; the client releases an id only on an answer,
 * an operation shown ended, a rejected start, or expiry.
 */
async function considerOwnOperation(
  key: ProviderSignInKey,
  operation: ProviderConnectionOperation,
  providerName: string,
): Promise<void> {
  const requestId = operation.signInRequestId;
  if (requestId === undefined || !holds(key, requestId)) return;
  if (TERMINAL_STATUSES.has(operation.status)) {
    release(key, requestId);
    return;
  }
  if (!opensPage(operation)) return;
  const openingKey = openingKeyOf(key, operation.operationId);
  if (openings.has(openingKey)) {
    release(key, requestId);
    return;
  }
  if (claimsInFlight.has(openingKey) || claimPage === null) return;
  claimsInFlight.add(openingKey);
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
    claimsInFlight.delete(openingKey);
  }
  if (result === undefined) return;
  // An id released meanwhile saw its operation end, or the user opened the page
  // by hand: nothing to open.
  const stillHeld = holds(key, requestId);
  release(key, requestId);
  if (result.granted && stillHeld && !openings.has(openingKey)) {
    await openFor({
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
  if (input.signInRequestId !== undefined) release(input.key, input.signInRequestId);
  await openFor(input);
}

/**
 * Feeds streamed provider snapshots of one environment in which this client
 * holds a request id (`ProviderSignInPageCoordinator` does, once for the app).
 */
export function observeProviderSignInSnapshots(
  environmentId: EnvironmentId,
  providers: ReadonlyArray<ServerProvider>,
): void {
  dropExpired();
  for (const provider of providers) {
    const key = { environmentId, instanceId: provider.instanceId };
    if (!pending.has(keyOf(key))) continue;
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
 * Runs this client's start command with a fresh sign-in request id and opens
 * the sign-in page it leads to. A start the server rejected releases its id; an
 * unknown outcome (a lost reply) keeps it, so the stream can still open the page.
 */
export async function startProviderSignIn<T>(input: {
  readonly key: ProviderSignInKey;
  readonly providerName: string;
  readonly previousOperationId: string | null;
  readonly start: (signInRequestId: string) => Promise<T>;
  readonly operationOf: (result: T) => ProviderConnectionOperation | null | undefined;
}): Promise<T> {
  dropExpired();
  const id = keyOf(input.key);
  const requestId = randomUUID();
  setPending(id, [...(pending.get(id) ?? []), { id: requestId, createdAt: now() }]);
  adjustCount(startsInFlight, id, 1);
  notify();
  let result: T;
  try {
    result = await input.start(requestId);
  } catch (error) {
    if (isServerRejection(error)) release(input.key, requestId);
    throw error;
  } finally {
    adjustCount(startsInFlight, id, -1);
    notify();
  }
  const operation = input.operationOf(result);
  if (operation?.signInRequestId !== undefined) {
    // A start this client joined to one already in flight shares that start's
    // operation, so its own id has nothing left to identify.
    if (operation.signInRequestId !== requestId) release(input.key, requestId);
    await considerOwnOperation(input.key, operation, input.providerName);
    return result;
  }
  // A server that does not stamp request ids has no claim either: the reply
  // alone identifies the operation, and only when it is new.
  release(input.key, requestId);
  if (
    operation &&
    operation.operationId !== input.previousOperationId &&
    opensPage(operation) &&
    !openings.has(openingKeyOf(input.key, operation.operationId))
  ) {
    await openFor({
      key: input.key,
      operationId: operation.operationId,
      url: operation.authorizationUrl,
      providerName: input.providerName,
    });
  }
  return result;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readPendingKeys = () => pendingKeysSnapshot;

/**
 * Whether this client's start command for the instance is still in flight, so
 * views can show it starting from the click, before the server's starting
 * operation arrives.
 */
export function useProviderSignInStartingHere(key: ProviderSignInKey): boolean {
  const { environmentId, instanceId } = key;
  const read = useCallback(
    () => startsInFlight.has(keyOf({ environmentId, instanceId })),
    [environmentId, instanceId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** The provider instances for which this client holds a sign-in request id. */
export function usePendingProviderSignInKeys(): ReadonlyArray<ProviderSignInKey> {
  return useSyncExternalStore(subscribe, readPendingKeys, readPendingKeys);
}

/**
 * What this client did about the operation's sign-in page, for a setup view.
 * `opening` is `null` until it opens the page. `startedHere` says this client
 * started the operation and is about to open it; when both are unset, another
 * client started the sign-in, or this client lost track of it (a full quit).
 * While mounted, the view also receives opening failures instead of a toast.
 */
export function useProviderSignInBrowser(
  key: ProviderSignInKey,
  operation: ProviderConnectionOperation | null,
  providerName: string,
): {
  readonly opening: ProviderSignInBrowserOpening | null;
  readonly startedHere: boolean;
  readonly reopen: () => Promise<void>;
} {
  const { environmentId, instanceId } = key;
  useEffect(() => {
    const surface = keyOf({ environmentId, instanceId });
    adjustCount(surfaces, surface, 1);
    return () => adjustCount(surfaces, surface, -1);
  }, [environmentId, instanceId]);
  const operationId = operation?.operationId ?? null;
  const requestId = operation?.signInRequestId;
  const url = operation?.authorizationUrl ?? null;
  // Each snapshot is the stored value itself, so memoized renders see every change.
  const readOpening = useCallback(
    () =>
      operationId === null
        ? null
        : (openings.get(openingKeyOf({ environmentId, instanceId }, operationId)) ?? null),
    [environmentId, instanceId, operationId],
  );
  const opening = useSyncExternalStore(subscribe, readOpening, readOpening);
  const readStartedHere = useCallback(() => {
    const signInKey = { environmentId, instanceId };
    return requestId !== undefined
      ? holds(signInKey, requestId)
      : startsInFlight.has(keyOf(signInKey));
  }, [environmentId, instanceId, requestId]);
  const startedHere = useSyncExternalStore(subscribe, readStartedHere, readStartedHere);
  const reopen = useCallback(async () => {
    if (operationId === null || url === null) return;
    await openProviderSignInPageByHand({
      key: { environmentId, instanceId },
      operationId,
      signInRequestId: requestId,
      url,
      providerName,
    });
  }, [environmentId, instanceId, operationId, providerName, requestId, url]);
  return { opening, startedHere, reopen };
}

hydratePending();

/**
 * Test seam: replaces how pages open, the clock and the server claim, and
 * forgets everything held in memory. With `reload`, request ids come back from session storage as after
 * a renderer reload; otherwise session storage is cleared too.
 */
export function resetProviderSignInBrowserForTests(
  options: {
    readonly open?: (url: string) => Promise<void>;
    readonly now?: () => number;
    readonly reload?: boolean;
    readonly claim?: ProviderSignInPageClaimer | null;
  } = {},
): void {
  openPage = options.open ?? openProviderAuthorizationPage;
  now = options.now ?? Date.now;
  claimPage = options.claim ?? null;
  openings.clear();
  surfaces.clear();
  startsInFlight.clear();
  claimsInFlight.clear();
  if (options.reload) hydratePending();
  else {
    pending.clear();
    sessionStore()?.removeItem(STORAGE_KEY);
    refreshPendingKeys();
  }
  notify();
}
