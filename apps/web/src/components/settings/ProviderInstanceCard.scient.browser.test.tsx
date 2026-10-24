import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { getDriverOption } from "./providerDriverMeta";

const environmentId = EnvironmentId.make("local");

const driver = ProviderDriverKind.make("codex");

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-27T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

async function renderCard(
  liveProvider: ServerProvider,
  mode: ComponentProps<typeof ProviderInstanceCard>["mode"],
  overrides: Partial<ComponentProps<typeof ProviderInstanceCard>> = {},
) {
  return render(
    <ProviderInstanceCard
      environmentId={environmentId}
      instanceId={liveProvider.instanceId}
      instance={{ driver: liveProvider.driver }}
      driverOption={getDriverOption(liveProvider.driver)}
      liveProvider={liveProvider}
      mode={mode}
      onUpdate={() => undefined}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onHiddenModelsChange={() => undefined}
      onFavoriteModelsChange={() => undefined}
      onToggleFavorite={() => undefined}
      onModelOrderChange={() => undefined}
      {...overrides}
    />,
  );
}

describe("ProviderInstanceCard", () => {
  it("shows the account email by default and lets the user hide and reveal it", async () => {
    await using screen = await renderCard(
      provider({ auth: { status: "authenticated", email: "developer@example.com" } }),
      "editor",
    );
    expect(screen.container.textContent).toContain("Authenticated as");
    expect(screen.container.textContent).toContain("developer@example.com");

    const toggle = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle account email visibility"]',
    )!;
    await userEvent.click(toggle);
    expect(screen.container.textContent).not.toContain("developer@example.com");

    await userEvent.click(toggle);
    expect(toggle.textContent).toBe("developer@example.com");
  });
});

describe("Pi status copy", () => {
  const driver = ProviderDriverKind.make("pi");
  const liveProvider: ServerProvider = {
    instanceId: ProviderInstanceId.make("pi"),
    driver,
    enabled: true,
    installed: true,
    version: "0.84.4",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-09-05T00:00:00.000Z",
    models: [{ slug: "qa/text", name: "Test model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    message: "Pi reported 1 available model. Authentication is model-specific.",
  };

  async function render(
    mode: "list" | "editor",
    value = liveProvider,
    enabled = true,
    isUpdating = false,
  ) {
    await using screen = await renderCard(value, mode, {
      instance: { driver, enabled },
      isUpdating,
    });
    return screen.container.textContent ?? "";
  }

  it("keeps the healthy editor free of repeated model status", async () => {
    const markup = await render("editor");
    expect(markup).not.toContain("Models available");
    expect(markup).not.toContain("Authentication is model-specific");
    expect(markup).toContain("v0.84.4");
    expect(markup).toContain("Test model");
  });

  it("preserves a Pi discovery error in the editor", async () => {
    const markup = await render("editor", {
      ...liveProvider,
      status: "error",
      message: "Pi RPC timed out.",
    });
    expect(markup).toContain("Pi RPC timed out.");
  });

  // regression: 511bc318c4 fix(alignment): preserve Scient presentation and guarded reload
  it.each([
    { status: "error" as const, installed: true, message: "Pi RPC timed out." },
    { status: "error" as const, installed: false, message: "Pi is not installed." },
  ])("keeps $message on the right rather than adding left-column health copy", async (snapshot) => {
    const provider = { ...liveProvider, ...snapshot };
    const list = await render("list", provider);
    const editor = await render("editor", provider);
    expect(list).not.toContain("Not installed");
    expect(list).not.toContain("Needs attention");
    expect(list).not.toContain("Unavailable");
    expect(list).not.toContain(snapshot.message);
    expect(editor).toContain(snapshot.installed ? snapshot.message : "Not installed");
  });

  // regression: 511bc318c4 fix(alignment): preserve Scient presentation and guarded reload
  it("keeps warning headlines out of the compact provider list", async () => {
    const list = await render("list", {
      ...liveProvider,
      status: "warning",
      message: "Pi needs attention.",
    });
    expect(list).not.toContain("Needs attention");
    expect(list).not.toContain("Pi needs attention.");
  });

  it("keeps the disabled editor explicit despite a stale ready snapshot", async () => {
    const markup = await render("editor", liveProvider, false);
    expect(markup).toContain("Disabled");
  });

  it("keeps an update notice without restoring the repeated model explanation", async () => {
    const markup = await render("editor", {
      ...liveProvider,
      connection: {
        methods: [],
        canDisconnect: false,
        operation: null,
        runtime: {
          source: "scient_managed",
          supportTier: "fully_assisted",
          target: "darwin-arm64",
          actions: ["update"],
          managedVersion: "0.84.4",
          previousManagedVersion: null,
          operation: null,
          message: "Update available.",
        },
      },
    });
    expect(markup).toContain("Update available");
    expect(markup).not.toContain("Authentication is model-specific");
  });

  it.each(["list", "editor"] as const)(
    "reports native update progress in the quiet Pi %s without changing its runtime authority",
    async (mode) => {
      await using screen = await renderCard(
        {
          ...liveProvider,
          updateState: {
            status: "running",
            startedAt: "2026-10-08T00:00:00.000Z",
            finishedAt: null,
            message: "Installing package",
            output: null,
          },
        },
        mode,
        { instance: { driver, enabled: true }, isUpdating: true },
      );
      const markup = screen.container.textContent ?? "";
      expect(markup).toContain("Updating · Installing package");
      expect(screen.container.querySelector('[aria-live="polite"]')?.textContent).toContain(
        "Installing package",
      );
      expect(markup).not.toContain("Authentication is model-specific");
    },
  );

  it("keeps a failed native update actionable in the provider list", async () => {
    const markup = await render("list", {
      ...liveProvider,
      updateState: {
        status: "failed",
        startedAt: "2026-10-08T00:00:00.000Z",
        finishedAt: "2026-10-08T00:00:01.000Z",
        message: "Package installation failed",
        output: null,
      },
    });
    expect(markup).toContain("Package installation failed");
    expect(markup).not.toContain("Updating ·");
  });

  it("shows managed-runtime compatibility guidance without exposing an external installer", async () => {
    const managedProvider: ServerProvider = {
      ...liveProvider,
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "0.84.4",
        latestVersion: "0.85.0",
        updateCommand: "npm install -g pi-coding-agent@latest",
        canUpdate: true,
        canInstallVersion: true,
        checkedAt: "2026-09-05T00:00:00.000Z",
        message: null,
      },
      compatibilityAdvisory: {
        status: "broken",
        latestVersionStatus: "broken",
        message: "This release has a known issue. Use 0.83.0.",
        recommendedVersion: "0.83.0",
        recommendedRange: null,
      },
      connection: {
        methods: [],
        canDisconnect: false,
        operation: null,
        runtime: {
          source: "scient_managed",
          supportTier: "fully_assisted",
          target: "darwin-arm64",
          actions: ["update"],
          managedVersion: "0.84.4",
          previousManagedVersion: null,
          operation: null,
          message: "Update available.",
        },
      },
    };
    await using screen = await renderCard(managedProvider, "editor", {
      instance: { driver, enabled: true },
      onRunUpdate: () => undefined,
      onInstallRecommended: () => undefined,
    });
    const markup = screen.container.textContent ?? "";

    expect(markup).toContain("Update available");
    expect(markup).toContain("Incompatible");
    expect(markup).not.toContain("npm install -g pi-coding-agent@latest");
    expect(markup).not.toContain("Install v0.83.0");
  });
});

describe("Scient account presentation", () => {
  // regression: 5abec00b8c fix(providers): preserve account detail hierarchy
  it.each([
    { kind: "codex", authLabel: "ChatGPT Pro 20x Subscription" },
    { kind: "codex", authLabel: undefined },
  ])(
    "keeps $kind subscription ($authLabel) above its visible account row",
    async ({ kind, authLabel }) => {
      await using screen = await renderCard(
        provider({
          instanceId: ProviderInstanceId.make(kind),
          driver: ProviderDriverKind.make(kind),
          auth: {
            status: "authenticated",
            email: "developer@example.com",
            ...(authLabel ? { label: authLabel } : {}),
          },
        }),
        "editor",
      );
      const account = screen.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle account email visibility"]',
      )!;
      expect(account).not.toBeNull();
      expect(account.textContent).toBe("developer@example.com");
      expect(account.className).not.toContain("blur-");
      expect(screen.container.textContent).toContain("Authenticated as");
      if (authLabel) {
        const label = [...screen.container.querySelectorAll("p")].find(
          (element) => element.textContent === authLabel,
        )!;
        expect(label).toBeDefined();
        expect(label.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          account.getBoundingClientRect().top,
        );
        expect(label.nextElementSibling?.textContent).toContain("Authenticated as");
        expect(screen.container.textContent).not.toContain("\u00b7 " + authLabel);
      } else {
        expect(account.closest(".grid")?.firstElementChild?.textContent).toContain(
          "Authenticated as",
        );
      }
    },
  );

  it("keeps sign-in required out of an unselected left list row", async () => {
    const value = provider({
      instanceId: ProviderInstanceId.make("codex_work"),
      auth: { status: "unauthenticated", required: true },
      connection: { methods: ["codex_browser"], canDisconnect: false, operation: null },
    });
    await using screen = await renderCard(value, "list");
    expect(screen.container.querySelector('[aria-pressed="false"]')).not.toBeNull();
    expect(screen.container.textContent).not.toContain("Sign-in required");
    await screen[Symbol.asyncDispose]();
    await using editorScreen = await renderCard(value, "editor");
    expect(editorScreen.container.textContent).toContain("Sign-in required");
  });
});
