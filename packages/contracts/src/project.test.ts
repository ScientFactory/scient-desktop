import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";

import {
  ProjectFaviconPath,
  ReceivedProjectIcon,
  StoredProjectIcon,
  ProjectReadFileError,
  ProjectCreatePayload,
  ProjectFileWatchEvent,
  ProjectIconOverride,
  ProjectListDirectoryError,
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectMutation,
  ProjectReadFileInput,
  ProjectRenameFileInput,
  ProjectUpdatePayload,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectWriteFileError,
} from "./project.ts";

const decodeProjectCreatePayload = Schema.decodeUnknownSync(ProjectCreatePayload);
const decodeProjectUpdatePayload = Schema.decodeUnknownSync(ProjectUpdatePayload);
const decodeProjectMutation = Schema.decodeUnknownSync(ProjectMutation);
const encodeProjectMutation = Schema.encodeSync(ProjectMutation);
const decodeSearchEntriesInput = Schema.decodeUnknownSync(ProjectSearchEntriesInput);
const decodeSearchContentsInput = Schema.decodeUnknownSync(ProjectSearchContentsInput);
const decodeFileWatchEvent = Schema.decodeUnknownSync(ProjectFileWatchEvent);
const decodeListDirectoryInput = Schema.decodeUnknownSync(ProjectListDirectoryInput);
const decodeListDirectoryResult = Schema.decodeUnknownSync(ProjectListDirectoryResult);

describe("project file watch events", () => {
  it("carries only a readiness or change hint and never file contents", () => {
    expect(decodeFileWatchEvent({ _tag: "watch-ready", relativePath: "analysis.m" })).toEqual({
      _tag: "watch-ready",
      relativePath: "analysis.m",
    });
    expect(decodeFileWatchEvent({ _tag: "file-changed", relativePath: "analysis.m" })).toEqual({
      _tag: "file-changed",
      relativePath: "analysis.m",
    });
    expect(
      decodeFileWatchEvent({
        _tag: "file-changed",
        relativePath: "analysis.m",
        contents: "must not cross the watcher stream",
      }),
    ).toEqual({ _tag: "file-changed", relativePath: "analysis.m" });
  });
});

describe("project search inputs", () => {
  it("allows an empty entries query for bounded frecency browsing", () => {
    const decoded = decodeSearchEntriesInput({
      cwd: "/workspace",
      query: "   ",
      limit: 10,
      kind: "file",
    });
    expect(decoded.query).toBe("");
  });

  it("preserves whitespace in content search queries", () => {
    const decoded = decodeSearchContentsInput({
      cwd: "/workspace",
      query: " foo ",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(decoded.query).toBe(" foo ");
  });
});

describe("project directory contracts", () => {
  it("supports the workspace root without making partial listings look complete", () => {
    expect(
      decodeListDirectoryInput({
        cwd: "/workspace",
        relativeDirectory: "",
        view: "ordinary",
      }),
    ).toEqual({ cwd: "/workspace", relativeDirectory: "", view: "ordinary" });

    expect(
      decodeListDirectoryInput({
        cwd: "/workspace",
        relativeDirectory: ".scient/sources",
        view: "with-internals",
      }),
    ).toEqual({
      cwd: "/workspace",
      relativeDirectory: ".scient/sources",
      view: "with-internals",
    });

    expect(
      decodeListDirectoryResult({
        entries: [
          {
            name: ".scient",
            relativePath: ".scient",
            kind: "directory",
            readOnly: true,
          },
        ],
        complete: true,
      }),
    ).toEqual({
      entries: [{ name: ".scient", relativePath: ".scient", kind: "directory", readOnly: true }],
      complete: true,
    });
  });
});

describe("project RPC errors", () => {
  it("derives stable messages from structured request context while retaining causes", () => {
    const cause = new Error("sensitive platform detail");
    const searchError = new ProjectSearchEntriesError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 20,
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      detail: "index unavailable",
      cause,
    });
    const readError = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "src/index.ts",
      failure: "operation_failed",
      operation: "read",
      operationPath: "/workspace/src/index.ts",
      resolvedPath: "/workspace/src/index.ts",
      cause,
    });
    const directoryError = new ProjectListDirectoryError({
      cwd: "/workspace",
      relativeDirectory: ".git",
      view: "ordinary",
      failure: "path_not_visible",
    });

    expect(searchError.message).toBe("Failed to search workspace entries in '/workspace'.");
    expect(searchError.message).not.toContain(cause.message);
    expect(searchError.normalizedCwd).toBe("/workspace");
    expect(searchError.queryLength).toBe("authorization: Bearer secret-token".length);
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.message).not.toMatch(/Bearer|secret-token/);
    expect(searchError.cause).toBe(cause);
    expect(readError.message).toBe("Failed to read workspace file 'src/index.ts' in '/workspace'.");
    expect(readError.message).not.toContain(cause.message);
    expect(readError.cause).toBe(cause);
    expect(directoryError.message).toBe(
      "Failed to list workspace directory '.git' in '/workspace'.",
    );

    const contentSearchError = new ProjectSearchContentsError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 100,
      failure: "search_index_search_failed",
      cause,
    });
    expect(contentSearchError.message).toBe("Failed to search workspace contents in '/workspace'.");
    expect(contentSearchError.message).not.toContain(cause.message);
    expect(contentSearchError).not.toHaveProperty("query");
    expect(contentSearchError.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeSearchError = Schema.decodeUnknownSync(ProjectSearchEntriesError);
    const decodeWriteError = Schema.decodeUnknownSync(ProjectWriteFileError);

    const searchError = decodeSearchError({
      _tag: "ProjectSearchEntriesError",
      message: "Legacy project search failure.",
      query: "legacy sensitive query",
    });
    const writeError = decodeWriteError({
      _tag: "ProjectWriteFileError",
      message: "Legacy project write failure.",
    });

    expect(searchError.message).toBe("Legacy project search failure.");
    expect(searchError.cwd).toBeUndefined();
    expect(searchError.queryLength).toBeUndefined();
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.failure).toBeUndefined();
    expect(writeError.message).toBe("Legacy project write failure.");
    expect(writeError.relativePath).toBeUndefined();
    expect(writeError.failure).toBeUndefined();
  });
});

describe("project file paths", () => {
  const decodeReadFileInput = Schema.decodeUnknownSync(ProjectReadFileInput);
  const encodeReadFileInput = Schema.encodeSync(ProjectReadFileInput);
  const decodeRenameFileInput = Schema.decodeUnknownSync(ProjectRenameFileInput);

  it("keeps whitespace that is part of a file name, in both directions", () => {
    const input = { cwd: "/workspace", relativePath: " drafts/notes.md " };
    expect(decodeReadFileInput(input).relativePath).toBe(" drafts/notes.md ");
    expect(encodeReadFileInput(input).relativePath).toBe(" drafts/notes.md ");
    expect(
      decodeFileWatchEvent({ _tag: "file-changed", relativePath: "notes.md " }).relativePath,
    ).toBe("notes.md ");
    const rename = decodeRenameFileInput({
      cwd: "/workspace",
      relativePath: "notes.md ",
      destinationRelativePath: "notes.md",
      expectedRevision: "sha256:abc",
    });
    expect([rename.relativePath, rename.destinationRelativePath]).toEqual([
      "notes.md ",
      "notes.md",
    ]);
  });

  it("rejects a blank path instead of trimming it into something else", () => {
    expect(() => decodeReadFileInput({ cwd: "/workspace", relativePath: "" })).toThrow();
    expect(() => decodeReadFileInput({ cwd: "/workspace", relativePath: "   " })).toThrow();
  });

  it("keeps the empty string as the root directory and rejects a blank one", () => {
    expect(
      decodeListDirectoryInput({ cwd: "/workspace", relativeDirectory: "", view: "ordinary" })
        .relativeDirectory,
    ).toBe("");
    expect(
      decodeListDirectoryInput({ cwd: "/workspace", relativeDirectory: "notes ", view: "ordinary" })
        .relativeDirectory,
    ).toBe("notes ");
    expect(() =>
      decodeListDirectoryInput({ cwd: "/workspace", relativeDirectory: "  ", view: "ordinary" }),
    ).toThrow();
  });
});
describe("shared project payloads", () => {
  it.each(["monogramText", "monogram"] as const)(
    "normalizes an older client's %s project.update write without losing its monogram",
    (field) => {
      const envelope = {
        type: "project.update",
        commandId: "command",
        projectId: "project",
      } as const;
      const icon = { kind: "monogram", text: "क्ष्म", color: "violet" } as const;
      const incoming = {
        ...envelope,
        projectIcon: { kind: "lucide", name: "folder-code", color: "violet", [field]: icon.text },
      };
      const decoded = decodeProjectMutation(incoming);
      expect(decoded).toEqual({ ...envelope, projectIcon: icon });
      expect(encodeProjectMutation(decoded)).toEqual({ ...envelope, projectIcon: icon });
      expect(decodeProjectUpdatePayload({ projectIcon: incoming.projectIcon })).toEqual({
        projectIcon: icon,
      });
    },
  );

  it.each([
    { kind: "lucide", name: "folder-code", color: "violet", monogramText: "" },
    { kind: "lucide", name: "folder-code", color: "violet", monogram: "🚀" },
    { kind: "lucide", name: "folder-code", color: "ultraviolet", monogramText: "T3" },
    { kind: "monogram", text: "A B", color: "violet" },
    { kind: "emoji" },
    { kind: "image", url: "https://synthetic.example/icon.png" },
  ])("refuses a malformed or unknown project.update icon %#", (projectIcon) => {
    const update = { projectIcon };
    expect(() => decodeProjectUpdatePayload(update)).toThrow();
    expect(() =>
      decodeProjectMutation({
        type: "project.update",
        commandId: "command",
        projectId: "project",
        ...update,
      }),
    ).toThrow();
  });

  it.each([
    { kind: "lucide", name: "alarm-clock", color: "blue" },
    { kind: "emoji", emoji: "👩🏽‍💻" },
    { kind: "monogram", text: "T3", color: "violet" },
    null,
  ] as const)("preserves a canonical or cleared project.update icon %#", (projectIcon) => {
    const incoming = {
      type: "project.update",
      commandId: "command",
      projectId: "project",
      projectIcon,
    };
    const decoded = decodeProjectMutation(incoming);
    expect(decoded).toEqual(incoming);
    expect(encodeProjectMutation(decoded)).toEqual(incoming);
  });

  it("preserves omitted, false, and null values through RPC envelopes", () => {
    const create = decodeProjectCreatePayload({
      title: " Example ",
      workspaceRoot: "/workspace",
      createWorkspaceRootIfMissing: false,
    });
    const update = decodeProjectUpdatePayload({
      autoPull: false,
      defaultModelSelection: null,
      faviconPath: null,
    });
    const envelope = { commandId: "command", projectId: "project" };
    expect(decodeProjectMutation({ type: "project.create", ...envelope, ...create })).toEqual({
      type: "project.create",
      ...envelope,
      title: "Example",
      workspaceRoot: "/workspace",
      createWorkspaceRootIfMissing: false,
    });
    expect(decodeProjectMutation({ type: "project.update", ...envelope, ...update })).toEqual({
      type: "project.update",
      ...envelope,
      autoPull: false,
      defaultModelSelection: null,
      faviconPath: null,
    });
    expect(Object.hasOwn(create, "scripts")).toBe(false);
    expect(Object.hasOwn(update, "title")).toBe(false);
    // Internal RPC callers may explicitly supply undefined, as before the extraction.
    expect(
      decodeProjectMutation({ type: "project.update", ...envelope, title: undefined }),
    ).toHaveProperty("title", undefined);
  });
});

const decodeFaviconPath = Schema.decodeUnknownEffect(ProjectFaviconPath);

effectIt.effect("project favicon paths accept only supported image files", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* decodeFaviconPath("brand/icon.svg"), "brand/icon.svg");
    assert.strictEqual((yield* Effect.exit(decodeFaviconPath(".env")))._tag, "Failure");
  }),
);

const decodeProjectUpdateEffect = Schema.decodeUnknownEffect(ProjectUpdatePayload);
const decodeUpdateIcon = (projectIcon: unknown) =>
  Effect.map(decodeProjectUpdateEffect({ projectIcon }), (update) => update.projectIcon);

effectIt.effect("project icon overrides accept Lucide icons, colors, and emoji", () =>
  Effect.gen(function* () {
    const lucide = { kind: "lucide", name: "alarm-clock", color: "violet" } as const;
    assert.deepEqual(yield* decodeUpdateIcon(lucide), lucide);
    const emoji = { kind: "emoji", emoji: "👩🏽‍💻" } as const;
    assert.deepEqual(yield* decodeUpdateIcon(emoji), emoji);
    const invalid = yield* Effect.exit(
      decodeUpdateIcon({ kind: "lucide", name: "Alarm Clock", color: "ultraviolet" }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

effectIt.effect("project monograms validate text and palette colors", () =>
  Effect.gen(function* () {
    for (const text of ["A", "T3", "É", "文書", "कि", "किखि", "e\u0301"]) {
      assert.deepEqual(yield* decodeUpdateIcon({ kind: "monogram", color: "violet", text }), {
        kind: "monogram",
        text,
        color: "violet",
      });
    }
    for (const projectIcon of [
      { kind: "monogram", text: "", color: "blue" },
      { kind: "monogram", text: "\u0301", color: "blue" },
      { kind: "monogram", text: "A B", color: "blue" },
      { kind: "monogram", text: "🚀", color: "blue" },
      { kind: "monogram", text: "T3", color: "ultraviolet" },
    ]) {
      assert.strictEqual((yield* Effect.exit(decodeUpdateIcon(projectIcon)))._tag, "Failure");
    }
  }),
);

const decodeStoredIcon = Schema.decodeUnknownEffect(StoredProjectIcon);
const encodeStoredIcon = Schema.encodeEffect(StoredProjectIcon);
const decodeReceivedIcon = Schema.decodeUnknownEffect(ReceivedProjectIcon);
const encodeReceivedIcon = Schema.encodeEffect(ReceivedProjectIcon);
const decodeProjectShell = Schema.decodeUnknownEffect(OrchestrationProjectShell);

effectIt.effect("sends and stores icons in their plain shape", () =>
  Effect.gen(function* () {
    for (const icon of [
      { kind: "monogram", text: "क्ष्म", color: "violet" },
      { kind: "lucide", name: "alarm-clock", color: "blue" },
      { kind: "emoji", emoji: "🚀" },
    ] as const) {
      assert.deepEqual(yield* encodeReceivedIcon(icon), icon);
      assert.deepEqual(yield* encodeStoredIcon(icon), icon);
      assert.deepEqual(yield* decodeReceivedIcon(icon), icon);
    }
  }),
);

effectIt.effect("reads monograms stored in the pre-v2 fallback shape", () =>
  Effect.gen(function* () {
    const monogram = { kind: "monogram", text: "T3", color: "violet" } as const;
    const fallback = { kind: "lucide", name: "folder-code", color: "violet" } as const;
    for (const legacy of [
      { ...fallback, monogramText: "T3" },
      { ...fallback, monogram: "T3" },
    ]) {
      assert.deepEqual(yield* decodeStoredIcon(legacy), monogram);
      assert.deepEqual(yield* decodeReceivedIcon(legacy), monogram);
    }
  }),
);

effectIt.effect("an icon kind from a newer server shows the default icon", () =>
  Effect.gen(function* () {
    assert.isNull(yield* decodeReceivedIcon({ kind: "image", url: "https://example.com/a.png" }));
    const shell = yield* decodeProjectShell({
      id: "project-1",
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      projectIcon: { kind: "image", url: "https://example.com/a.png" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.isNull(shell.projectIcon);
    // A known kind with a broken payload still fails.
    const broken = yield* Effect.exit(decodeReceivedIcon({ kind: "emoji" }));
    assert.strictEqual(broken._tag, "Failure");
  }),
);
