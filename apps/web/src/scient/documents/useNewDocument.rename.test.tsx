// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type * as Placement from "./newDocumentPlacement";
import type * as Files from "./useNewDocumentFiles";
import type * as RegistryModule from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import type {
  MarkdownDraftCheckpoint,
  MarkdownDraftCheckpointStore,
} from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import type { MarkdownPersistenceTransport } from "~/scient/markdownEditor/persistence/markdownPersistenceTransport";

const mocks = vi.hoisted(() => ({
  rename: vi.fn(),
  registry: null as RegistryModule.MarkdownPersistenceRegistry | null,
  finished: null as null | (() => void),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { renameFile: Symbol("rename") } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.rename }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: () => mocks.finished?.() } }));
vi.mock(
  "~/scient/markdownEditor/persistence/markdownPersistenceRegistry",
  async (importOriginal) => ({
    ...(await importOriginal<typeof RegistryModule>()),
    markdownPersistenceRegistry: {
      getTargetSnapshot: (target: RegistryModule.MarkdownPersistenceTarget) =>
        mocks.registry!.getTargetSnapshot(target),
      open: (target: RegistryModule.MarkdownPersistenceTarget, owner?: object) =>
        mocks.registry!.open(target, owner),
    },
  }),
);
vi.mock("~/hooks/useLocalStorage", () => ({ useLocalStorage: () => ["article", () => {}] }));
vi.mock("./useTemplateSaving", () => ({
  useTemplateSaving: () => ({ menuItems: null, dialog: null }),
}));
vi.mock("./useTemplateChoices", () => ({ useTemplateChoices: () => [] }));
vi.mock("./useNewDocumentFiles", async () => ({
  ...(await vi.importActual<typeof Files>("./useNewDocumentFiles")),
  useNewDocumentFiles: () => ({ commandsFor: () => ({}) }),
}));
vi.mock("./newDocumentPlacement", async () => ({
  ...(await vi.importActual<typeof Placement>("./newDocumentPlacement")),
  filesUnder: async () => [
    "untitled/main.tex",
    "untitled/chapters/one.tex",
    "untitled/chapters/two.tex",
  ],
  freeFolderName: async () => "reviewed-thesis",
}));

import {
  MarkdownPersistenceRegistry,
  documentKeepsCheckpoint,
  documentReconcileStrategy,
  type MarkdownPersistenceLease,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { renameOpenDocument } from "~/scient/markdownEditor/persistence/renameOpenDocument";
import { useNewDocument } from "./useNewDocument";
import { newDocuments } from "./newDocuments";

const key = {
  environmentId: EnvironmentId.make("folder-rename-test"),
  cwd: "/synthetic",
  relativePath: "untitled/main.tex",
};
const destination = "reviewed-thesis/main.tex";
const source = String.raw`\documentclass{book}
\title{Reviewed thesis}
\begin{document}
\maketitle
\end{document}`;

describe("journaled folder title renames", () => {
  let root: Root;
  let host: HTMLDivElement;
  let disk: Map<string, { source: string; revision: string }>;
  let records: Map<string, MarkdownDraftCheckpoint>;
  let rootLease: MarkdownPersistenceLease;
  let controls: {
    refusal: string | null;
    rootRefused: boolean;
    loseRollback: boolean;
    quota: boolean;
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    mocks.rename.mockReset();
    mocks.finished = null;
    controls = { refusal: null, rootRefused: false, loseRollback: false, quota: false };
    disk = new Map([
      [key.relativePath, { source, revision: "rMain" }],
      ["untitled/chapters/one.tex", { source: "Chapter one", revision: "rOne" }],
      ["untitled/chapters/two.tex", { source: "Chapter two", revision: "rTwo" }],
    ]);
    records = new Map();
    const store: MarkdownDraftCheckpointStore = {
      read: async (path) => records.get(path),
      replace: async (path, token, next) => {
        if (controls.quota && next?.renameIntent) throw new Error("rename journal quota exhausted");
        if (records.get(path)?.token !== token) return false;
        if (next) records.set(path, next);
        else records.delete(path);
        return true;
      },
    };
    mocks.registry = new MarkdownPersistenceRegistry({
      checkpointStore: store,
      keepsCheckpoint: documentKeepsCheckpoint,
      reconcile: documentReconcileStrategy,
      createTransport: (target): MarkdownPersistenceTransport => ({
        read: async () => {
          const current = disk.get(target.relativePath);
          if (!current) throw new Error("missing");
          return current;
        },
        readForReview: async () =>
          disk.get(target.relativePath) ?? { missing: true, revision: null },
        write: async () => {
          throw new Error("A folder title rename must not publish source");
        },
        classifyFailure: (cause) =>
          typeof cause === "object" &&
          cause !== null &&
          "failure" in cause &&
          (cause.failure === "recovery_required" ||
            cause.failure === "target_changed" ||
            cause.failure === "mutation_unavailable" ||
            cause.failure === "mutation_intent_conflict")
            ? cause.failure
            : "terminal",
        project: () => {},
        subscribe: () => () => {},
      }),
    });
    mocks.rename.mockImplementation(
      async ({
        input,
      }: {
        input: {
          relativePath: string;
          destinationRelativePath: string;
          expectedRevision: string;
          mutationId: string;
          removeEmptyFolders?: boolean;
        };
      }) => {
        const intent = records.get(
          projectFileOperationKey({ ...key, relativePath: input.relativePath }),
        )?.renameIntent;
        expect(intent).toMatchObject({
          mutationId: input.mutationId,
          expectedRevision: input.expectedRevision,
          from: { ...key, relativePath: input.relativePath },
          destination: { ...key, relativePath: input.destinationRelativePath },
          removeEmptyFolders: true,
        });
        const current = disk.get(input.relativePath);
        if (controls.refusal && input.relativePath === "untitled/chapters/two.tex")
          return AsyncResult.failure(
            Cause.fail({
              failure: controls.refusal,
              recoveryId: "companion-recovery",
              retainedPaths: ["/retained/two.tex"],
            }),
          );
        if (controls.rootRefused && input.relativePath === key.relativePath)
          return AsyncResult.failure(Cause.fail({ failure: "revision_conflict" }));
        if (
          !current ||
          current.revision !== input.expectedRevision ||
          disk.has(input.destinationRelativePath)
        )
          return AsyncResult.failure(Cause.fail({ failure: "revision_conflict" }));
        disk.set(input.destinationRelativePath, current);
        disk.delete(input.relativePath);
        if (controls.loseRollback && input.relativePath === "reviewed-thesis/chapters/two.tex")
          throw new Error("Rollback reply lost after namespace mutation");
        return AsyncResult.success({
          destinationRelativePath: input.destinationRelativePath,
          revision: current.revision,
        });
      },
    );
    newDocuments.set(key, {
      format: "latex",
      template: "thesis",
      language: "english",
      seenUntouched: false,
      settled: false,
      companions: [
        { relativePath: "untitled/chapters/one.tex", revision: "rOne" },
        { relativePath: "untitled/chapters/two.tex", revision: "rTwo" },
      ],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    rootLease?.release();
    newDocuments.forget(key);
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function begin() {
    rootLease = await mocks.registry!.open(key, {});
    const finished = Promise.withResolvers<void>();
    mocks.finished = finished.resolve;
    function Harness() {
      const snapshot = useSyncExternalStore(rootLease.subscribe, rootLease.getSnapshot);
      useNewDocument({
        ...key,
        lease: rootLease,
        snapshot,
        renameDisabled: false,
        onRenamed: () => {},
        moveInPlace: (to, transaction) =>
          renameOpenDocument({
            lease: rootLease,
            destination: { ...key, relativePath: to },
            ...(transaction ? { transaction, removeEmptyFolders: true } : {}),
            rename: async (expectedRevision, mutationId, intent) => {
              const result = await mocks.rename({
                environmentId: intent.from.environmentId,
                input: {
                  cwd: intent.from.cwd,
                  relativePath: intent.from.relativePath,
                  destinationRelativePath: intent.destination.relativePath,
                  expectedRevision,
                  mutationId,
                  ...(intent.removeEmptyFolders ? { removeEmptyFolders: true } : {}),
                },
              });
              return result._tag === "Success"
                ? {
                    ok: true,
                    destinationRelativePath: result.value.destinationRelativePath,
                    revision: result.value.revision,
                  }
                : { ok: false, cause: squashAtomCommandFailure(result) };
            },
            follow: () => finished.resolve(),
            followed: async (path) => rootLease.target.relativePath === path,
          }),
      });
      return <span>{snapshot.draftSource}</span>;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => document.dispatchEvent(new Event("focusout", { bubbles: true })));
    // Failures either publish retained review or finish a definitive refusal.
    const forget = newDocuments.subscribe(() => {
      if (newDocuments.get(key) === null) finished.resolve();
    });
    if (newDocuments.get(key) === null) finished.resolve();
    await act(async () => finished.promise);
    forget();
  }

  it("journals every companion and the held main file before a supported fresh folder rename", async () => {
    await begin();
    expect(rootLease.target.relativePath).toBe(destination);
    expect(disk.get(destination)).toEqual({ source, revision: "rMain" });
    expect(disk.get("reviewed-thesis/chapters/one.tex")?.source).toBe("Chapter one");
    expect(disk.get("reviewed-thesis/chapters/two.tex")?.source).toBe("Chapter two");
    expect(disk.get(key.relativePath)).toBeUndefined();
    expect(rootLease.getSnapshot().draftSource).toBe(source);
  });

  it.each([
    "recovery_required",
    "target_changed",
    "mutation_unavailable",
    "mutation_intent_conflict",
  ])("stops compensation and retains the exact companion source after %s", async (failure) => {
    controls.refusal = failure;
    await begin();
    expect(rootLease.target).toEqual(key);
    expect(disk.get(key.relativePath)?.source).toBe(source);
    expect(disk.get("reviewed-thesis/chapters/one.tex")?.source).toBe("Chapter one");
    expect(disk.get("untitled/chapters/one.tex")).toBeUndefined();
    expect(disk.get("untitled/chapters/two.tex")?.source).toBe("Chapter two");
    const retained = records.get(
      projectFileOperationKey({ ...key, relativePath: "untitled/chapters/two.tex" }),
    )?.renameIntent;
    expect(retained).toMatchObject({
      source: "Chapter two",
      expectedRevision: "rTwo",
      destination: { ...key, relativePath: "reviewed-thesis/chapters/two.tex" },
    });
    expect(rootLease.getSnapshot().draftSource).toBe(source);
  });

  it("stops remaining compensation after a rollback response is lost, preserving its durable reverse intent", async () => {
    controls.rootRefused = true;
    controls.loseRollback = true;
    await begin();
    expect(rootLease.target).toEqual(key);
    expect(disk.get("reviewed-thesis/chapters/one.tex")?.source).toBe("Chapter one");
    expect(disk.get("untitled/chapters/one.tex")).toBeUndefined();
    expect(disk.get("untitled/chapters/two.tex")?.source).toBe("Chapter two");
    const reverse = records.get(
      projectFileOperationKey({ ...key, relativePath: "reviewed-thesis/chapters/two.tex" }),
    )?.renameIntent;
    expect(reverse).toMatchObject({
      source: "Chapter two",
      expectedRevision: "rTwo",
      destination: { ...key, relativePath: "untitled/chapters/two.tex" },
    });
    expect(rootLease.getSnapshot().draftSource).toBe(source);
  });
});
