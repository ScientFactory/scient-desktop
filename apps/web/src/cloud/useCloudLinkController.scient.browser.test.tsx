import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentId,
  type EnvironmentCloudLinkStateResult,
} from "@t3tools/contracts";
import type { RelayManagedEndpointProviderKind } from "@t3tools/contracts/relay";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const testState = vi.hoisted(() => ({
  scopes: new Set<string>(),
  snapshot: null as EnvironmentCloudLinkStateResult | null,
  renderedSnapshot: null as EnvironmentCloudLinkStateResult | null,
  relayProviderKind: null as RelayManagedEndpointProviderKind | null,
  getToken: vi.fn<() => Promise<string | null>>(),
  link: vi.fn(),
  switchAccount: vi.fn(),
  unlink: vi.fn(),
  preferences: vi.fn(),
  refreshDiscovery: vi.fn(),
  refreshLink: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({
    environments: new Map(
      testState.relayProviderKind === null
        ? []
        : [
            [
              "service",
              { environment: { endpoint: { providerKind: testState.relayProviderKind } } },
            ],
          ],
    ),
  })) as never,
}));
vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => ({
    getToken: testState.getToken,
    isSignedIn: true,
    userId: "account-2",
  })) as never,
}));
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } as never };
});
vi.mock(import("../state/relay"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    relayEnvironmentDiscovery: {
      ...actual.relayEnvironmentDiscovery,
      refresh: testState.refreshDiscovery,
    } as never,
  };
});
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (_environmentId, scope) => testState.scopes.has(scope),
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("./linkEnvironmentAtoms"), async (original) => ({
  ...(await original()),
  linkEnvironment: testState.link as never,
  switchEnvironmentAccount: testState.switchAccount as never,
  unlinkEnvironment: testState.unlink as never,
  updateEnvironmentPreferences: testState.preferences as never,
}));
vi.mock(import("./cloudLinkState"), async (original) => ({
  ...(await original()),
  readCachedCloudLinkState: () => testState.snapshot,
  useCloudLinkState: ((environmentId: EnvironmentId | null) => ({
    target: environmentId === null ? null : { environmentId },
    data: testState.renderedSnapshot,
    error: null,
    isPending: false,
    refresh: testState.refreshLink,
  })) as never,
}));
vi.mock(import("./publicConfig"), async (original) => ({
  ...(await original()),
  resolveRelayClerkTokenOptions: () => ({}) as never,
}));

import { useCloudLinkController, type CloudLinkDesiredState } from "./useCloudLinkController";

const target = { environmentId: EnvironmentId.make("service") };
const linkedState: EnvironmentCloudLinkStateResult = {
  linked: true,
  cloudUserId: "account-1",
  relayUrl: "https://relay.example.com",
  relayIssuer: "https://relay.example.com",
  managedTunnelActive: true,
  publishAgentActivity: false,
};

type Controller = ReturnType<typeof useCloudLinkController>;

function ControllerProbe({ onRender }: { onRender: (controller: Controller) => void }) {
  const value = useCloudLinkController(target.environmentId);
  useLayoutEffect(() => {
    onRender(value);
  });
  return null;
}

async function mountController() {
  let controller: Controller | null = null;
  const screen = await render(
    <ControllerProbe
      onRender={(value) => {
        controller = value;
      }}
    />,
  );
  return Object.assign(screen, {
    // Object.assign would copy a getter's value once, so read the latest render through a function.
    controller: () => controller,
    async reconcile(desired: CloudLinkDesiredState) {
      let succeeded = false;
      await act(async () => {
        if (controller === null) throw new Error("Controller is not mounted.");
        succeeded = await controller.reconcileCloudState(desired);
      });
      return succeeded;
    },
  });
}

function setup() {
  testState.scopes = new Set([AuthRelayReadScope, AuthRelayWriteScope]);
  testState.snapshot = linkedState;
  testState.renderedSnapshot = linkedState;
  testState.relayProviderKind = null;
  testState.getToken.mockReset().mockResolvedValue("clerk-token");
  for (const command of [
    testState.link,
    testState.switchAccount,
    testState.unlink,
    testState.preferences,
    testState.refreshDiscovery,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success({}));
  }
  testState.refreshLink.mockReset();
  testState.toast.mockReset();
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

// regression: environments linked under the development Clerk account by v0.6.28 could not be
// linked again after the switch to production ("already linked to a different cloud account").
describe("useCloudLinkController account switch", () => {
  it("moves the link to the signed-in account when turning Scient Connect on", async () => {
    using _setup = setup();
    testState.snapshot = { ...linkedState, managedTunnelActive: false, publishAgentActivity: true };
    testState.renderedSnapshot = testState.snapshot;
    await using screen = await mountController();

    expect(await screen.reconcile({ managedTunnel: true, publish: true })).toBe(true);
    expect(testState.switchAccount).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
      mode: "managed",
    });
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.unlink).not.toHaveBeenCalled();
  });

  it("keeps the other account's link when an edit turns nothing on", async () => {
    using _setup = setup();
    await using screen = await mountController();

    await screen.reconcile({ managedTunnel: true, publish: false, holdWebhooksWhileOffline: true });
    expect(testState.switchAccount).not.toHaveBeenCalled();
    expect(testState.unlink).not.toHaveBeenCalled();
  });

  it("keeps a link that already belongs to the signed-in account", async () => {
    using _setup = setup();
    testState.snapshot = { ...linkedState, cloudUserId: "account-2", managedTunnelActive: false };
    testState.renderedSnapshot = testState.snapshot;
    await using screen = await mountController();

    expect(await screen.reconcile({ managedTunnel: true, publish: false })).toBe(true);
    expect(testState.switchAccount).not.toHaveBeenCalled();
    expect(testState.link).toHaveBeenCalledOnce();
  });
});
