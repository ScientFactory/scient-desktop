import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  nextProviderEnvironmentWithFieldValue,
  providerEnvironmentWithoutNames,
  ProviderInstanceCard,
  readProviderEnvironmentVariable,
} from "./ProviderInstanceCard";
import { getDriverOption } from "./providerDriverMeta";

const environmentId = EnvironmentId.make("local");

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

  function render(
    mode: "list" | "editor",
    value = liveProvider,
    enabled = true,
    isUpdating = false,
  ) {
    return renderToStaticMarkup(
      createElement(ProviderInstanceCard, {
        environmentId,
        instanceId: value.instanceId,
        instance: { driver, enabled },
        driverOption: getDriverOption(driver),
        liveProvider: value,
        mode,
        isUpdating,
        onUpdate: () => undefined,
        hiddenModels: [],
        favoriteModels: [],
        modelOrder: [],
        onHiddenModelsChange: () => undefined,
        onFavoriteModelsChange: () => undefined,
        onModelOrderChange: () => undefined,
      }),
    );
  }

  it.each(["list", "editor"] as const)(
    "keeps the healthy %s free of repeated model status",
    (mode) => {
      const markup = render(mode);
      expect(markup).not.toContain("Models available");
      expect(markup).not.toContain("Authentication is model-specific");
      expect(markup).toContain("v0.84.4");
      if (mode === "editor") expect(markup).toContain("Test model");
    },
  );

  it.each(["list", "editor"] as const)("preserves a Pi discovery error in the %s", (mode) => {
    const markup = render(mode, { ...liveProvider, status: "error", message: "Pi RPC timed out." });
    if (mode === "editor") expect(markup).toContain("Pi RPC timed out.");
    else expect(markup).not.toContain("Pi RPC timed out.");
  });

  it.each(["list", "editor"] as const)(
    "keeps the disabled %s explicit despite a stale ready snapshot",
    (mode) => {
      const markup = render(mode, liveProvider, false);
      if (mode === "editor") expect(markup).toContain("Disabled");
      else expect(markup).not.toContain("Disabled");
    },
  );

  it("keeps an update notice without restoring the repeated model explanation", () => {
    const markup = render("editor", {
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
    (mode) => {
      const markup = render(
        mode,
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
        true,
        true,
      );
      expect(markup).toContain("Updating · Installing package");
      expect(markup).toContain('aria-live="polite"');
      expect(markup).not.toContain("Authentication is model-specific");
    },
  );

  it("keeps a failed native update actionable in the provider list", () => {
    const markup = render("list", {
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

  it("shows managed-runtime compatibility guidance without exposing an external installer", () => {
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
    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceCard, {
        environmentId,
        instanceId: managedProvider.instanceId,
        instance: { driver, enabled: true },
        driverOption: getDriverOption(driver),
        liveProvider: managedProvider,
        mode: "editor",
        onUpdate: () => undefined,
        onRunUpdate: () => undefined,
        onInstallRecommended: () => undefined,
        hiddenModels: [],
        favoriteModels: [],
        modelOrder: [],
        onHiddenModelsChange: () => undefined,
        onFavoriteModelsChange: () => undefined,
        onModelOrderChange: () => undefined,
      }),
    );

    expect(markup).toContain("Update available");
    expect(markup).toContain("Incompatible");
    expect(markup).not.toContain("npm install -g pi-coding-agent@latest");
    expect(markup).not.toContain("Install v0.83.0");
  });
});

describe("deriveProviderModelsForDisplay", () => {
  it.each(["custom:scient-fixture", "scient_fixture/model"])(
    "retains discovered connection %s independently of the legacy list",
    (slug) => {
      const liveModels: ServerProviderModel[] = [
        { slug, name: "Connected model", isCustom: false, capabilities: null },
      ];
      expect(deriveProviderModelsForDisplay({ liveModels, customModels: [] })).toEqual(liveModels);
      expect(deriveProviderModelsForDisplay({ liveModels: [], customModels: [] })).toEqual([]);
    },
  );

  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: [{ slug: "kept-custom", name: "kept-custom", capabilities: null }],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("prefers the entry's name and capabilities over the stale live custom row", () => {
    const liveCapabilities = { optionDescriptors: [] };
    const customCapabilities = {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: [{ id: "high", label: "High", isDefault: true }],
          currentValue: "high",
        },
      ],
    };
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      { slug: "bare", name: "bare", isCustom: true, capabilities: liveCapabilities },
      { slug: "named", name: "named", isCustom: true, capabilities: liveCapabilities },
    ];

    const display = deriveProviderModelsForDisplay({
      liveModels,
      customModels: [
        { slug: "bare", name: "bare", capabilities: null },
        { slug: "named", name: "My Model", capabilities: customCapabilities },
      ],
    });

    // A bare entry keeps the driver default the server filled in.
    expect(display[0]).toEqual({
      slug: "bare",
      name: "bare",
      isCustom: true,
      capabilities: liveCapabilities,
    });
    expect(display[1]).toEqual({
      slug: "named",
      name: "My Model",
      isCustom: true,
      capabilities: customCapabilities,
    });
  });

  it.each([
    { kind: "codex", authLabel: "ChatGPT Pro 20x Subscription" },
    { kind: "claudeAgent", authLabel: "Claude Max" },
    { kind: "codex", authLabel: undefined },
  ])(
    "keeps $kind subscription ($authLabel) above its visible account row",
    ({ kind, authLabel }) => {
      const instanceId = ProviderInstanceId.make(kind);
      const driver = ProviderDriverKind.make(kind);
      const liveProvider: ServerProvider = {
        instanceId,
        driver,
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: {
          status: "authenticated",
          email: "developer@example.com",
          ...(authLabel ? { label: authLabel } : {}),
        },
        checkedAt: "2026-08-27T12:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      };

      const markup = renderToStaticMarkup(
        createElement(ProviderInstanceCard, {
          environmentId,
          instanceId,
          instance: { driver },
          driverOption: undefined,
          liveProvider,
          mode: "editor",
          onUpdate: () => undefined,
          hiddenModels: [],
          favoriteModels: [],
          modelOrder: [],
          onHiddenModelsChange: () => undefined,
          onFavoriteModelsChange: () => undefined,
          onModelOrderChange: () => undefined,
        }),
      );

      expect(markup).toContain("Authenticated as");
      expect(markup).toContain('aria-label="Toggle account email visibility"');
      expect(markup).not.toContain("blur-[2px]");
      expect(markup).toContain("developer@example.com");
      // Block siblings, not two inline spans that share a line at wide widths.
      // Keep this assertion tied to the account area rather than the whole card.
      if (authLabel) {
        expect(markup).toContain(
          `<p class="text-sm text-foreground/80 [overflow-wrap:anywhere]">${authLabel}</p><div class="flex flex-wrap items-center gap-x-1.5 gap-y-1"><span>Authenticated as</span>`,
        );
        expect(markup).not.toContain(`· ${authLabel}`);
      } else {
        expect(markup).toContain(
          '<div class="grid gap-1"><div class="flex flex-wrap items-center gap-x-1.5 gap-y-1"><span>Authenticated as</span>',
        );
      }
    },
  );
  it("keeps failed probe details in the editor and the list row concise", () => {
    const instanceId = ProviderInstanceId.make("codex_work");
    const driver = ProviderDriverKind.make("codex");
    const message =
      "Codex app-server provider probe failed: Cannot create Codex shadow home entry 'auth.json' because '/home/me/.codex-t3/work/auth.json' already exists and is not a symlink.";
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      message,
    };
    const props = {
      environmentId,
      instanceId,
      instance: { driver },
      driverOption: undefined,
      liveProvider,
      onUpdate: () => undefined,
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
      onHiddenModelsChange: () => undefined,
      onFavoriteModelsChange: () => undefined,
      onModelOrderChange: () => undefined,
    } as const;

    for (const mode of ["list", "editor"] as const) {
      const markup = renderToStaticMarkup(createElement(ProviderInstanceCard, { ...props, mode }));
      if (mode === "editor") {
        expect(markup).toContain("Unavailable");
        expect(markup).toContain("is not a symlink");
      } else {
        expect(markup).not.toContain("Unavailable");
        expect(markup).not.toContain("is not a symlink");
      }
    }
  });
});

describe("provider environment helpers", () => {
  const cursorApiKeyField = {
    name: "CURSOR_API_KEY",
    label: "Cursor API key",
    sensitive: true,
  };

  it("writes dedicated provider secrets as sensitive environment variables", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "EXTRA_FLAG", value: "1", sensitive: false }],
        cursorApiKeyField,
        "  cursor-key  ",
      ),
    ).toEqual([
      { name: "EXTRA_FLAG", value: "1", sensitive: false },
      { name: "CURSOR_API_KEY", value: "cursor-key", sensitive: true },
    ]);
  });

  it("replaces redacted provider secrets without preserving redaction markers", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [
          {
            name: "CURSOR_API_KEY",
            value: "",
            sensitive: true,
            valueRedacted: true,
          },
        ],
        cursorApiKeyField,
        "new-key",
      ),
    ).toEqual([{ name: "CURSOR_API_KEY", value: "new-key", sensitive: true }]);
  });

  it("applies the secure field default when replacing an existing non-sensitive value", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "OPENAI_API_KEY", value: "old-key", sensitive: false }],
        {
          name: "OPENAI_API_KEY",
          label: "OpenAI API key",
        },
        "new-key",
      ),
    ).toEqual([{ name: "OPENAI_API_KEY", value: "new-key", sensitive: true }]);
  });

  it("separates dedicated provider secrets from the generic environment table", () => {
    const environment = [
      { name: "CURSOR_API_KEY", value: "cursor-key", sensitive: true },
      { name: "EXTRA_FLAG", value: "1", sensitive: false },
    ];

    expect(readProviderEnvironmentVariable(environment, "CURSOR_API_KEY")?.value).toBe(
      "cursor-key",
    );
    expect(providerEnvironmentWithoutNames(environment, new Set(["CURSOR_API_KEY"]))).toEqual([
      { name: "EXTRA_FLAG", value: "1", sensitive: false },
    ]);
  });
});
