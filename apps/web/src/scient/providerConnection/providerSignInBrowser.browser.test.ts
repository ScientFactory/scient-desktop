import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  observeProviderSignInSnapshots,
  resetProviderSignInBrowserForTests,
  startProviderSignIn,
} from "./providerSignInBrowser";

const environmentId = EnvironmentId.make("environment-locks");
const instanceId = ProviderInstanceId.make("antigravity");
const lockName = `scient.providerSignIn.opened.v1:${environmentId}\u0000${instanceId}\u0000connect-1`;
const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test";
const open = vi.fn(async () => undefined);

function operation(patch: Partial<ProviderConnectionOperation>): ProviderConnectionOperation {
  return {
    operationId: "connect-1",
    method: "antigravity_google",
    status: "waiting_for_browser",
    startedAt: "2026-10-18T00:00:00.000Z",
    finishedAt: null,
    message: "Finish signing in.",
    authorizationUrl: url,
    authorizationUrlKind: "primary",
    ...patch,
  };
}

const observe = (current: ProviderConnectionOperation) =>
  observeProviderSignInSnapshots(environmentId, [
    {
      instanceId,
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Antigravity",
      enabled: true,
      installed: true,
      version: "1.1.17",
      status: "warning",
      auth: { status: "unauthenticated", required: true },
      checkedAt: "2026-10-18T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      connection: { methods: ["antigravity_google"], canDisconnect: false, operation: current },
    } satisfies ServerProvider,
  ]);

const pendingClaims = async () =>
  ((await navigator.locks.query()).pending ?? []).filter((lock) => lock.name === lockName).length;

beforeEach(() => {
  open.mockClear();
  resetProviderSignInBrowserForTests({ open });
});

describe("waiting sign-in page claims in Chromium", () => {
  it.each([
    ["cancelled", operation({ status: "cancelled" })],
    ["connected", operation({ status: "connected" })],
    ["superseded", operation({ operationId: "connect-2", signInRequestId: "another-request" })],
  ])("drops the queued lock request once the operation is %s", async (_name, next) => {
    const sent = await new Promise<string>((received) => {
      void startProviderSignIn({
        key: { environmentId, instanceId },
        providerName: "Antigravity",
        previousOperationId: null,
        start: (signInRequestId) => {
          received(signInRequestId);
          return new Promise<never>(() => undefined);
        },
        operationOf: () => null,
      });
    });
    // Another window holds the claim.
    let release!: () => void;
    await new Promise<void>((granted) => {
      void navigator.locks.request(lockName, () => {
        granted();
        return new Promise<void>((resolve) => (release = resolve));
      });
    });

    observe(operation({ signInRequestId: sent }));
    await vi.waitFor(async () => expect(await pendingClaims()).toBe(1));
    observe(next.signInRequestId ? next : { ...next, signInRequestId: sent });
    await vi.waitFor(async () => expect(await pendingClaims()).toBe(0));

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(open).not.toHaveBeenCalled();
  });
});
