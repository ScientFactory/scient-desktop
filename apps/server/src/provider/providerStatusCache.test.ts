import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerProvider as ServerProviderSchema,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";

import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const providerSnapshotJson = Schema.fromJsonString(ServerProviderSchema);
const decodeProviderSnapshotJson = Schema.decodeUnknownEffect(providerSnapshotJson);
const encodeProviderSnapshotJson = Schema.encodeEffect(providerSnapshotJson);

it("orders provider snapshots canonically and keeps custom instances stable", () => {
  const antigravity = ProviderDriverKind.make("antigravity");
  const providers = [
    makeProvider(ProviderDriverKind.make("zeta")),
    makeProvider(antigravity, { instanceId: ProviderInstanceId.make("antigravity_work") }),
    makeProvider(ProviderDriverKind.make("cursor")),
    makeProvider(antigravity, { instanceId: ProviderInstanceId.make("antigravity_personal") }),
    makeProvider(ProviderDriverKind.make("codex")),
    makeProvider(antigravity),
    makeProvider(ProviderDriverKind.make("alpha")),
    makeProvider(ProviderDriverKind.make("claudeAgent")),
  ];

  assert.deepStrictEqual(
    orderProviderSnapshots(providers).map((provider) => provider.instanceId),
    [
      "codex",
      "claudeAgent",
      "antigravity",
      "antigravity_work",
      "antigravity_personal",
      "cursor",
      "alpha",
      "zeta",
    ],
  );
});

const makeProvider = (
  provider: ProviderDriverKind,
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(provider),
  driver: provider,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it.layer(NodeServices.layer)("providerStatusCache", (it) => {
  it.effect("logs structural diagnostics without retaining invalid cache contents", () => {
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>((options) => {
      if (Array.isArray(options.message)) {
        messages.push(...options.message);
      } else {
        messages.push(options.message);
      }
    });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-cache-invalid-" });
      const cachePath = `${tempDir}/provider.json`;
      const secretCacheValue = "secret-cache-value";
      yield* fs.writeFileString(cachePath, `{ "token": "${secretCacheValue}" }`);

      const result = yield* readProviderStatusCache(cachePath);

      assert.strictEqual(result, undefined);
      const failure = messages.find(
        (message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null && "path" in message,
      );
      assert.exists(failure);
      assert.strictEqual(failure.path, cachePath);
      assert.strictEqual(typeof failure.errorTag, "string");
      assert.ok(!("cause" in failure));
      assert.ok(!("issues" in failure));
      assert.ok(!Object.values(failure).map(String).join("\n").includes(secretCacheValue));
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("writes and reads provider status snapshots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-cache-" });
      const codexProvider = makeProvider(CODEX_DRIVER);
      const claudeProvider = makeProvider(CLAUDE_AGENT_DRIVER, {
        status: "warning",
        auth: { status: "unknown" },
      });
      const openCodeProvider = makeProvider(OPENCODE_DRIVER, {
        status: "warning",
        auth: { status: "unknown", type: "opencode" },
      });
      const codexPath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
      });
      const claudePath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")),
      });
      const openCodePath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("opencode")),
      });

      yield* writeProviderStatusCache({
        filePath: codexPath,
        provider: codexProvider,
      });
      yield* writeProviderStatusCache({
        filePath: claudePath,
        provider: claudeProvider,
      });
      yield* writeProviderStatusCache({
        filePath: openCodePath,
        provider: openCodeProvider,
      });

      assert.deepStrictEqual(yield* readProviderStatusCache(codexPath), codexProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(claudePath), claudeProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(openCodePath), openCodeProvider);
    }),
  );

  it.effect("does not persist process-local provider operations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-provider-cache-transient-",
      });
      const cachePath = `${tempDir}/cursor.json`;
      const cursorProvider = makeProvider(ProviderDriverKind.make("cursor"), {
        probePending: true,
        updateState: {
          status: "running",
          startedAt: "2026-08-23T13:34:28.000Z",
          finishedAt: null,
          message: "Updating Cursor.",
          output: null,
        },
        connection: {
          methods: ["cursor_browser"],
          canDisconnect: true,
          operation: {
            operationId: "connection-current-process",
            method: "cursor_browser",
            status: "waiting_for_browser",
            startedAt: "2026-08-23T13:34:28.000Z",
            finishedAt: null,
            message: "Waiting for browser sign in.",
            authorizationUrl: "https://example.invalid/secret-flow",
          },
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["repair", "remove"],
            managedVersion: "2026.08.11-e8db854",
            previousManagedVersion: null,
            operation: {
              operationId: "runtime-current-process",
              action: "remove",
              status: "removing",
              startedAt: "2026-08-23T13:34:28.000Z",
              finishedAt: null,
              message: "Removing Scient's private Cursor runtime.",
            },
            message: "Managed Cursor is ready.",
          },
        },
      });

      yield* writeProviderStatusCache({ filePath: cachePath, provider: cursorProvider });

      const raw = yield* fs.readFileString(cachePath);
      const persisted = yield* decodeProviderSnapshotJson(raw);
      assert.strictEqual(persisted.probePending, undefined);
      assert.strictEqual(persisted.updateState, undefined);
      assert.strictEqual(persisted.connection?.operation, null);
      assert.strictEqual(persisted.connection?.runtime?.operation, null);
      assert.strictEqual(persisted.connection?.runtime?.source, "scient_managed");
      assert.deepStrictEqual(persisted.connection?.runtime?.actions, ["repair", "remove"]);
      assert.ok(!raw.includes("secret-flow"));
      assert.ok(!raw.includes("probePending"));
      assert.ok(!raw.includes("connection-current-process"));
      assert.ok(!raw.includes("runtime-current-process"));

      // Simulate a cache written by an older build and verify recovery does
      // not revive operations whose owning process no longer exists.
      yield* fs.writeFileString(cachePath, yield* encodeProviderSnapshotJson(cursorProvider));
      const recovered = yield* readProviderStatusCache(cachePath);
      assert.exists(recovered);
      assert.strictEqual(recovered.probePending, undefined);
      assert.strictEqual(recovered.updateState, undefined);
      assert.strictEqual(recovered.connection?.operation, null);
      assert.strictEqual(recovered.connection?.runtime?.operation, null);
    }),
  );

  it("hydrates cached provider status while preserving current settings-derived models", () => {
    const cachedCodex = makeProvider(CODEX_DRIVER, {
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "gpt-5-mini",
          name: "GPT-5 Mini",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Cached message",
      skills: [
        {
          name: "github:gh-fix-ci",
          path: "/tmp/skills/gh-fix-ci/SKILL.md",
          enabled: true,
          displayName: "CI Debug",
        },
      ],
    });
    const fallbackCodex = makeProvider(CODEX_DRIVER, {
      probePending: true,
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Pending refresh",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      {
        ...(({ probePending: _probePending, ...rest }) => rest)(fallbackCodex),
        models: [
          ...fallbackCodex.models,
          {
            slug: "gpt-5-mini",
            name: "GPT-5 Mini",
            isCustom: false,
            capabilities: emptyCapabilities,
          },
        ],
        installed: cachedCodex.installed,
        version: cachedCodex.version,
        status: cachedCodex.status,
        auth: cachedCodex.auth,
        checkedAt: cachedCodex.checkedAt,
        slashCommands: cachedCodex.slashCommands,
        skills: cachedCodex.skills,
        message: cachedCodex.message,
      },
    );
  });

  it("drops cached Claude aliases while preserving the current curated and custom catalog", () => {
    const cachedClaude = makeProvider(CLAUDE_AGENT_DRIVER, {
      models: [
        {
          slug: "default",
          name: "Default (recommended)",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
        {
          slug: "haiku",
          name: "Haiku",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
    });
    const fallbackClaude = makeProvider(CLAUDE_AGENT_DRIVER, {
      models: [
        {
          slug: "claude-sonnet-4-6",
          name: "Sonnet 4.6",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
        {
          slug: "laboratory-preview",
          name: "laboratory-preview",
          isCustom: true,
          capabilities: emptyCapabilities,
        },
      ],
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedClaude,
        fallbackProvider: fallbackClaude,
      }).models,
      fallbackClaude.models,
    );
  });

  it("does not resurrect cached custom models that settings no longer declare", () => {
    const builtIn = {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    } as const;
    const cachedCodex = makeProvider(CODEX_DRIVER, {
      models: [
        builtIn,
        {
          slug: "removed-custom",
          name: "removed-custom",
          isCustom: true,
          capabilities: emptyCapabilities,
        },
      ],
    });
    const fallbackCodex = makeProvider(CODEX_DRIVER, { models: [builtIn] });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: fallbackCodex,
      }).models,
      [builtIn],
    );
  });

  it("ignores stale cached enabled state when the provider is now disabled", () => {
    const cachedCodex = makeProvider(CODEX_DRIVER, {
      checkedAt: "2026-04-10T12:00:00.000Z",
      message: "Cached ready status",
    });
    const disabledFallback = makeProvider(CODEX_DRIVER, {
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      message: "Codex is disabled in Scient settings.",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: disabledFallback,
      }),
      disabledFallback,
    );
  });

  it("rejects cached snapshots that are not correlated to the fallback instance", () => {
    const fallbackCodex = makeProvider(CODEX_DRIVER, {
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
    });
    const legacyCachedCodex = {
      provider: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "cached-legacy-model",
          name: "Cached Legacy Model",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      slashCommands: [],
      skills: [],
    } as unknown as ServerProvider;
    const mismatchedCachedCodex = makeProvider(CODEX_DRIVER, {
      instanceId: ProviderInstanceId.make("codex_personal"),
    });

    assert.strictEqual(
      isCachedProviderCorrelated({
        cachedProvider: legacyCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      false,
    );
    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: legacyCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      fallbackCodex,
    );
    assert.strictEqual(
      isCachedProviderCorrelated({
        cachedProvider: mismatchedCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      false,
    );
    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: mismatchedCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      fallbackCodex,
    );
  });
});
