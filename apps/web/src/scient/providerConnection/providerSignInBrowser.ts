/**
 * Opens a provider's sign-in page for the client that started the sign-in,
 * once, whatever setup view is mounted when the page becomes available.
 *
 * Starting a sign-in can take a minute (Antigravity unpacks itself first), and
 * the view that started it may close or remount meanwhile. The start command's
 * response is what this client alone receives, so it decides the opening; other
 * clients and windows see the same operation but never open its page. State
 * lives here, keyed by environment, provider instance and operation, so a
 * remounted view shows what happened and never opens the page a second time.
 */
import type {
  EnvironmentId,
  ProviderConnectionMethod,
  ProviderConnectionOperation,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { toastManager } from "../../components/ui/toast";
import { ensureLocalApi } from "../../localApi";
import { isSafeProviderAuthorizationUrl } from "./providerConnectionPresentation";

export interface ProviderSignInKey {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderSignInBrowserOpening {
  readonly status: "opening" | "opened" | "failed";
  readonly error: string | null;
}

const PROVIDER_SIGN_IN_PAGE_OPEN_FAILURE =
  "Scient could not open the sign-in page in your browser. Try opening it again.";

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
  // Preview hosts distinguish a popup from a new-tab link. Preserve the
  // originating setup page and isolate the authorization page from its opener.
  window.open(url, "_blank", "popup,noopener,noreferrer");
}

const MAX_RETAINED_OPENINGS = 64;
const openings = new Map<string, ProviderSignInBrowserOpening>();
const surfaces = new Map<string, number>();
const startsInFlight = new Map<string, number>();
const listeners = new Set<() => void>();
let openPage: (url: string) => Promise<void> = openProviderAuthorizationPage;

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
  } catch {
    // The native error can name the link or local paths; users see fixed guidance.
    const message = PROVIDER_SIGN_IN_PAGE_OPEN_FAILURE;
    setOpening(id, { status: "failed", error: message });
    // A setup view that is showing presents the failure itself.
    if ((surfaces.get(keyOf(input.key)) ?? 0) > 0) return;
    toastManager.add({
      type: "error",
      title: `Couldn’t open the ${input.providerName} sign-in page`,
      description: message,
      actionProps: {
        children: "Open sign-in page",
        onClick: () => void openFor(input),
      },
    });
  }
}

/**
 * Opens the page of a sign-in this client just started, from the start
 * command's response. Only a new operation that is waiting with a primary
 * sign-in page qualifies, and each operation opens at most once.
 */
async function openStartedProviderSignIn(input: {
  readonly key: ProviderSignInKey;
  readonly previousOperationId: string | null;
  readonly operation: ProviderConnectionOperation | null | undefined;
  readonly providerName: string;
}): Promise<void> {
  const operation = input.operation;
  if (
    !operation ||
    operation.operationId === input.previousOperationId ||
    (operation.status !== "waiting_for_browser" &&
      operation.status !== "waiting_for_device_code") ||
    operation.authorizationUrlKind !== "primary" ||
    !operation.authorizationUrl ||
    openings.has(openingKeyOf(input.key, operation.operationId))
  ) {
    return;
  }
  await openFor({
    key: input.key,
    operationId: operation.operationId,
    url: operation.authorizationUrl,
    providerName: input.providerName,
  });
}

/**
 * Runs this client's start command and then opens the sign-in page it reports.
 * While the command runs, setup views know this client is the one starting.
 */
export async function startProviderSignIn<T>(input: {
  readonly key: ProviderSignInKey;
  readonly providerName: string;
  readonly previousOperationId: string | null;
  readonly start: () => Promise<T>;
  readonly operationOf: (result: T) => ProviderConnectionOperation | null | undefined;
}): Promise<T> {
  const id = keyOf(input.key);
  adjustCount(startsInFlight, id, 1);
  notify();
  let result: T;
  try {
    result = await input.start();
  } finally {
    adjustCount(startsInFlight, id, -1);
    notify();
  }
  await openStartedProviderSignIn({
    key: input.key,
    previousOperationId: input.previousOperationId,
    operation: input.operationOf(result),
    providerName: input.providerName,
  });
  return result;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What this client did about the operation's sign-in page, for a setup view.
 * `opening` is `null` until it opens the page; with no start in flight here,
 * another client started the sign-in or its response never arrived. While
 * mounted, the view also receives opening failures instead of a toast.
 */
export function useProviderSignInBrowser(
  key: ProviderSignInKey,
  operation: ProviderConnectionOperation | null,
  providerName: string,
): {
  readonly opening: ProviderSignInBrowserOpening | null;
  readonly startInFlight: boolean;
  readonly reopen: () => Promise<void>;
} {
  const { environmentId, instanceId } = key;
  useEffect(() => {
    const surface = keyOf({ environmentId, instanceId });
    adjustCount(surfaces, surface, 1);
    return () => adjustCount(surfaces, surface, -1);
  }, [environmentId, instanceId]);
  const operationId = operation?.operationId ?? null;
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
  const readStartInFlight = useCallback(
    () => startsInFlight.has(keyOf({ environmentId, instanceId })),
    [environmentId, instanceId],
  );
  const startInFlight = useSyncExternalStore(subscribe, readStartInFlight, readStartInFlight);
  const reopen = useCallback(async () => {
    if (operationId === null || url === null) return;
    await openFor({ key: { environmentId, instanceId }, operationId, url, providerName });
  }, [environmentId, instanceId, operationId, providerName, url]);
  return { opening, startInFlight, reopen };
}

/** Test seam: replaces how pages open and forgets every opening. */
export function resetProviderSignInBrowserForTests(
  open: (url: string) => Promise<void> = openProviderAuthorizationPage,
): void {
  openPage = open;
  openings.clear();
  surfaces.clear();
  startsInFlight.clear();
  notify();
}
