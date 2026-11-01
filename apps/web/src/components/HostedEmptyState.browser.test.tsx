import type { Discovery } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

type DiscoveredEnvironments = Discovery.RelayEnvironmentDiscoveryState["environments"];
type Availability = "checking" | "online";

const discovery = vi.hoisted(() => ({
  state: null as Discovery.RelayEnvironmentDiscoveryState | null,
  listeners: new Set<() => void>(),
  register: vi.fn(),
  localEnvironmentOff: false,
  cloudEnabled: false,
}));

vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => ({ isLoaded: true, isSignedIn: true })) as never,
}));
vi.mock(import("./clerk/useT3ConnectAuthPrompt"), () => ({
  useT3ConnectAuthPrompt: () => ({ authPrompt: null, openAuthPrompt: vi.fn() }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { relayEnvironmentDiscovery } = await import("~/state/relay");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === relayEnvironmentDiscovery.refresh
        ? async () => AsyncResult.success(undefined)
        : discovery.register) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    discovery.listeners.add(listener);
    return () => discovery.listeners.delete(listener);
  };
  const read = () => discovery.state!;
  return {
    ...(await original()),
    useRelayEnvironmentDiscovery: () => useSyncExternalStore(subscribe, read, read),
  };
});
vi.mock(import("../localEnvironment"), async (original) => ({
  ...(await original()),
  isLocalEnvironmentDisabled: () => discovery.localEnvironmentOff,
}));

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "~/cloud/publicConfig";
import { HostedEmptyState } from "./HostedEmptyState";

vi.mock(import("~/cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => discovery.cloudEnabled,
}));

const laptopId = EnvironmentId.make("laptop");
const desktopId = EnvironmentId.make("desktop");

function linked(availability: Record<string, Availability>): DiscoveredEnvironments {
  return new Map(
    [laptopId, desktopId].map((environmentId) => [
      environmentId,
      {
        environment: {
          environmentId,
          label: environmentId,
          endpoint: {
            httpBaseUrl: "https://relay.example.test",
            wsBaseUrl: "wss://relay.example.test/ws",
            providerKind: "manual",
          },
          linkedAt: "2026-10-19T12:00:00.000Z",
        },
        availability: availability[environmentId]!,
        status: Option.none(),
        error: Option.none(),
      },
    ]),
  );
}

async function publish(environments: DiscoveredEnvironments) {
  discovery.state = {
    environments,
    listed: true,
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  await act(async () => {
    for (const listener of discovery.listeners) listener();
  });
}

const registeredIds = () =>
  discovery.register.mock.calls.map(([registration]) => registration.target.environmentId);

function setup() {
  discovery.cloudEnabled = false;
  discovery.localEnvironmentOff = false;
  discovery.listeners.clear();
  discovery.state = {
    environments: new Map(),
    listed: true,
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
}

// regression: e37a7a4f71 fix(web): hosted app skips setup and recommends signing in (#19680)
// The first added computer replaces this screen with the app, so every
// registration has to start in the same pass, after all health checks finish.
it("adds every linked computer only after discovery finishes checking them", async () => {
  setup();
  discovery.cloudEnabled = true;
  await using screen = await render(<HostedEmptyState />);
  expect(screen.container.textContent).toContain("Start Scient on the computer with your code.");
  expect(screen.container.textContent).toContain("in that Scient installation");
  expect(screen.container.textContent).not.toMatch(/npx t3|T3 Code/);
  expect(screen.container.querySelector('a[href*="t3.codes"]')).toBeNull();

  await publish(linked({ [laptopId]: "checking", [desktopId]: "checking" }));
  await publish(linked({ [laptopId]: "online", [desktopId]: "checking" }));
  expect(discovery.register).not.toHaveBeenCalled();

  await publish(linked({ [laptopId]: "online", [desktopId]: "online" }));
  expect(registeredIds().toSorted()).toEqual([desktopId, laptopId]);
});

function withoutCloudEnvironment(): Disposable {
  const names = [
    "VITE_CLERK_PUBLISHABLE_KEY",
    "VITE_CLERK_JWT_TEMPLATE",
    "VITE_T3CODE_RELAY_URL",
  ] as const;
  const previous = names.map((name) => import.meta.env[name]);
  for (const name of names) vi.stubEnv(name, undefined);
  return {
    [Symbol.dispose]() {
      names.forEach((name, index) => vi.stubEnv(name, previous[index]));
    },
  };
}

it("offers owning-installation pairing and navigates to Connections without cloud configuration", async () => {
  setup();
  using _environment = withoutCloudEnvironment();
  expect(resolveCloudPublicConfig()).toMatchObject({
    clerkPublishableKey: null,
    clerkJwtTemplate: null,
    relayUrl: null,
  });
  expect(hasCloudPublicConfig()).toBe(false);
  await using screen = await render(<HostedEmptyState />);

  expect(screen.container.textContent).toContain("Start Scient there first");
  expect(screen.container.textContent).toContain(
    "Create a pairing link in Settings → Connections in that Scient installation",
  );
  expect(screen.container.textContent).toContain("matching Scient release from the owner");
  expect(screen.container.textContent).not.toMatch(/T3 Code|npx t3|Sign in/);
  expect(screen.container.querySelector('a[href*="t3.codes"]')).toBeNull();
  expect(discovery.register).not.toHaveBeenCalled();
  await screen.getByRole("link", { name: "Add pairing link" }).click();
  expect(screen.router?.state.location.pathname).toBe("/settings/connections");
});

it("routes a disabled local computer to Connections without installation or cloud commands", async () => {
  setup();
  using _environment = withoutCloudEnvironment();
  discovery.localEnvironmentOff = true;
  await using screen = await render(<HostedEmptyState />);
  expect(screen.container.textContent).toContain("This computer is off");
  expect(screen.container.textContent).not.toMatch(/npx|T3 Code|Sign in/);
  expect(screen.container.querySelector('a[href*="t3.codes"]')).toBeNull();
  expect(discovery.register).not.toHaveBeenCalled();
  await screen.getByRole("link", { name: "Open Environments" }).click();
  expect(screen.router?.state.location.pathname).toBe("/settings/connections");
});
