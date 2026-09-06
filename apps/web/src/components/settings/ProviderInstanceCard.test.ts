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

import { deriveProviderModelsForDisplay, ProviderInstanceCard } from "./ProviderInstanceCard";
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

  function render(mode: "list" | "editor", value = liveProvider, enabled = true) {
    return renderToStaticMarkup(
      createElement(ProviderInstanceCard, {
        environmentId,
        instanceId: value.instanceId,
        instance: { driver, enabled },
        driverOption: getDriverOption(driver),
        liveProvider: value,
        mode,
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
    expect(
      render(mode, { ...liveProvider, status: "error", message: "Pi RPC timed out." }),
    ).toContain("Pi RPC timed out.");
  });

  it.each(["list", "editor"] as const)(
    "keeps the disabled %s explicit despite a stale ready snapshot",
    (mode) => {
      expect(render(mode, liveProvider, false)).toContain("Disabled");
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

  it("shows the provider email by default while retaining the visibility control", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated", email: "developer@example.com" },
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
  });
  it("surfaces a failed probe message in both the list row and the editor", () => {
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
      expect(markup).toContain("Unavailable");
      expect(markup).toContain("is not a symlink");
    }
  });
});
