import type { SDKModel } from "@cursor/sdk";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import type { CursorSettings } from "../settings.ts";
import { CursorSettings as CursorSettingsSchema } from "../settings.ts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildCursorCapabilitiesFromSdkModel,
  buildCursorDiscoveredModelsFromSdk,
  buildCursorProviderSnapshot,
  checkCursorProviderStatus,
} from "./status.ts";
import { makeCursorCommandCatalog } from "./commandCatalog.ts";
import {
  getCursorParameterizedModelPickerUnsupportedMessage,
  parseCursorAboutOutput,
  parseCursorCliConfigChannel,
  parseCursorVersionDate,
} from "./about.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";
import { hasCursorSkillMention, probeCursorSkills, rewriteCursorSkillMentions } from "./skills.ts";

const provideNodeServices = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
) => effect.pipe(Effect.provide(NodeServices.layer));

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string, currentValue?: boolean) {
  return {
    id,
    label,
    type: "boolean" as const,
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}
const baseCursorSettings: CursorSettings = {
  enabled: true,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
};
const cursorAcpDiscoveryFailedMessage = [
  "Cursor ACP model discovery failed.",
  "Cursor CLI setup may be incomplete; install or enable the Cursor CLI, restart Scient, and try again.",
  "See https://cursor.com/docs/cli/installation.",
  "Check server logs for ACP details.",
].join(" ");

const sdkParameterizedModel = {
  id: "claude-opus-4-8",
  displayName: "Opus 4.8",
  parameters: [
    {
      id: "thinking",
      displayName: "Thinking",
      values: [{ value: "false" }, { value: "true" }],
    },
    {
      id: "context",
      displayName: "Context",
      values: [
        { value: "300k", displayName: "300K" },
        { value: "1m", displayName: "1M" },
      ],
    },
    {
      id: "effort",
      displayName: "Effort",
      values: [
        { value: "low", displayName: "Low" },
        { value: "high", displayName: "High" },
      ],
    },
    {
      id: "fast",
      displayName: "Fast",
      values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
    },
  ],
  variants: [
    {
      displayName: "Opus 4.8",
      isDefault: true,
      params: [
        { id: "thinking", value: "true" },
        { id: "context", value: "1m" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
  ],
} satisfies SDKModel;

describe("Cursor skills", () => {
  effectIt.effect("discovers recursive project skills with project precedence", () =>
    provideNodeServices(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-home-",
        });
        const workspace = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-workspace-",
        });
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          root: string,
          name: string,
          contents: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
        });

        yield* writeSkill(
          path.join(userHome, ".cursor", "skills"),
          "review",
          "---\ndescription: user review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills", "nested"),
          "review",
          "---\nname: Review changes\ndescription: project review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "internal",
          "---\nuser-invocable: false\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "oversized",
          "x".repeat(1_000_001),
        );
        const canonicalWorkspace = yield* fileSystem.realPath(workspace);
        const skills = yield* probeCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "internal",
            path: path.join(canonicalWorkspace, ".cursor", "skills", "internal", "SKILL.md"),
            scope: "project",
            enabled: true,
            userInvocable: false,
          },
          {
            name: "review",
            displayName: "Review changes",
            description: "project review",
            path: path.join(
              canonicalWorkspace,
              ".agents",
              "skills",
              "nested",
              "review",
              "SKILL.md",
            ),
            scope: "project",
            enabled: true,
          },
        ]);
        yield* fileSystem.makeDirectory(path.join(userHome, ".codex"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(userHome, ".codex", "skills"),
          "not a directory",
        );
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
  );

  effectIt.effect("treats a symlinked skill outside the root as a package boundary", () =>
    provideNodeServices(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-home-",
        });
        const workspace = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-workspace-",
        });
        const library = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-library-",
        });
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          directory: string,
          contents: string,
        ) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), contents);
        });

        // A skill package managed in a config repo and installed by symlink.
        // Its own SKILL.md must be discovered under the link name, but nothing
        // below the target may be walked.
        yield* writeSkill(path.join(library, "shared-review"), "---\ndescription: shared\n---\n");
        yield* writeSkill(path.join(library, "shared-review", "hidden"), "---\n---\n");
        const root = path.join(workspace, ".cursor", "skills");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* fileSystem.symlink(path.join(library, "shared-review"), path.join(root, "review"));

        const skills = yield* probeCursorSkills(workspace, { HOME: userHome });
        const canonicalRoot = yield* fileSystem.realPath(root);
        expect(skills).toEqual([
          {
            name: "review",
            description: "shared",
            path: path.join(canonicalRoot, "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Success");
      }),
    ),
  );

  it("rewrites only discovered skill mentions into Cursor slash invocations", () => {
    expect(hasCursorSkillMention("use $Review_Pr:V2 here")).toBe(true);
    expect(hasCursorSkillMention("please $review this")).toBe(true);
    expect(
      rewriteCursorSkillMentions("use $review, keep $HOME and 5$review", new Set(["review"])),
    ).toBe("use $review, keep $HOME and 5$review");
    expect(rewriteCursorSkillMentions("please $review this", new Set(["review"]))).toBe(
      "please /review this",
    );
  });

  it("rewrites currency-prefixed skill mentions into Cursor slash invocations", () => {
    const names = new Set(["review", "2spec", "20k", "100M", "1e6"]);
    for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(hasCursorSkillMention(`please ${symbol}review this`)).toBe(true);
      expect(hasCursorSkillMention(`please ${symbol}review this`)).toBe(true);
      expect(rewriteCursorSkillMentions(`${symbol}review then ${symbol}2spec this`, names)).toBe(
        "/review then /2spec this",
      );
      const money = `${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6`;
      expect(hasCursorSkillMention(money)).toBe(false);
      expect(rewriteCursorSkillMentions(money, names)).toBe(money);
      const prose = `5${symbol}review ${symbol}unknown`;
      expect(rewriteCursorSkillMentions(prose, names)).toBe(prose);
    }
  });

  it("detects and invokes digit-leading Cursor skills without rewriting money", () => {
    const names = new Set(["2spec", "20k", "100M", "1e6"]);
    // Repeated presence checks must not carry a global-regex cursor.
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(rewriteCursorSkillMentions("use $2spec here", names)).toBe("use /2spec here");
    expect(rewriteCursorSkillMentions("use $2spec here", new Set())).toBe("use $2spec here");
    for (const text of [
      "pay $20 tomorrow",
      "budget $20k here",
      "cost $100M total",
      "limit $1e6 here",
    ]) {
      expect(hasCursorSkillMention(text)).toBe(false);
      expect(rewriteCursorSkillMentions(text, names)).toBe(text);
    }
  });
});

describe("Cursor command catalog", () => {
  effectIt.effect(
    "publishes workspace commands without leaking them globally and retains them across refreshes",
    () =>
      Effect.gen(function* () {
        const base = {
          ...buildCursorProviderSnapshot({
            checkedAt: "2026-01-01T00:00:00.000Z",
            cursorSettings: baseCursorSettings,
            parsed: { version: null, status: "ready", auth: { status: "authenticated" } },
          }),
          instanceId: ProviderInstanceId.make("cursor-catalog"),
          driver: ProviderDriverKind.make("cursor"),
        };
        const catalog = yield* makeCursorCommandCatalog({
          getSnapshot: Effect.succeed(base),
          refresh: Effect.succeed(base),
          streamChanges: Stream.empty,
          resolveMaintenance: () => Effect.die("Not used"),
          applyUsageLimits: () => Effect.void,
        });
        const skills = [
          { name: "review", path: "/one/.cursor/skills/review/SKILL.md", enabled: true },
        ];
        const probedSkills = [
          { name: "explain", path: "/probed/.cursor/skills/explain/SKILL.md", enabled: true },
        ];
        yield* catalog.snapshotForCwd("/probed", probedSkills);
        yield* catalog.onAvailableCommands(
          [
            {
              name: "review",
              description: "Review changes",
              input: { type: "text", hint: "target" },
            },
            { name: "compact", description: "Native duplicate" },
            { name: "review", description: "Duplicate" },
          ],
          "/one",
          skills,
        );
        yield* catalog.onAvailableCommands([{ name: "deploy", description: "Deploy" }], "/two", []);
        const reprobed = yield* catalog.snapshotForCwd("/one", skills);
        expect(reprobed.slashCommands.map((command) => command.name)).toEqual([
          "compact",
          "review",
        ]);
        const published = yield* catalog.snapshot.streamChanges.pipe(
          Stream.take(1),
          Stream.runCollect,
        );
        expect(published[0]?.slashCommands.map((command) => command.name)).toEqual(["compact"]);
        const refreshed = yield* catalog.snapshot.refresh;
        expect(
          refreshed.workspaceSnapshots?.find((entry) => entry.cwd === "/probed"),
        ).toMatchObject({
          slashCommands: [{ name: "compact" }],
          skills: probedSkills,
        });
        expect(refreshed.workspaceSnapshots?.find((entry) => entry.cwd === "/one")).toMatchObject({
          slashCommands: [
            { name: "compact" },
            { name: "review", description: "Review changes", input: { hint: "target" } },
          ],
          skills,
        });
        yield* catalog.onAvailableCommands([], "/one", skills);
        const updated = yield* catalog.snapshot.getSnapshot;
        expect(
          updated.workspaceSnapshots?.find((entry) => entry.cwd === "/probed")?.skills,
        ).toEqual(probedSkills);
        expect(
          updated.workspaceSnapshots
            ?.find((entry) => entry.cwd === "/one")
            ?.slashCommands.map((command) => command.name),
        ).toEqual(["compact"]);
        expect(
          updated.workspaceSnapshots
            ?.find((entry) => entry.cwd === "/two")
            ?.slashCommands.map((command) => command.name),
        ).toEqual(["compact", "deploy"]);
        yield* catalog.onAvailableCommands([{ name: "publish", description: "Publish" }], "/one");
        const afterIncompleteSkillScan = yield* catalog.snapshot.getSnapshot;
        expect(
          afterIncompleteSkillScan.workspaceSnapshots?.find((entry) => entry.cwd === "/one"),
        ).toMatchObject({
          skills,
          slashCommands: [{ name: "compact" }, { name: "publish", description: "Publish" }],
        });
        yield* catalog.onAvailableCommands(
          [{ name: "unscanned", description: "Unscanned" }],
          "/unscanned",
        );
        expect(
          (yield* catalog.snapshot.getSnapshot).workspaceSnapshots?.some(
            (entry) => entry.cwd === "/unscanned",
          ),
        ).toBe(false);
      }),
  );
});

describe("buildCursorProviderSnapshot", () => {
  it("downgrades ready status to warning when ACP model discovery times out", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: baseCursorSettings,
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "ready",
          auth: { status: "authenticated", type: "Team", label: "Cursor Team Subscription" },
        },
        discoveryWarning: "Cursor ACP model discovery timed out after 15000ms.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Cursor ACP model discovery timed out after 15000ms.",
      models: [],
      supportsConversationRollback: false,
    });
  });

  it("preserves provider error state while appending discovery warnings", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: {
          ...baseCursorSettings,
          customModels: ["claude-sonnet-4-6"],
        },
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
        },
        discoveryWarning: cursorAcpDiscoveryFailedMessage,
      }),
    ).toMatchObject({
      status: "error",
      message: `Cursor Agent is not authenticated. Run \`agent login\` and try again. ${cursorAcpDiscoveryFailedMessage}`,
      models: [
        {
          slug: "claude-sonnet-4-6",
          isCustom: true,
        },
      ],
    });
  });

  it("downgrades ready status to warning when SDK model discovery returns no models", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: baseCursorSettings,
        parsed: {
          version: null,
          status: "ready",
          auth: { status: "authenticated", type: "api-key", label: "Cursor API key" },
        },
        discoveryWarning: "Cursor SDK model discovery returned no built-in models.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Cursor SDK model discovery returned no built-in models.",
      models: [],
      supportsConversationRollback: false,
    });
  });
});

describe("Cursor SDK model discovery", () => {
  it("maps native SDK parameter ids and default variant values to model capabilities", () => {
    expect(buildCursorCapabilitiesFromSdkModel(sdkParameterizedModel)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("effort", "Effort", [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ]),
          selectDescriptor("contextWindow", "Context", [
            { id: "300k", label: "300K" },
            { id: "1m", label: "1M", isDefault: true },
          ]),
          booleanDescriptor("fastMode", "Fast", false),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });

  it("filters invalid and duplicate SDK model entries", () => {
    expect(
      buildCursorDiscoveredModelsFromSdk([
        sdkParameterizedModel,
        { ...sdkParameterizedModel, displayName: "Duplicate" },
        { id: "", displayName: "Invalid" },
      ]),
    ).toEqual([
      {
        slug: "claude-opus-4-8",
        name: "Opus 4.8",
        isCustom: false,
        capabilities: buildCursorCapabilitiesFromSdkModel(sdkParameterizedModel),
      },
    ]);
  });
});

describe("checkCursorProviderStatus", () => {
  effectIt.effect("uses the SDK catalog when CURSOR_API_KEY is configured", () =>
    Effect.gen(function* () {
      const provider = yield* checkCursorProviderStatus(
        {
          ...baseCursorSettings,
          customModels: ["internal/cursor-model"],
        },
        { CURSOR_API_KEY: "test-cursor-key" },
      ).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest((apiKey) => {
            expect(apiKey).toBe("test-cursor-key");
            return Effect.succeed({
              user: {
                apiKeyName: "test-key",
                userEmail: "cursor@example.com",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              models: [sdkParameterizedModel],
            });
          }),
        ),
      );

      expect(provider).toMatchObject({
        status: "ready",
        auth: {
          status: "authenticated",
          type: "api-key",
          label: "Cursor API key (test-key)",
          email: "cursor@example.com",
        },
        models: [
          { slug: "claude-opus-4-8", isCustom: false },
          { slug: "internal/cursor-model", isCustom: true },
        ],
      });
    }),
  );

  effectIt.effect("surfaces SDK authentication failures", () =>
    Effect.gen(function* () {
      const provider = yield* checkCursorProviderStatus(baseCursorSettings, {
        CURSOR_API_KEY: "invalid-test-key",
      }).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest(() =>
            Effect.fail(
              new CursorSdkCatalog.CursorSdkCatalogError({
                authenticationFailure: true,
                cause: new Error("unauthorized"),
              }),
            ),
          ),
        ),
      );

      expect(provider).toMatchObject({
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor SDK authentication failed. Check CURSOR_API_KEY.",
      });
    }),
  );

  effectIt.effect("requires a Cursor API key without probing any external Cursor binary", () =>
    Effect.gen(function* () {
      const provider = yield* checkCursorProviderStatus(baseCursorSettings).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest(() =>
            Effect.die("SDK catalog must not be used without CURSOR_API_KEY"),
          ),
        ),
      );

      expect(provider).toMatchObject({
        installed: true,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
      });
    }),
  );
});

describe("parseCursorAboutOutput", () => {
  it("parses json about output and forwards subscription metadata", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "jmarminge@gmail.com",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "ready",
      auth: {
        status: "authenticated",
        email: "jmarminge@gmail.com",
        type: "Team",
        label: "Cursor Team Subscription",
      },
    });
  });

  it("treats json about output with a logged-out email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "Not logged in",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });

  it("treats json about output with a null email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: null,
          userEmail: null,
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });
});

describe("Cursor parameterized model picker preview gating", () => {
  it("parses Cursor CLI version dates from build versions", () => {
    expect(parseCursorVersionDate("2026.04.08-c4e73a3")).toBe(20260408);
    expect(parseCursorVersionDate("2026.04.09")).toBe(20260409);
    expect(parseCursorVersionDate("not-a-version")).toBeUndefined();
  });

  it("parses the Cursor CLI channel from cli-config.json", () => {
    expect(parseCursorCliConfigChannel('{ "channel": "lab" }')).toBe("lab");
    expect(parseCursorCliConfigChannel('{ "channel": "stable" }')).toBe("stable");
    expect(parseCursorCliConfigChannel('{ "version": 1 }')).toBeUndefined();
    expect(parseCursorCliConfigChannel("not-json")).toBeUndefined();
  });

  it("returns no warning when the preview requirements are met", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "lab",
      }),
    ).toBeUndefined();
  });

  it("explains when the Cursor Agent version is too old", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.07-c4e73a3",
        channel: "lab",
      }),
    ).toContain("too old");
  });

  it("explains when the Cursor Agent channel is not lab", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "stable",
      }),
    ).toContain("lab channel");
  });
});
