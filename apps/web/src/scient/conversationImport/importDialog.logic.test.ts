import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScientConversationImportError,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ConversationImportNotice,
  defaultImportModelKey,
  desktopUploadOutcome,
  importEnvironmentOptions,
  importFailureMessage,
  importFileProblem,
  importModelGroups,
  importRuntimeModeNote,
  modelDisplayName,
  providerDisplayName,
} from "./importDialog.logic";

function testProvider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; name: string; isDefault?: boolean }>,
  status: ServerProvider["status"] = "ready",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-09-28T00:00:00.000Z",
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}

function testConfig(
  providers: ReadonlyArray<ServerProvider>,
  settings: Partial<ServerConfig["settings"]> = {},
): ServerConfig {
  return {
    providers,
    settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
  } as unknown as ServerConfig;
}

const codex = testProvider("codex", "codex", [
  { slug: "gpt-5", name: "GPT-5", isDefault: true },
  { slug: "gpt-5-mini", name: "GPT-5 mini" },
]);
const claude = testProvider("claudeAgent", "claudeAgent", [
  { slug: "claude-opus", name: "Claude Opus", isDefault: true },
]);
const project = { id: ProjectId.make("project-1") };

describe("importEnvironmentOptions", () => {
  it("names this device and remote environments, never by ID, this device first", () => {
    const local = EnvironmentId.make("4b1b7c1e-8d1f-4a5e-9b0e-0c9f5f1d2a3b");
    const remote = EnvironmentId.make("9f0e1d2c-3b4a-4596-8778-695a4b3c2d1e");
    expect(
      importEnvironmentOptions({
        environmentIds: [remote, local],
        labels: new Map([
          [local, "Local"],
          [remote, "Lab workstation"],
        ]),
        primaryEnvironmentId: local,
      }),
    ).toEqual([
      { environmentId: local, label: "This device" },
      { environmentId: remote, label: "Lab workstation" },
    ]);
  });
});

describe("destination model", () => {
  const config = testConfig([codex, claude], {
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus",
    },
  });
  const groups = importModelGroups(config);

  it("lists ready providers with their models by name", () => {
    expect(groups.map((group) => [group.label, group.models.map((model) => model.name)])).toEqual([
      ["Codex", ["GPT-5", "GPT-5 mini"]],
      ["Claude", ["Claude Opus"]],
    ]);
    expect(
      importModelGroups(
        testConfig([codex, testProvider("cursor", "cursor", [{ slug: "a", name: "A" }], "error")]),
      ),
    ).toHaveLength(1);
  });

  it("defaults to the project's model, then the user's, never the first in the list", () => {
    expect(
      defaultImportModelKey(
        config,
        {
          ...project,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-mini",
          },
        },
        groups,
      ),
    ).toBe("codex/gpt-5-mini");
    expect(defaultImportModelKey(config, project, groups)).toBe("claudeAgent/claude-opus");
    expect(defaultImportModelKey(config, null, groups)).toBeNull();
  });

  it("says imports start supervised only when new threads here would not", () => {
    expect(
      importRuntimeModeNote(
        testConfig([codex], { defaultRuntimeMode: "approval-required" }),
        project,
      ),
    ).toBeNull();
    expect(
      importRuntimeModeNote(testConfig([codex], { defaultRuntimeMode: "full-access" }), project),
    ).toBe(
      "Imported conversations start in Supervised mode, which asks before commands and file changes.",
    );
  });

  it("names the source provider and model for people", () => {
    expect(providerDisplayName("claudeAgent")).toBe("Claude");
    expect(providerDisplayName("codex")).toBe("Codex");
    expect(providerDisplayName("some_new-driver")).toBe("Some New Driver");
    expect(modelDisplayName(config, "codex", "gpt-5")).toBe("GPT-5");
    expect(modelDisplayName(config, "codex", "gpt-4")).toBe("gpt-4");
  });
});

describe("importFileProblem", () => {
  it("refuses other formats, empty files, and files over the limit", () => {
    expect(importFileProblem("notes.scic", 10)).toBeNull();
    expect(importFileProblem("Notes.MD", 10)).toBeNull();
    expect(importFileProblem("notes.txt", 10)).toContain("(.scic)");
    expect(importFileProblem("notes.scic", 0)).toBe("This file is empty.");
    expect(importFileProblem("notes.md", 17 * 1024 * 1024)).toBe(
      "This file is larger than Scient can import.",
    );
  });
});

describe("importFailureMessage", () => {
  const rejected = (message: string, entry: string | null = null) =>
    new ScientConversationImportError({
      reason: "package-rejected",
      rejection: { reason: "unsafe-path", entry },
      message,
    });

  it("shows the server's plain message for a rejected file", () => {
    expect(importFailureMessage(rejected("This file is damaged."), "fallback")).toBe(
      "This file is damaged.",
    );
  });

  it("never shows reason codes or entry paths", () => {
    const expected = "This file can't be imported. It didn't pass Scient's checks.";
    expect(importFailureMessage(rejected("Rejected: unsafe-path"), "fallback")).toBe(expected);
    expect(
      importFailureMessage(
        rejected("Entry attachments/../../etc is unsafe.", "attachments/../../etc"),
        "fallback",
      ),
    ).toBe(expected);
    expect(importFailureMessage(rejected("Bad entry at C:\\temp\\x"), "fallback")).toBe(expected);
  });

  it("keeps connection and internal errors out of the dialog", () => {
    expect(
      importFailureMessage(
        new Error(
          "Failed to fetch remote environment endpoint http://127.0.0.1:1234/api (TypeError)",
        ),
        "This file couldn't be checked. Try again.",
      ),
    ).toBe("This file couldn't be checked. Try again.");
    expect(importFailureMessage(new ConversationImportNotice("Plain words."), "fallback")).toBe(
      "Plain words.",
    );
  });
});

describe("desktopUploadOutcome", () => {
  it("treats a declined prompt or a cancel as stopping, and words other failures plainly", () => {
    expect(desktopUploadOutcome({ _tag: "uploaded" })).toEqual({ _tag: "uploaded" });
    for (const reason of ["declined", "cancelled"] as const) {
      expect(desktopUploadOutcome({ _tag: "failed", reason })).toEqual({ _tag: "stopped" });
    }
    for (const reason of [
      "rejected",
      "file-unavailable",
      "file-changed",
      "invalid-url",
      "network-failed",
    ] as const) {
      const outcome = desktopUploadOutcome({ _tag: "failed", reason });
      expect(outcome).toBeInstanceOf(ConversationImportNotice);
      expect((outcome as ConversationImportNotice).message).not.toContain(reason);
    }
    expect(desktopUploadOutcome(undefined)).toBeInstanceOf(ConversationImportNotice);
  });
});
