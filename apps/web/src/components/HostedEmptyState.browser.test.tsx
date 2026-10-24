import type { Discovery } from "@t3tools/client-runtime/relay";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

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

function setup() {
  discovery.cloudEnabled = false;
  discovery.localEnvironmentOff = false;
  discovery.listeners.clear();
  discovery.state = {
    environments: new Map(),
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
}

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
  await screen.getByRole("link", { name: "Open Connections" }).click();
  expect(screen.router?.state.location.pathname).toBe("/settings/connections");
});
