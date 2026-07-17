import type { NativeApi, PapiLabProjectInitializationPreviewResult } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { preparePapiLabProjectForOpening } from "./papilabProjectInitialization";

function preview(
  overrides: Partial<PapiLabProjectInitializationPreviewResult> = {},
): PapiLabProjectInitializationPreviewResult {
  return {
    previewId: "opaque-preview",
    expiresAt: "2026-07-17T10:00:00.000Z",
    root: "/research/example",
    folderState: "empty-uninitialized",
    status: "ready",
    projectId: "project-id",
    canApply: true,
    canRecover: false,
    canRollback: false,
    operations: [],
    issues: [],
    ...overrides,
  };
}

function apiWith(input: {
  previews: PapiLabProjectInitializationPreviewResult[];
  apply?: NativeApi["papilabProjectInitialization"]["apply"];
  recover?: NativeApi["papilabProjectInitialization"]["recover"];
  rollback?: NativeApi["papilabProjectInitialization"]["rollback"];
}): Pick<NativeApi, "papilabProjectInitialization"> {
  return {
    papilabProjectInitialization: {
      preview: vi.fn(async () => {
        const next = input.previews.shift();
        if (!next) throw new Error("No preview configured.");
        return next;
      }),
      apply:
        input.apply ??
        vi.fn(async () => ({
          root: "/research/example",
          projectId: "project-id",
          created: ["PROJECT.md"],
          preserved: [],
          proposed: [],
          recovered: false,
        })),
      recover:
        input.recover ??
        vi.fn(async () => ({
          root: "/research/example",
          projectId: "project-id",
          created: [],
          preserved: [],
          proposed: [],
          recovered: true,
        })),
      rollback:
        input.rollback ??
        vi.fn(async () => ({
          root: "/research/example",
          complete: true,
          removed: [],
          preserved: [],
        })),
    },
  };
}

describe("preparePapiLabProjectForOpening", () => {
  it("applies only the opaque server preview ID before opening", async () => {
    const apply = vi.fn(async () => ({
      root: "/research/example",
      projectId: "project-id",
      created: ["PROJECT.md"],
      preserved: [],
      proposed: [],
      recovered: false,
    }));
    const api = apiWith({ previews: [preview()], apply });

    await expect(
      preparePapiLabProjectForOpening({
        api,
        root: "/research/example",
        requestDecision: async () => "apply",
      }),
    ).resolves.toBe("open");
    expect(apply).toHaveBeenCalledWith({ previewId: "opaque-preview" });
  });

  it("opens without writing when the researcher chooses the clean-folder path", async () => {
    const api = apiWith({ previews: [preview()] });

    await expect(
      preparePapiLabProjectForOpening({
        api,
        root: "/research/example",
        requestDecision: async () => "open-only",
      }),
    ).resolves.toBe("open");
    expect(api.papilabProjectInitialization.apply).not.toHaveBeenCalled();
  });

  it("recognizes an initialized project without asking for another decision", async () => {
    const api = apiWith({
      previews: [
        preview({
          previewId: null,
          expiresAt: null,
          folderState: "initialized-compatible",
          status: "already-initialized",
          canApply: false,
        }),
      ],
    });
    const requestDecision = vi.fn(async () => "cancel" as const);

    await expect(
      preparePapiLabProjectForOpening({
        api,
        root: "/research/example",
        requestDecision,
      }),
    ).resolves.toBe("already-initialized");
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it("re-previews after rollback and allows a clean-folder choice", async () => {
    const recoveryPreview = preview({
      status: "recovery-required",
      folderState: "partially-initialized",
      canApply: false,
      canRecover: true,
      canRollback: true,
    });
    const cleanPreview = preview({ previewId: "fresh-preview" });
    const api = apiWith({ previews: [recoveryPreview, cleanPreview] });
    const decisions: Array<"rollback" | "open-only"> = ["rollback", "open-only"];

    await expect(
      preparePapiLabProjectForOpening({
        api,
        root: "/research/example",
        requestDecision: async () => decisions.shift() ?? "cancel",
      }),
    ).resolves.toBe("open");
    expect(api.papilabProjectInitialization.rollback).toHaveBeenCalledWith({
      previewId: "opaque-preview",
    });
    expect(api.papilabProjectInitialization.preview).toHaveBeenCalledTimes(2);
  });

  it("shows action errors on a fresh preview rather than replaying a consumed plan", async () => {
    const api = apiWith({
      previews: [preview(), preview({ previewId: "replacement-preview" })],
      apply: vi.fn(async () => {
        throw new Error("Folder changed after preview.");
      }),
    });
    const errors: Array<string | null> = [];
    const decisions: Array<"apply" | "cancel"> = ["apply", "cancel"];

    await expect(
      preparePapiLabProjectForOpening({
        api,
        root: "/research/example",
        requestDecision: async (_preview, error) => {
          errors.push(error);
          return decisions.shift() ?? "cancel";
        },
      }),
    ).resolves.toBe("cancel");
    expect(errors).toEqual([null, "Folder changed after preview."]);
    expect(api.papilabProjectInitialization.preview).toHaveBeenCalledTimes(2);
  });
});
