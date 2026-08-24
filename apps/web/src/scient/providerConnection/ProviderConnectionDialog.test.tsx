import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const repairNotice = vi.hoisted(() => ({ visible: false }));
const enableState = vi.hoisted(() => ({
  access: "granted" as const,
  canEnable: true,
  enable: vi.fn(async () => undefined),
}));

vi.mock("../../components/ui/dialog", () => ({
  Dialog: (props: { children?: ReactNode }) => props.children,
  DialogDescription: (props: { children?: ReactNode }) => <p>{props.children}</p>,
  DialogFooter: (props: { children?: ReactNode }) => <footer>{props.children}</footer>,
  DialogHeader: (props: { children?: ReactNode }) => <header>{props.children}</header>,
  DialogPanel: (props: { children?: ReactNode }) => <main>{props.children}</main>,
  DialogPopup: (props: { children?: ReactNode; className?: string }) => (
    <section className={props.className}>{props.children}</section>
  ),
  DialogTitle: (props: { children?: ReactNode }) => <h1>{props.children}</h1>,
}));

vi.mock("./AntigravityInlineSetup", () => ({
  AntigravityInlineSetup: () => <div>Antigravity lifecycle surface</div>,
}));
vi.mock("./ClaudeInlineSetup", () => ({
  ClaudeInlineSetup: (props: {
    accountAction?: ReactNode;
    managedRuntimePresentedExternally?: boolean;
  }) => (
    <div>
      Claude lifecycle surface
      {props.managedRuntimePresentedExternally ? " · Shared runtime management" : null}
      {props.accountAction}
    </div>
  ),
}));
vi.mock("./CodexInlineSetup", () => ({
  CodexInlineSetup: (props: {
    accountAction?: ReactNode;
    managedRuntimePresentedExternally?: boolean;
  }) => (
    <div>
      Codex lifecycle surface
      {props.managedRuntimePresentedExternally ? " · Shared runtime management" : null}
      {props.accountAction}
    </div>
  ),
}));
vi.mock("./DroidInlineSetup", () => ({
  DroidInlineSetup: (props: {
    accountAction?: ReactNode;
    managedRuntimePresentedExternally?: boolean;
  }) => (
    <div>
      Droid lifecycle surface
      {props.managedRuntimePresentedExternally ? " · Shared runtime management" : null}
      {props.accountAction}
    </div>
  ),
}));
vi.mock("./GrokInlineSetup", () => ({
  GrokInlineSetup: (props: {
    accountAction?: ReactNode;
    managedRuntimePresentedExternally?: boolean;
  }) => (
    <div>
      Grok lifecycle surface
      {props.managedRuntimePresentedExternally ? " · Shared runtime management" : null}
      {props.accountAction}
    </div>
  ),
}));
vi.mock("./CursorInlineSetup", () => ({
  CursorInlineSetup: (props: {
    accountAction?: ReactNode;
    managedRuntimePresentedExternally?: boolean;
  }) => (
    <div>
      Cursor lifecycle surface
      {props.managedRuntimePresentedExternally ? " · Shared runtime management" : null}
      {props.accountAction}
    </div>
  ),
}));
vi.mock("../../components/chat/ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: (props: { displayName: string }) => (
    <span data-provider-title-icon>{props.displayName} icon</span>
  ),
}));
vi.mock("./ProviderRuntimeSection", () => ({
  ProviderRuntimeSection: (props: { compact?: boolean; initialAction?: string }) => (
    <div>
      {props.compact ? "Compact managed runtime actions" : "Managed runtime actions"}
      {props.initialAction ? ` · ${props.initialAction} confirmation requested` : null}
    </div>
  ),
}));
vi.mock("./useTransientRepairSuccess", () => ({
  useTransientRepairSuccess: () => ({
    repairSucceededRecently: repairNotice.visible,
    reportRuntimeActionSucceeded: vi.fn(),
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    startProviderConnection: Symbol("start"),
    cancelProviderConnection: Symbol("cancel"),
    submitProviderAuthorizationCode: Symbol("submit"),
    disconnectProvider: Symbol("disconnect"),
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));
vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({
    disconnect: vi.fn(async () => undefined),
  }),
}));
vi.mock("./useProviderEnableAction", () => ({
  useProviderEnableAction: () => enableState,
}));

import { ProviderConnectionDialog } from "./ProviderConnectionDialog";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  displayName: "Antigravity",
  enabled: true,
  installed: true,
  version: "1.1.17",
  status: "ready",
  auth: { status: "authenticated", required: true, label: "Google account" },
  checkedAt: "2026-08-22T08:00:00.000Z",
  models: [
    {
      slug: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["antigravity_google"],
    canDisconnect: true,
    operation: null,
    runtime: {
      source: "scient_managed",
      supportTier: "fully_assisted",
      target: "darwin-arm64",
      actions: ["repair", "remove"],
      managedVersion: "1.1.17",
      previousManagedVersion: null,
      operation: null,
      message: "Managed Antigravity is ready.",
    },
  },
};

describe("ProviderConnectionDialog", () => {
  beforeEach(() => {
    repairNotice.visible = false;
  });

  it("keeps the established Antigravity management surface", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Antigravity"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={provider}
      />,
    );

    expect(markup).not.toContain("Antigravity lifecycle surface");
    expect(markup).not.toContain("Codex lifecycle surface");
    expect(markup).not.toContain("Claude lifecycle surface");
    expect(markup).not.toContain("Installation");
    expect(markup).toContain("Compact managed runtime actions");
    expect(markup).toContain("Connected");
    expect(markup).toContain("Antigravity icon");
    expect(markup).toContain(">Sign out<");
    expect(markup).not.toContain("Sign out on this computer");
    expect(markup).toContain("items-center justify-between");
    expect(markup).toContain("me-2 shrink-0 self-end text-destructive/80");
    expect(markup).not.toContain("<footer>");
    expect(markup).not.toContain(">Close<");
  });

  it.each([
    ["codex", "Codex", "Codex lifecycle surface", "codex_browser"],
    ["claudeAgent", "Claude", "Claude lifecycle surface", "claude_subscription"],
    ["droid", "Droid", "Droid lifecycle surface", "droid_device_pairing"],
    ["cursor", "Cursor", "Cursor lifecycle surface", "cursor_browser"],
    ["grok", "Grok", "Grok lifecycle surface", "grok_account"],
  ] as const)(
    "keeps the assisted %s dialog compact and fully manageable",
    (driver, name, surface, method) => {
      const markup = renderToStaticMarkup(
        <ProviderConnectionDialog
          displayName={name}
          environmentId={EnvironmentId.make("local")}
          onOpenChange={vi.fn()}
          open
          provider={{
            ...provider,
            instanceId: ProviderInstanceId.make(driver),
            driver: ProviderDriverKind.make(driver),
            displayName: name,
            auth: {
              status: "authenticated",
              required: true,
              label: `${name} account`,
              ...(driver === "grok" ? { type: "grok_account" } : {}),
            },
            connection: {
              methods: [method],
              canDisconnect: true,
              operation: null,
              runtime: provider.connection!.runtime!,
            },
          }}
        />,
      );

      expect(markup).toContain(`${name} icon`);
      expect(markup).toContain("max-w-[26rem]");
      expect(markup).toContain("Compact managed runtime actions");
      expect(markup).toContain("Shared runtime management");
      expect(markup).toContain(surface);
      expect(markup.indexOf("Compact managed runtime actions")).toBeLessThan(
        markup.indexOf(surface),
      );
      expect(markup).toContain(">Sign out<");
      expect(markup).not.toContain("min-h-64");
      expect(markup).not.toContain(">Close<");
      expect(markup).not.toContain("<footer>");
    },
  );

  it("keeps maintenance and enable available for a disabled managed provider", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Droid"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make("droid"),
          driver: ProviderDriverKind.make("droid"),
          displayName: "Droid",
          enabled: false,
          installed: false,
          status: "disabled",
          auth: { status: "unauthenticated", required: true },
          connection: {
            methods: ["droid_device_pairing"],
            canDisconnect: false,
            operation: null,
            runtime: provider.connection!.runtime!,
          },
        }}
      />,
    );

    expect(markup).toContain("Compact managed runtime actions");
    expect(markup).toContain("Droid is disabled");
    expect(markup).toContain(">Enable<");
    expect(markup).not.toContain("Droid lifecycle surface");
  });

  it("reveals sign-in after a managed install settles instead of leaving runtime focus blank", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Grok"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          displayName: "Grok",
          installed: false,
          status: "warning",
          auth: { status: "unauthenticated", required: true, type: "grok_account" },
          connection: {
            methods: ["grok_account"],
            canDisconnect: false,
            operation: null,
            runtime: provider.connection!.runtime!,
          },
        }}
      />,
    );

    expect(markup).toContain("Compact managed runtime actions");
    expect(markup).toContain("Grok lifecycle surface");
  });

  it.each([
    ["codex", "Codex", "Codex lifecycle surface", "codex_browser"],
    ["claudeAgent", "Claude", "Claude lifecycle surface", "claude_subscription"],
    ["droid", "Droid", "Droid lifecycle surface", "droid_device_pairing"],
    ["grok", "Grok", "Grok lifecycle surface", "grok_account"],
  ] as const)(
    "opens the reviewed install flow directly for missing assisted %s runtimes",
    (driver, name, surface, method) => {
      const markup = renderToStaticMarkup(
        <ProviderConnectionDialog
          displayName={name}
          environmentId={EnvironmentId.make("local")}
          initialRuntimeAction="install"
          onOpenChange={vi.fn()}
          open
          provider={{
            ...provider,
            instanceId: ProviderInstanceId.make(driver),
            driver: ProviderDriverKind.make(driver),
            displayName: name,
            installed: false,
            version: null,
            status: "error",
            auth: {
              status: "unauthenticated",
              required: true,
              ...(driver === "grok" ? { type: "grok_account" as const } : {}),
            },
            connection: {
              methods: [method],
              canDisconnect: false,
              operation: null,
              runtime: {
                ...provider.connection!.runtime!,
                source: "missing",
                actions: ["install"],
                managedVersion: null,
              },
            },
          }}
        />,
      );

      expect(markup).toContain("Compact managed runtime actions");
      expect(markup).toContain("install confirmation requested");
      expect(markup).not.toContain(surface);
    },
  );

  it("falls back to the Grok lifecycle surface when an install request lacks runtime data", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Grok"
        environmentId={EnvironmentId.make("local")}
        initialRuntimeAction="install"
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          displayName: "Grok",
          installed: false,
          version: null,
          status: "error",
          auth: {
            status: "unauthenticated",
            required: true,
            type: "grok_account",
          },
          connection: {
            methods: ["grok_account"],
            canDisconnect: false,
            operation: null,
          },
        }}
      />,
    );

    expect(markup).toContain("Grok lifecycle surface");
    expect(markup).not.toContain("install confirmation requested");
  });

  it("keeps Cursor installation visible when opened from the settings Install action", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Cursor"
        environmentId={EnvironmentId.make("local")}
        initialRuntimeAction="install"
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          displayName: "Cursor",
          installed: false,
          status: "error",
          auth: { status: "unauthenticated", required: true },
          models: [],
          connection: {
            methods: ["cursor_browser"],
            canDisconnect: false,
            operation: null,
            runtime: {
              ...provider.connection!.runtime!,
              source: "missing",
              actions: ["install"],
              managedVersion: null,
            },
          },
        }}
      />,
    );

    expect(markup).toContain("Cursor lifecycle surface");
    expect(markup).not.toContain("Compact managed runtime actions");
  });

  it("keeps the Cursor install surface mounted when the runtime operation begins", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Cursor"
        environmentId={EnvironmentId.make("local")}
        initialRuntimeAction="install"
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          displayName: "Cursor",
          installed: false,
          status: "warning",
          auth: {
            status: "authenticated",
            required: true,
            email: "cursor@example.com",
            label: "Cursor Pro Subscription",
          },
          models: [],
          connection: {
            methods: ["cursor_browser"],
            canDisconnect: true,
            operation: null,
            runtime: {
              ...provider.connection!.runtime!,
              source: "missing",
              actions: ["install"],
              managedVersion: null,
              operation: {
                operationId: "cursor-install",
                action: "install",
                status: "preparing",
                startedAt: "2026-08-23T08:00:00.000Z",
                finishedAt: null,
                message: "Preparing the provider runtime operation.",
              },
            },
          },
        }}
      />,
    );

    expect(markup).toContain("Cursor lifecycle surface");
    expect(markup).not.toContain("Compact managed runtime actions");
  });

  it("drops the stale Cursor install intent after managed installation finishes", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Cursor"
        environmentId={EnvironmentId.make("local")}
        initialRuntimeAction="install"
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          displayName: "Cursor",
          auth: {
            status: "authenticated",
            required: true,
            email: "cursor@example.com",
            label: "Cursor Pro Subscription",
          },
          connection: {
            methods: ["cursor_browser"],
            canDisconnect: true,
            operation: null,
            runtime: {
              ...provider.connection!.runtime!,
              actions: ["repair", "remove"],
            },
          },
        }}
      />,
    );

    expect(markup).toContain("Compact managed runtime actions");
    expect(markup).toContain("Cursor lifecycle surface");
    expect(markup).not.toContain("install confirmation requested");
  });

  it("omits a read-only system-runtime row when an older server provides no diagnostics", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Claude"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Claude",
          auth: { status: "authenticated", required: true, label: "Claude subscription" },
          connection: {
            methods: ["claude_subscription"],
            canDisconnect: true,
            operation: null,
            runtime: {
              ...provider.connection!.runtime!,
              source: "system",
              actions: [],
              managedVersion: null,
            },
          },
        }}
      />,
    );

    expect(markup).not.toContain("Compact managed runtime actions");
    expect(markup).not.toContain("Shared runtime management");
    expect(markup).toContain("Claude lifecycle surface");
    expect(markup).toContain(">Sign out<");
  });

  it("presents a qualified system-to-managed action once, outside provider diagnostics", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Codex"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex",
          status: "warning",
          auth: { status: "unauthenticated", required: true },
          connection: {
            methods: ["codex_browser"],
            canDisconnect: false,
            operation: null,
            runtime: {
              ...provider.connection!.runtime!,
              source: "system",
              actions: ["install"],
              managedVersion: null,
            },
          },
        }}
      />,
    );

    expect(markup).toContain("Compact managed runtime actions");
    expect(markup).toContain("Shared runtime management");
    expect(markup).toContain("Codex lifecycle surface");
  });

  it.each([
    ["codex", "Codex", "Codex lifecycle surface", "codex_browser"],
    ["claudeAgent", "Claude", "Claude lifecycle surface", "claude_subscription"],
    ["droid", "Droid", "Droid lifecycle surface", "droid_device_pairing"],
    ["cursor", "Cursor", "Cursor lifecycle surface", "cursor_browser"],
    ["grok", "Grok", "Grok lifecycle surface", "grok_account"],
  ] as const)(
    "keeps managed runtime actions visible while assisted %s is signed out",
    (driver, name, surface, method) => {
      const markup = renderToStaticMarkup(
        <ProviderConnectionDialog
          displayName={name}
          environmentId={EnvironmentId.make("local")}
          onOpenChange={vi.fn()}
          open
          provider={{
            ...provider,
            instanceId: ProviderInstanceId.make(driver),
            driver: ProviderDriverKind.make(driver),
            displayName: name,
            status: "warning",
            auth: {
              status: "unauthenticated",
              required: true,
              ...(driver === "grok" ? { type: "grok_account" as const } : {}),
            },
            connection: {
              methods: [method],
              canDisconnect: false,
              operation: null,
              runtime: provider.connection!.runtime!,
            },
          }}
        />,
      );

      expect(markup).toContain("Compact managed runtime actions");
      expect(markup).toContain("Shared runtime management");
      expect(markup).toContain(surface);
      expect(markup).not.toContain(">Sign out<");
    },
  );

  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
  ] as const)("routes assisted %s removal through the shared confirmation flow", (driver, name) => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName={name}
        environmentId={EnvironmentId.make("local")}
        initialRuntimeAction="remove"
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make(driver),
          driver: ProviderDriverKind.make(driver),
          displayName: name,
          auth: { status: "authenticated", required: true, label: `${name} account` },
          connection: {
            methods: driver === "codex" ? ["codex_browser"] : ["claude_subscription"],
            canDisconnect: true,
            operation: null,
            runtime: provider.connection!.runtime!,
          },
        }}
      />,
    );

    expect(markup).toContain("remove confirmation requested");
    expect(markup).not.toContain(`${name} lifecycle surface`);
    expect(markup).not.toContain(">Sign out<");
  });

  it("shows repair success beside the provider name only while the transient notice is active", () => {
    repairNotice.visible = true;
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Antigravity"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={provider}
      />,
    );

    expect(markup).toContain("Antigravity icon</span></span><span>Antigravity</span>");
    expect(markup).toContain("Repair successful");
    expect(markup).toContain('role="status"');
  });

  it("uses the same icon title and X-only dismissal for a generic provider", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="OpenCode"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          displayName: "OpenCode",
          auth: { status: "unauthenticated", required: false },
          connection: { methods: [], canDisconnect: false, operation: null },
        }}
      />,
    );

    expect(markup).toContain("OpenCode icon");
    expect(markup).not.toContain(">Close<");
    expect(markup).not.toContain("<footer>");
  });

  it("uses explicit Google sign-in wording for Antigravity", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Antigravity"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          status: "error",
          auth: { status: "unauthenticated", required: true },
          models: [],
          connection: {
            ...provider.connection!,
            canDisconnect: false,
          },
        }}
      />,
    );

    expect(markup).toContain("Sign in required");
    expect(markup).toContain("existing subscription");
    expect(markup).toContain("Sign in with Google");
    expect(markup).toContain("border-transparent");
    expect(markup).toContain("text-primary");
    expect(markup).not.toContain("text-primary-foreground");
    expect(markup).not.toContain("Continue in browser");
  });

  it("keeps active runtime work focused on its own bottom action", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Antigravity"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          connection: {
            ...provider.connection!,
            runtime: {
              ...provider.connection!.runtime!,
              operation: {
                operationId: "install-active",
                action: "install",
                status: "downloading",
                startedAt: "2026-08-23T00:00:00.000Z",
                finishedAt: null,
                message: "Downloading Antigravity.",
              },
            },
          },
        }}
      />,
    );

    expect(markup).toContain("Compact managed runtime actions");
    expect(markup).not.toContain(">Connected<");
    expect(markup).not.toContain(">Sign out<");
    expect(markup).not.toContain("<footer>");
  });

  it("preserves the authorization-code paste step for an existing operation without the optional capability flag", () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionDialog
        displayName="Antigravity"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={vi.fn()}
        open
        provider={{
          ...provider,
          status: "error",
          auth: { status: "unauthenticated", required: true },
          models: [],
          connection: {
            ...provider.connection!,
            canDisconnect: false,
            operation: {
              operationId: "google-sign-in",
              method: "antigravity_google",
              status: "waiting_for_browser",
              startedAt: "2026-08-22T08:00:00.000Z",
              finishedAt: null,
              message: "Finish signing in with Google.",
              authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
              authorizationUrlKind: "primary",
            },
          },
        }}
      />,
    );

    expect(markup).toContain("Sign in with Google, then paste the authorization code below.");
    expect(markup).toContain("Paste authorization code");
    expect(markup).toContain("Reopen Google sign-in");
    const reopenButtonStart = markup.lastIndexOf(
      "<button",
      markup.indexOf("Reopen Google sign-in"),
    );
    const reopenButton = markup.slice(
      reopenButtonStart,
      markup.indexOf("</button>", reopenButtonStart),
    );
    expect(reopenButton).not.toContain("w-full");
    expect(reopenButton).not.toContain("border-input");
  });
});
