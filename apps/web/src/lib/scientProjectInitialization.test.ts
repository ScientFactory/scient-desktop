import type { NativeApi, ScientProjectInitializationPreviewResult } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  scientProjectFolderName,
  prepareScientProjectForOpening,
  type ScientProjectInitializationDecision,
} from "./scientProjectInitialization";

function preview(
  overrides: Partial<ScientProjectInitializationPreviewResult> = {},
): ScientProjectInitializationPreviewResult {
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
    skills: [],
    issues: [],
    ...overrides,
  };
}

function apiWith(input: {
  previews: ScientProjectInitializationPreviewResult[];
  apply?: NativeApi["scientProjectInitialization"]["apply"];
  recover?: NativeApi["scientProjectInitialization"]["recover"];
  rollback?: NativeApi["scientProjectInitialization"]["rollback"];
}): Pick<NativeApi, "scientProjectInitialization"> {
  return {
    scientProjectInitialization: {
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
          activatedSkills: [],
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
          activatedSkills: [],
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

describe("scientProjectFolderName", () => {
  it("uses the selected folder name in the project-opening title", () => {
    expect(scientProjectFolderName("/research/immune-response-study")).toBe(
      "immune-response-study",
    );
    expect(scientProjectFolderName("C:\\research\\protein-folding")).toBe("protein-folding");
  });

  it("ignores trailing path separators", () => {
    expect(scientProjectFolderName("/research/quantum-materials/")).toBe("quantum-materials");
  });
});

describe("prepareScientProjectForOpening", () => {
  it("applies only the opaque server preview ID before opening", async () => {
    const apply = vi.fn(async () => ({
      root: "/research/example",
      projectId: "project-id",
      created: ["PROJECT.md"],
      preserved: [],
      proposed: [],
      activatedSkills: [],
      recovered: false,
    }));
    const api = apiWith({ previews: [preview()], apply });

    await expect(
      prepareScientProjectForOpening({
        api,
        root: "/research/example",
        requestDecision: async () => "apply",
      }),
    ).resolves.toBe("open");
    expect(apply).toHaveBeenCalledWith({ previewId: "opaque-preview" });
  });

  it("re-previews an exact skill selection before applying the replacement preview", async () => {
    const apply = vi.fn(async () => ({
      root: "/research/example",
      projectId: "project-id",
      created: ["PROJECT.md", ".scient/skills.lock.json", ".scient/project.json"],
      preserved: [],
      proposed: [],
      activatedSkills: [
        {
          id: "scient.evidence-to-note",
          version: "0.1.0",
          digest: `sha256:${"3".repeat(64)}`,
          origin: "scient:builtin" as const,
        },
      ],
      recovered: false,
    }));
    const api = apiWith({
      previews: [
        preview(),
        preview({
          previewId: "selected-preview",
          skills: [
            {
              id: "scient.evidence-to-note",
              version: "0.1.0",
              digest: `sha256:${"3".repeat(64)}`,
              origin: "scient:builtin",
              displayName: "Evidence to Note",
              description: "Draft an evidence-linked note proposal.",
              role: "constructive",
              selected: true,
              defaultSelected: false,
              readiness: "available",
              prerequisites: [],
              capabilities: {
                network: false,
                codeExecution: false,
                projectWrites: "proposal-only",
              },
            },
          ],
        }),
      ],
      apply,
    });
    const decisions: ScientProjectInitializationDecision[] = [
      { kind: "refresh-skills", skillIds: ["scient.evidence-to-note"] },
      "apply",
    ];

    await expect(
      prepareScientProjectForOpening({
        api,
        root: "/research/example",
        requestDecision: async () => decisions.shift() ?? "cancel",
      }),
    ).resolves.toBe("open");
    expect(api.scientProjectInitialization.preview).toHaveBeenNthCalledWith(2, {
      root: "/research/example",
      request: {
        title: "example",
        skillIds: ["scient.evidence-to-note"],
      },
    });
    expect(apply).toHaveBeenCalledWith({ previewId: "selected-preview" });
  });

  it("opens without writing when the researcher chooses the clean-folder path", async () => {
    const api = apiWith({ previews: [preview()] });

    await expect(
      prepareScientProjectForOpening({
        api,
        root: "/research/example",
        requestDecision: async () => "open-only",
      }),
    ).resolves.toBe("open");
    expect(api.scientProjectInitialization.apply).not.toHaveBeenCalled();
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
      prepareScientProjectForOpening({
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
      prepareScientProjectForOpening({
        api,
        root: "/research/example",
        requestDecision: async () => decisions.shift() ?? "cancel",
      }),
    ).resolves.toBe("open");
    expect(api.scientProjectInitialization.rollback).toHaveBeenCalledWith({
      previewId: "opaque-preview",
    });
    expect(api.scientProjectInitialization.preview).toHaveBeenCalledTimes(2);
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
      prepareScientProjectForOpening({
        api,
        root: "/research/example",
        requestDecision: async (_preview, error) => {
          errors.push(error);
          return decisions.shift() ?? "cancel";
        },
      }),
    ).resolves.toBe("cancel");
    expect(errors).toEqual([null, "Folder changed after preview."]);
    expect(api.scientProjectInitialization.preview).toHaveBeenCalledTimes(2);
  });
});
