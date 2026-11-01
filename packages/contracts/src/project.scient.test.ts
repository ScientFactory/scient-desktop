import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  ProjectReadFileError,
  ProjectFileWatchEvent,
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectMutation,
  ProjectReadFileInput,
  ProjectRenameFileInput,
  ProjectUpdatePayload,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectDeleteFileInput,
  ProjectDeleteFileError,
  ProjectRenameFileError,
  ProjectListFileVersionsResult,
  ProjectResolveFileMutationInput,
  ProjectResolveFileMutationResult,
  ProjectReadFileResult,
} from "./project.ts";

const decodeProjectUpdatePayload = Schema.decodeUnknownSync(ProjectUpdatePayload);
const decodeProjectMutation = Schema.decodeUnknownSync(ProjectMutation);
const encodeProjectMutation = Schema.encodeSync(ProjectMutation);
const decodeFileWatchEvent = Schema.decodeUnknownSync(ProjectFileWatchEvent);
const decodeListDirectoryInput = Schema.decodeUnknownSync(ProjectListDirectoryInput);
const decodeListDirectoryResult = Schema.decodeUnknownSync(ProjectListDirectoryResult);
const decodeReadFileError = Schema.decodeUnknownSync(ProjectReadFileError);
const encodeReadFileError = Schema.encodeSync(ProjectReadFileError);
const decodeWriteFileError = Schema.decodeUnknownSync(ProjectWriteFileError);
const encodeWriteFileError = Schema.encodeSync(ProjectWriteFileError);
const decodeDeleteFileError = Schema.decodeUnknownSync(ProjectDeleteFileError);
const encodeDeleteFileError = Schema.encodeSync(ProjectDeleteFileError);
const decodeRenameFileError = Schema.decodeUnknownSync(ProjectRenameFileError);
const encodeRenameFileError = Schema.encodeSync(ProjectRenameFileError);
const decodeResolveFileMutationResult = Schema.decodeUnknownSync(ProjectResolveFileMutationResult);
const encodeResolveFileMutationResult = Schema.encodeSync(ProjectResolveFileMutationResult);
const decodeListFileVersionsResult = Schema.decodeUnknownSync(ProjectListFileVersionsResult);
const decodeReadFileResult = Schema.decodeUnknownSync(ProjectReadFileResult);
const encodeResolveFileMutationInput = Schema.encodeSync(ProjectResolveFileMutationInput);

describe("retained file mutation contracts", () => {
  it("rejects empty mutation identities while allowing callers without an identity", () => {
    const common = { cwd: "/workspace", relativePath: "notes.md" };
    const write = Schema.decodeUnknownSync(ProjectWriteFileInput);
    const rename = Schema.decodeUnknownSync(ProjectRenameFileInput);
    const remove = Schema.decodeUnknownSync(ProjectDeleteFileInput);
    const writeInput = { ...common, contents: "saved" };
    const renameInput = { ...common, destinationRelativePath: "renamed.md" };
    const deleteInput = { ...common, expectedRevision: "revision-1" };
    expect(write(writeInput)).toEqual(writeInput);
    expect(rename(renameInput)).toEqual(renameInput);
    expect(remove(deleteInput)).toEqual(deleteInput);
    expect(() => write({ ...writeInput, mutationId: " " })).toThrow();
    expect(() => rename({ ...renameInput, mutationId: " " })).toThrow();
    expect(() => remove({ ...deleteInput, mutationId: " " })).toThrow();
  });

  it("round trips recovery viewer paths through mutation errors", () => {
    const context = {
      cwd: "/workspace",
      relativePath: "notes.md",
      failure: "recovery_required" as const,
      mutationId: "mutation-1",
      publicationOutcome: "retained-attention" as const,
      recoveryId: "recovery-1",
      retainedPaths: ["/workspace/.scient/retained/one", "/workspace/.scient/retained/two"],
    };
    expect(
      decodeReadFileError(encodeReadFileError(new ProjectReadFileError(context))),
    ).toMatchObject(context);
    expect(
      decodeWriteFileError(encodeWriteFileError(new ProjectWriteFileError(context))),
    ).toMatchObject(context);
    expect(
      decodeDeleteFileError(encodeDeleteFileError(new ProjectDeleteFileError(context))),
    ).toMatchObject(context);
    const rename = new ProjectRenameFileError({
      ...context,
      destinationRelativePath: "renamed.md",
    });
    expect(decodeRenameFileError(encodeRenameFileError(rename))).toMatchObject(context);
  });

  it.each([
    "target_changed",
    "recovery_required",
    "mutation_unavailable",
    "mutation_intent_conflict",
  ] as const)("does not invent publication authority while decoding %s", (failure) => {
    const decode = decodeWriteFileError;
    const legacy = decode({
      _tag: "ProjectWriteFileError",
      cwd: "/workspace",
      relativePath: "notes.md",
      failure,
      message: "Publication refused.",
    });
    expect(legacy.publicationOutcome).toBeUndefined();
    for (const publicationOutcome of ["unchanged", "retained-attention"] as const) {
      const encoded = encodeWriteFileError(
        new ProjectWriteFileError({
          cwd: "/workspace",
          relativePath: "notes.md",
          failure,
          mutationId: "owned-intent",
          publicationOutcome,
        }),
      );
      expect(decode(encoded)).toMatchObject({
        failure,
        mutationId: "owned-intent",
        publicationOutcome,
      });
    }
    expect(() =>
      decode({
        ...legacy,
        publicationOutcome: "probably-unchanged",
      }),
    ).toThrow();
  });

  it("preserves retained revisions and an unlimited quota without inventing a limit", () => {
    const result = {
      versions: [
        {
          versionId: "version-1",
          mutationId: "mutation-1",
          retainedPath: "/workspace/.scient/retained/one",
          revision: null,
          byteLength: 7,
          retainedAt: 123,
        },
      ],
      retainedBytes: 7,
      limitBytes: null,
      attention: null,
    };
    expect(decodeListFileVersionsResult(result)).toEqual(result);
  });

  it("carries durable attention on both authoritative reads and version inventory", () => {
    const attention = {
      recoveryId: "recovery-1",
      mutationId: "mutation-1",
      retainedPaths: ["/workspace/.scient/retained/one"],
      message: "Review the retained publication.",
    };
    expect(
      decodeReadFileResult({
        relativePath: "notes.md",
        contents: "current",
        byteLength: 7,
        truncated: false,
        revision: "revision-1",
        publicationAttention: attention,
      }).publicationAttention,
    ).toEqual(attention);
    expect(
      decodeListFileVersionsResult({
        versions: [],
        retainedBytes: 0,
        limitBytes: null,
        attention,
      }).attention,
    ).toEqual(attention);
  });

  it.each(["revision-1", null])(
    "requires an explicit reviewed current revision or absence for acceptance: %s",
    (currentRevision) => {
      const input = {
        cwd: "/workspace",
        relativePath: "notes.md",
        recoveryId: "recovery-1",
        currentRevision,
        choice: "accept-current" as const,
      };
      const decode = Schema.decodeUnknownSync(ProjectResolveFileMutationInput);
      expect(decode(encodeResolveFileMutationInput(input))).toEqual(input);
      const result = { recoveryId: input.recoveryId, revision: currentRevision };
      expect(decodeResolveFileMutationResult(encodeResolveFileMutationResult(result))).toEqual(
        result,
      );
      expect(() => decode({ ...input, recoveryId: undefined })).toThrow();
      expect(() => decode({ ...input, currentRevision: undefined })).toThrow();
      expect(() => decode({ ...input, currentRevision: " " })).toThrow();
      expect(() => decode({ ...input, choice: "overwrite" })).toThrow();
      expect(() =>
        decodeResolveFileMutationResult({
          ...result,
          revision: undefined,
        }),
      ).toThrow();
      expect(() =>
        decodeResolveFileMutationResult({
          ...result,
          revision: "",
        }),
      ).toThrow();
    },
  );

  it("does not extend reviewed absence to source reads or revision-conflict metadata", () => {
    expect(() =>
      decodeReadFileResult({
        relativePath: "notes.md",
        contents: "",
        byteLength: 0,
        truncated: false,
        revision: null,
      }),
    ).toThrow();
    expect(() =>
      decodeWriteFileError({
        _tag: "ProjectWriteFileError",
        cwd: "/workspace",
        relativePath: "notes.md",
        failure: "revision_conflict",
        message: "Current file differs.",
        currentRevision: null,
      }),
    ).toThrow();
  });

  it("distinguishes authoritative pathname absence from ordinary not-found read failures", () => {
    const input = {
      cwd: "/workspace",
      relativePath: "notes.md",
      failure: "operation_failed" as const,
      reason: "not_found" as const,
    };
    const decode = decodeReadFileError;
    const encode = encodeReadFileError;
    expect(decode(encode(new ProjectReadFileError(input))).currentMissing).toBeUndefined();
    const missing = new ProjectReadFileError({ ...input, currentMissing: true });
    expect(decode(encode(missing))).toMatchObject({ ...input, currentMissing: true });
    for (const currentMissing of [false, null]) {
      expect(() => decode({ ...encode(missing), currentMissing })).toThrow();
    }
  });
});

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
  // regression: 32f72e1b19 fix(projects): preserve older V2 monogram updates
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
});
