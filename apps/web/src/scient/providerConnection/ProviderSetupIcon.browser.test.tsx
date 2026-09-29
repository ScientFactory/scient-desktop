import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./useProviderLifecycleController", () => {
  const never = () => new Promise<never>(() => undefined);
  return {
    useProviderLifecycleController: () => ({
      startConnection: never,
      cancelConnection: never,
      submitAuthorizationCode: never,
      disconnect: never,
      openAuthorizationPage: never,
      planRuntime: never,
      startRuntime: never,
      cancelRuntime: never,
      updateExternalRuntime: never,
    }),
  };
});
vi.mock("./useProviderEnableAction", () => ({
  useProviderEnableAction: () => ({ access: "granted", canEnable: true, enable: vi.fn() }),
}));

import { AssistedProviderSetupHost } from "./AssistedProviderSetupHost";

type Methods = NonNullable<ServerProvider["connection"]>["methods"];

const PROVIDERS: ReadonlyArray<readonly [driver: string, name: string, methods: Methods]> = [
  ["codex", "Codex", ["codex_browser"]],
  ["claudeAgent", "Claude", ["claude_subscription"]],
  ["cursor", "Cursor", ["cursor_browser"]],
  ["antigravity", "Antigravity", ["antigravity_google"]],
  ["droid", "Droid", ["droid_device_pairing"]],
  ["grok", "Grok", ["grok_account"]],
  ["pi", "Pi", []],
];

function snapshot(driver: string, name: string, methods: Methods): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "warning",
    auth: { status: "unauthenticated", required: true },
    checkedAt: "2026-09-27T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods,
      canDisconnect: false,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["repair", "remove"],
        managedVersion: "1.2.3",
        previousManagedVersion: null,
        operation: null,
        message: `Scient is using its private ${name} runtime.`,
      },
    },
  };
}

function notInstalled(provider: ServerProvider): ServerProvider {
  return {
    ...provider,
    installed: false,
    version: null,
    auth: { status: "unknown", required: true },
    connection: {
      ...provider.connection!,
      runtime: {
        ...provider.connection!.runtime!,
        source: "missing",
        actions: ["install"],
        managedVersion: null,
      },
    },
  };
}

/** The composer's model picker marks its content; other hosts do not. */
function Container(props: { readonly picker: boolean; readonly children: ReactNode }) {
  return (
    <div
      className="flex h-86 w-90"
      {...(props.picker ? { "data-model-picker-content": "true" } : {})}
    >
      {props.children}
    </div>
  );
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

const isVisible = (element: Element | null) =>
  element !== null && element.getBoundingClientRect().width > 0;

describe.each(PROVIDERS)("%s setup mark", (driver, name, methods) => {
  const states = [
    ["install", notInstalled(snapshot(driver, name, methods))],
    ...(methods.length > 0 ? [["sign-in", snapshot(driver, name, methods)] as const] : []),
  ] as const;

  it.each(states)(
    "shows the provider logo in the model picker's %s state, and the shield elsewhere",
    async (_state, provider) => {
      for (const picker of [true, false]) {
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
        root.render(
          <Container picker={picker}>
            <AssistedProviderSetupHost
              displayName={name}
              environmentId={EnvironmentId.make("local")}
              provider={provider}
              surface="composer"
            />
          </Container>,
        );
        await expect
          .poll(() => host!.querySelector("[data-assisted-setup-icon=true]"))
          .toBeTruthy();

        const logo = host.querySelector('[data-provider-setup-mark="logo"]');
        const shield = host.querySelector('[data-provider-setup-mark="shield"]');
        expect(isVisible(logo), `logo in ${picker ? "picker" : "other host"}`).toBe(picker);
        expect(isVisible(shield), `shield in ${picker ? "picker" : "other host"}`).toBe(!picker);
        if (picker) expect(logo!.querySelector("svg")!.getBoundingClientRect().width).toBe(32);

        root.unmount();
        host.remove();
        root = undefined;
        host = undefined;
      }
    },
  );
});
