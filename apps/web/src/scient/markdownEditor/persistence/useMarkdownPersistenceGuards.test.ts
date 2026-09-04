import { EnvironmentId } from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./markdownPersistenceRegistry", () => ({ markdownPersistenceRegistry: {} }));
vi.mock("./useMarkdownPersistenceLease", () => ({
  useMarkdownPersistenceRegistrySnapshot: vi.fn(),
}));

import type { MarkdownPersistenceRegistryState } from "./markdownPersistenceRegistry";
import { createMarkdownPersistenceGuards } from "./useMarkdownPersistenceGuards";

const environmentId = EnvironmentId.make("one");
const otherEnvironmentId = EnvironmentId.make("two");
const workspace = { environmentId, cwd: "/workspace" };
const entry = (
  overrides: Partial<MarkdownPersistenceRegistryState> = {},
): MarkdownPersistenceRegistryState => ({
  ...workspace,
  relativePath: "notes.md",
  pending: true,
  attention: false,
  ...overrides,
});

function registry(initial: readonly MarkdownPersistenceRegistryState[]) {
  let files = initial;
  return {
    getSnapshot: () => files,
    flushTarget: vi.fn(async () => true),
    replace: (next: readonly MarkdownPersistenceRegistryState[]) => {
      files = next;
    },
  };
}

describe("Markdown persistence departure mapping", () => {
  it.each(["path", "surface"] as const)(
    "combines generic IDs with exact workspace-owned %s IDs",
    (kind) => {
      const files = [
        entry(),
        entry({ relativePath: "issue.md", attention: true }),
        entry({ relativePath: "clean.md", pending: false }),
        entry({ environmentId: otherEnvironmentId }),
        entry({ cwd: "/different" }),
      ];
      const prefix = kind === "surface" ? "file:" : "";
      const state = createMarkdownPersistenceGuards({
        files,
        registry: registry(files),
        scope: { kind, ...workspace },
        genericPendingIds: new Set(["generic.ts"]),
      });
      expect(state.pendingSurfaceIds).toEqual(
        new Set(["generic.ts", `${prefix}notes.md`, `${prefix}issue.md`]),
      );
      expect(state.quietSurfaceIds).toEqual(
        new Set([`${prefix}notes.md`, `${prefix}issue.md`, `${prefix}clean.md`]),
      );
      expect(state.attentionSurfaceIds).toEqual(new Set([`${prefix}issue.md`]));
    },
  );

  it("reads newer pending and attention truth before a React snapshot is committed", () => {
    const owner = registry([entry({ pending: false })]);
    const state = createMarkdownPersistenceGuards({
      files: owner.getSnapshot(),
      registry: owner,
      scope: { kind: "surface", ...workspace },
      genericPendingIds: new Set(["file:ordinary.ts"]),
    });
    expect(state.pendingSurfaceIds).toEqual(new Set(["file:ordinary.ts"]));
    owner.replace([entry({ attention: true })]);
    expect(state.departureOptions.getPendingSurfaceIds?.()).toEqual(
      new Set(["file:ordinary.ts", "file:notes.md"]),
    );
    expect(state.departureOptions.getAttentionSurfaceIds?.()).toEqual(new Set(["file:notes.md"]));
  });

  it("flushes only requested pending Markdown identities, not unrelated files", () => {
    const files = [
      entry(),
      entry({ relativePath: "other.md" }),
      entry({ relativePath: "clean.md", pending: false }),
      entry({ environmentId: otherEnvironmentId }),
    ];
    const owner = registry(files);
    const state = createMarkdownPersistenceGuards({
      files,
      registry: owner,
      scope: { kind: "surface", ...workspace },
      genericPendingIds: new Set(["file:code.ts"]),
    });
    state.departureOptions.onFlush?.([
      "file:notes.md",
      "file:notes.md",
      "file:clean.md",
      "file:code.ts",
    ]);
    expect(owner.flushTarget).toHaveBeenCalledExactlyOnceWith(files[0]);
  });

  it("retains cross-project and cross-environment bytes in global window/route guards", () => {
    const files = [
      entry(),
      entry({ cwd: "/different" }),
      entry({ environmentId: otherEnvironmentId }),
      entry({ relativePath: "clean.md", pending: false }),
    ];
    const owner = registry(files);
    const state = createMarkdownPersistenceGuards({
      files,
      registry: owner,
      scope: { kind: "global" },
      genericPendingIds: new Set(["legacy-workspace:file:code.ts"]),
    });
    expect(state.pendingSurfaceIds).toEqual(
      new Set([
        "legacy-workspace:file:code.ts",
        ...files.filter((file) => file.pending).map(projectFileOperationKey),
      ]),
    );
    state.departureOptions.onFlush?.([projectFileOperationKey(files[1]!)]);
    expect(owner.flushTarget).toHaveBeenCalledExactlyOnceWith(files[1]);
  });

  it("reveals a global issue only in the currently active owning workspace", () => {
    const files = [
      entry({ attention: true }),
      entry({ cwd: "/different", attention: true }),
      entry({ environmentId: otherEnvironmentId, attention: true }),
    ];
    const onAttention = vi.fn();
    const owner = registry(files);
    const state = createMarkdownPersistenceGuards({
      files,
      registry: owner,
      scope: { kind: "global" },
      genericPendingIds: new Set(),
      attentionWorkspace: workspace,
      onAttention,
    });
    for (const file of files) state.departureOptions.onAttention?.(projectFileOperationKey(file));
    expect(onAttention).toHaveBeenCalledExactlyOnceWith("file:notes.md");
    owner.replace([entry({ attention: false })]);
    state.departureOptions.onAttention?.(projectFileOperationKey(files[0]!));
    expect(onAttention).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unknown active workspace as an invitation to adopt another project's files", () => {
    const files = [entry()];
    const state = createMarkdownPersistenceGuards({
      files,
      registry: registry(files),
      scope: { kind: "surface", environmentId: undefined, cwd: undefined },
      genericPendingIds: new Set(["file:generic.ts"]),
    });
    expect(state.pendingSurfaceIds).toEqual(new Set(["file:generic.ts"]));
    expect(state.quietSurfaceIds.size).toBe(0);
  });
});
