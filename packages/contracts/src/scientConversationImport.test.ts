import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  ConversationImportId,
  ConversationImportResourceId,
  SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES,
  ScientConversationImportCancelResult,
  ScientConversationImportConfirmRequest,
  ScientConversationImportCreateUploadRequest,
  ScientConversationImportError,
  ScientConversationImportPreview,
} from "./scientConversationImport.ts";
import { SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES } from "./scientConversationExport.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PACKAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const IMPORT_ID = "cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

const decodeImportId = Schema.decodeUnknownSync(ConversationImportId);
const isResourceId = Schema.is(ConversationImportResourceId);
const decodeCreateUpload = Schema.decodeUnknownSync(ScientConversationImportCreateUploadRequest);
const decodePreview = Schema.decodeUnknownSync(ScientConversationImportPreview);
const encodePreview = Schema.encodeSync(ScientConversationImportPreview);
const decodeConfirm = Schema.decodeUnknownSync(ScientConversationImportConfirmRequest);
const decodeCancelResult = Schema.decodeUnknownSync(ScientConversationImportCancelResult);
const decodeError = Schema.decodeUnknownSync(ScientConversationImportError);

const packageSummary = {
  format: "scient.conversation-file",
  formatVersion: { major: 1, minor: 0 },
  exporter: { name: "Scient", version: "0.7.0" },
  exportId: "7f3c9a2e41b8",
  exportedAt: "2026-09-28T09:12:00.000Z",
  sourceThreadId: "thread-on-another-machine",
  contentDigest: DIGEST,
  packageSha256: PACKAGE_DIGEST,
  packageBytes: 4_096,
};

const preview = {
  importId: IMPORT_ID,
  kind: "scic",
  fileName: "Export design.scic",
  package: packageSummary,
  conversation: {
    title: "Export design",
    createdAt: "2026-09-27T14:00:00.000Z",
    updatedAt: "2026-09-27T15:00:00.000Z",
    provider: "codex",
    model: "gpt-5",
  },
  counts: {
    messages: 12,
    attachments: 2,
    reasoning: 0,
    workLogEntries: 0,
    proposedPlans: 1,
    questionAnswers: 0,
  },
  omissions: [
    { _tag: "work-log-excluded" },
    { _tag: "reasoning-excluded" },
    { _tag: "range-truncated", throughMessageN: 12 },
    {
      _tag: "snapshot-warning",
      warning: { _tag: "attachment-unavailable", name: "notes.pdf", messageN: 3 },
    },
  ],
  warnings: [
    {
      _tag: "export-warning",
      warning: { code: "attachment-unavailable", message: "notes.pdf was unavailable." },
    },
    { _tag: "newer-minor-version", formatVersion: { major: 1, minor: 3 } },
  ],
  expiresAt: 1_790_000_000_000,
};

describe("conversation import contracts", () => {
  it("accepts only server-issued import IDs", () => {
    expect(decodeImportId(IMPORT_ID)).toBe(IMPORT_ID);
    for (const id of ["cimp_1", "thread-1", `cimp_${"0".repeat(36)}`, IMPORT_ID.toUpperCase()]) {
      expect(() => decodeImportId(id)).toThrow();
    }
  });

  it("keeps package resource IDs to one opaque form", () => {
    expect(isResourceId("attachment-1")).toBe(true);
    expect(isResourceId("attachment-120")).toBe(true);
    for (const id of ["attachment-0", "attachment-01", "attachments/a.png", "thread-1-5b8f1c2e"]) {
      expect(isResourceId(id)).toBe(false);
    }
  });

  it("admits uploads up to the import limit, not the chat attachment limit", () => {
    expect(SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES).toBeGreaterThan(
      SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES,
    );
    expect(
      decodeCreateUpload({
        fileName: "Export design.scic",
        sizeBytes: SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES,
      }).sizeBytes,
    ).toBe(SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES);
    expect(() => decodeCreateUpload({ fileName: "a.scic", sizeBytes: 0 })).toThrow();
    expect(() =>
      decodeCreateUpload({
        fileName: "a.scic",
        sizeBytes: SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES + 1,
      }),
    ).toThrow();
  });

  it("round-trips a preview with omissions and warnings", () => {
    const decoded = decodePreview(preview);
    expect(encodePreview(decoded)).toEqual(preview);
  });

  it("refuses a preview that claims another format or a malformed package digest", () => {
    expect(() =>
      decodePreview({ ...preview, package: { ...packageSummary, format: "zip" } }),
    ).toThrow();
    expect(() =>
      decodePreview({ ...preview, package: { ...packageSummary, packageSha256: "sha256:x" } }),
    ).toThrow();
    expect(() =>
      decodePreview({
        ...preview,
        package: { ...packageSummary, formatVersion: { major: 0, minor: 1 } },
      }),
    ).toThrow();
  });

  it("binds a confirm to the previewed package and a destination", () => {
    const confirm = decodeConfirm({
      importId: IMPORT_ID,
      packageSha256: PACKAGE_DIGEST,
      destination: {
        projectId: "project-1",
        modelSelection: { instanceId: "claude", model: "claude-opus-4" },
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    });
    expect(confirm.destination.modelSelection.instanceId).toBe("claude");
    expect(() =>
      decodeConfirm({ importId: IMPORT_ID, destination: confirm.destination }),
    ).toThrow();
    expect(() =>
      decodeConfirm({ importId: IMPORT_ID, packageSha256: PACKAGE_DIGEST, destination: {} }),
    ).toThrow();
  });

  it("reports a cancel that lost the race to a committed import", () => {
    expect(decodeCancelResult({ _tag: "cancelled" })._tag).toBe("cancelled");
    const lost = decodeCancelResult({
      _tag: "already-imported",
      result: { importId: IMPORT_ID, threadId: "thread-2", messageCount: 12, attachmentCount: 2 },
    });
    expect(lost._tag === "already-imported" && lost.result.threadId).toBe("thread-2");
  });

  it("carries a typed rejection on the import error", () => {
    const error = decodeError({
      _tag: "ScientConversationImportError",
      reason: "package-rejected",
      rejection: { reason: "unsafe-path", entry: "../../etc/passwd" },
      message: "The file contains an unsafe path.",
    });
    expect(error.rejection).toEqual({ reason: "unsafe-path", entry: "../../etc/passwd" });
    expect(() =>
      decodeError({
        _tag: "ScientConversationImportError",
        reason: "package-rejected",
        rejection: { reason: "looks-odd", entry: null },
        message: "x",
      }),
    ).toThrow();
  });
});
