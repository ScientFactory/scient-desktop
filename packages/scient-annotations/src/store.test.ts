// @effect-diagnostics nodeBuiltinImport:off -- Qualification against real files and independent processes.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { AnnotationCapture, type AnnotationCommand, type PdfTextCapture } from "./model.ts";
import {
  openAnnotationStore,
  type AnnotationAuthority,
  type AnnotationStoreHooks,
} from "./store.ts";

const isCapture = Schema.is(AnnotationCapture);
const roots: string[] = [];
const run = NodeUtil.promisify(NodeChildProcess.execFile);
const pdf = Buffer.from("%PDF-1.7\nsynthetic fixture, never a user document\n%%EOF");
const digest = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const capture: PdfTextCapture = {
  material: { sha256: digest(pdf), byteLength: pdf.length },
  extractorVersion: "pdfjs-test",
  profile: "pdfjs-text-layer-utf16-eol-v1",
  pages: [
    {
      page: 1,
      pageTextHash: digest("a😀b"),
      viewBox: [0, 0, 600, 800],
      rotation: 0,
      userUnit: 1,
      start: 1,
      end: 3,
      quote: "😀",
      prefix: "a",
      suffix: "b",
      rectangles: [[10, 10, 20, 20]],
    },
  ],
};
function authority() {
  let active = true;
  let tail = Promise.resolve();
  const locked = async <A>(task: () => Promise<A>): Promise<A> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
  const auth: AnnotationAuthority = {
    principal: "local-test-user",
    generation: "test-session-one",
    check: async () => {
      if (!active) throw new Error("revoked");
    },
    publish: locked,
  };
  return {
    auth,
    revoke: () =>
      locked(async () => {
        active = false;
      }),
  };
}
async function fixture(hooks?: AnnotationStoreHooks) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-annotations-"));
  roots.push(root);
  await initializeScientProject({ root, title: "Annotation fixture" });
  await NodeFSP.writeFile(NodePath.join(root, "paper.pdf"), pdf);
  const grant = authority();
  const store = await openAnnotationStore(root, grant.auth, hooks);
  const resource = (await store.resourceFor("paper.pdf", true))!;
  const command: AnnotationCommand = {
    action: "create",
    operationId: NodeCrypto.randomUUID(),
    annotationId: NodeCrypto.randomUUID(),
    resourceId: resource.resourceId,
    capture,
    note: "A note, not a highlight",
    highlighted: false,
  };
  return { root, store, resource, command, ...grant };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("document-owned annotation store", () => {
  it("keeps IDs when an annotated project file moves or gains an explicit Source-material alias", async () => {
    const f = await fixture();
    const created = (await f.store.mutate(f.command)).record!;
    await NodeFSP.rename(NodePath.join(f.root, "paper.pdf"), NodePath.join(f.root, "renamed.pdf"));
    const alias = await f.store.aliasResource({
      resourceId: f.resource.resourceId,
      relativePath: "renamed.pdf",
      materialHash: capture.material.sha256,
    });
    expect(alias.resourceId).toBe(f.resource.resourceId);
    expect((await f.store.list(alias.resourceId))[0]?.region).toEqual(created.region);
    await NodeFSP.mkdir(NodePath.join(f.root, "source-materials"));
    await NodeFSP.copyFile(
      NodePath.join(f.root, "renamed.pdf"),
      NodePath.join(f.root, "source-materials/reference.pdf"),
    );
    const registered = await f.store.aliasResource({
      resourceId: alias.resourceId,
      relativePath: "source-materials/reference.pdf",
      materialHash: capture.material.sha256,
    });
    expect((await f.store.list(registered.resourceId))[0]?.annotationId).toBe(created.annotationId);
    expect(await f.store.retainedStorage()).toEqual({ revisions: 1, byteLength: pdf.length });
  });

  it("never merges existing resource identities merely because their bytes match", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    await NodeFSP.copyFile(
      NodePath.join(f.root, "paper.pdf"),
      NodePath.join(f.root, "separate.pdf"),
    );
    const separate = (await f.store.resourceFor("separate.pdf", true))!;
    expect(separate.resourceId).not.toBe(f.resource.resourceId);
    await expect(
      f.store.aliasResource({
        resourceId: f.resource.resourceId,
        relativePath: "separate.pdf",
        materialHash: capture.material.sha256,
      }),
    ).rejects.toThrow("different document");
    expect(await f.store.list(separate.resourceId)).toEqual([]);
  });

  it("measures hundreds of annotations with bounded edits and one retained material copy", async () => {
    const f = await fixture();
    const started = performance.now();
    const count = 200;
    for (let i = 0; i < count; i++) {
      const command = {
        ...f.command,
        annotationId: "stress-" + i,
        operationId: NodeCrypto.randomUUID(),
      };
      await f.store.mutate(command, f.resource.locator);
      for (let revision = 1; revision <= 3; revision++) {
        await f.store.mutate({
          action: "edit",
          operationId: NodeCrypto.randomUUID(),
          annotationId: command.annotationId,
          expectedRevision: revision,
          highlighted: false,
          note: "Revision " + revision + " " + "x".repeat(256),
        });
      }
    }
    const readStart = performance.now();
    expect(await f.store.list(f.resource.resourceId)).toHaveLength(count);
    const readMs = performance.now() - readStart;
    expect(await f.store.retainedStorage()).toEqual({ revisions: 1, byteLength: pdf.length });
    // Generous reliability ceiling, not a claim about native visual performance.
    expect(readMs).toBeLessThan(10_000);
    expect(performance.now() - started).toBeLessThan(50_000);
  });
  it("opening an ordinary project is read-only and does not require Sources", async () => {
    const f = await fixture();
    const before = await NodeFSP.readdir(NodePath.join(f.root, ".scient"));
    const store = await openAnnotationStore(f.root, f.auth);
    expect(await store.list()).toEqual([]);
    expect(await store.resourceFor("unregistered.pdf")).toBeNull();
    expect(await NodeFSP.readdir(NodePath.join(f.root, ".scient"))).toEqual(before);
    expect(before).not.toContain("sources");
  });

  it("keeps stable annotation/region identities, raw UTF16, and separate notes/highlights", async () => {
    const f = await fixture();
    const created = await f.store.mutate(f.command);
    expect(created.record?.highlighted).toBe(false);
    expect(created.record?.region.capture).toEqual(capture);
    const edit = await f.store.mutate({
      action: "edit",
      annotationId: f.command.annotationId,
      operationId: NodeCrypto.randomUUID(),
      expectedRevision: 1,
      note: "Revised interpretation",
      highlighted: true,
      correctedText: "corrected",
    });
    expect(edit.record?.region).toEqual(created.record?.region);
    expect(edit.record?.correctedText).toEqual({ text: "corrected", author: f.auth.principal });
    expect(edit.record?.authorship).toEqual({ kind: "user", principal: f.auth.principal });
    expect(edit.record?.revision).toBe(2);
    expect((await f.store.history(f.command.annotationId))[0]?.record.note).toBe(
      "A note, not a highlight",
    );
  });

  it("supports geometry-only regions with no OCR, text offsets, or fake quote", async () => {
    const f = await fixture();
    if (f.command.action !== "create") throw new Error("fixture");
    const area = {
      material: capture.material,
      profile: "pdf-native-area-v1" as const,
      pages: [
        {
          page: 1,
          viewBox: [0, 0, 600, 800] as const,
          rotation: 90,
          userUnit: 1,
          rectangles: [[10, 20, 200, 300] as const],
        },
      ],
    };
    const result = await f.store.mutate({ ...f.command, capture: area });
    expect(result.record?.region.capture).toEqual(area);
    expect(isCapture({ ...area, pages: [{ ...area.pages[0], rectangles: [[-1, 0, 1, 1]] }] })).toBe(
      false,
    );
  });

  it("rejects broken native ranges and empty active annotations", async () => {
    const f = await fixture();
    expect(isCapture({ ...capture, pages: [{ ...capture.pages[0], end: 2 }] })).toBe(false);
    if (f.command.action !== "create") throw new Error("fixture");
    await expect(f.store.mutate({ ...f.command, note: " ", highlighted: false })).rejects.toThrow();
    expect(await f.store.list()).toEqual([]);
  });

  it("reconciles lost responses but refuses reusing operation IDs with changed content", async () => {
    let crash = true;
    const f = await fixture({
      at: async (point) => {
        if (point === "published" && crash) {
          crash = false;
          throw new Error("lost response");
        }
      },
    });
    await expect(f.store.mutate(f.command)).rejects.toThrow("lost response");
    const reopened = await openAnnotationStore(f.root, f.auth);
    expect((await reopened.mutate(f.command)).outcome).toBe("replayed");
    expect(await reopened.list()).toHaveLength(1);
    if (f.command.action !== "create") throw new Error("fixture");
    await expect(reopened.mutate({ ...f.command, note: "different" })).rejects.toThrow(
      "different content",
    );
  });

  it("never exposes half-published notes after failure between staging and publication", async () => {
    const f = await fixture({
      at: async (point) => {
        if (point === "staged") throw new Error("fault");
      },
    });
    await expect(f.store.mutate(f.command)).rejects.toThrow("fault");
    const reopened = await openAnnotationStore(f.root, f.auth);
    expect(await reopened.list()).toEqual([]);
    expect((await reopened.mutate(f.command)).outcome).toBe("committed");
  });

  it("concurrent editors yield one commit and explicit conflicts without overwrites", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        f.store.mutate({
          action: "edit",
          annotationId: f.command.annotationId,
          operationId: NodeCrypto.randomUUID(),
          expectedRevision: 1,
          note: "editor " + i,
          highlighted: false,
        }),
      ),
    );
    expect(results.filter((r) => r.outcome === "committed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "conflict")).toHaveLength(31);
    expect(await f.store.history(f.command.annotationId)).toHaveLength(2);
  });

  it("also prevents lost updates across independent Node processes", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    const script = [
      "import { openAnnotationStore } from " +
        JSON.stringify(new URL("./store.ts", import.meta.url).href) +
        ";",
      "const store = await openAnnotationStore(process.argv[1], {",
      'principal: "local-test-user", generation: "test-session-one",',
      "check: async () => {}, publish: (f) => f() });",
      "const result = await store.mutate(JSON.parse(process.argv[2]));",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            script,
            f.root,
            JSON.stringify({
              action: "edit",
              annotationId: f.command.annotationId,
              operationId: NodeCrypto.randomUUID(),
              expectedRevision: 1,
              note: "process " + i,
              highlighted: false,
            }),
          ],
          { timeout: 20_000 },
        ),
      ),
    );
    expect(
      results.map((r) => JSON.parse(r.stdout).outcome).filter((r) => r === "committed"),
    ).toHaveLength(1);
    expect(await f.store.history(f.command.annotationId)).toHaveLength(2);
  });

  it("retains one independent copy of the PDF across annotations and source-file deletion", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    await f.store.mutate({
      ...f.command,
      annotationId: NodeCrypto.randomUUID(),
      operationId: NodeCrypto.randomUUID(),
    });
    expect(
      await NodeFSP.readdir(NodePath.join(f.root, ".scient/evidence/v1/materials")),
    ).toHaveLength(1);
    await NodeFSP.unlink(NodePath.join(f.root, "paper.pdf"));
    const reopened = await openAnnotationStore(f.root, f.auth);
    expect(await NodeFSP.readFile(await reopened.retainedMaterial(f.command.annotationId))).toEqual(
      pdf,
    );
    expect(await reopened.list()).toHaveLength(2);
  });

  it("detects changed source bytes even if an old matching retention blob already exists", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    await NodeFSP.writeFile(
      NodePath.join(f.root, "paper.pdf"),
      Buffer.concat([pdf, Buffer.from("changed")]),
    );
    await expect(
      f.store.mutate({
        ...f.command,
        annotationId: NodeCrypto.randomUUID(),
        operationId: NodeCrypto.randomUUID(),
      }),
    ).rejects.toThrow("PDF changed");
    expect(await f.store.list()).toHaveLength(1);
  });

  it("detects corrupt retained bytes instead of silently returning another document", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    const retained = await f.store.retainedMaterial(f.command.annotationId);
    await NodeFSP.writeFile(retained, "bad");
    await expect(f.store.retainedMaterial(f.command.annotationId)).rejects.toThrow(
      "unavailable or changed",
    );
  });

  it("deletes and explicitly restores notes without dropping history or retained material", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    const removed = await f.store.mutate({
      action: "remove",
      operationId: NodeCrypto.randomUUID(),
      annotationId: f.command.annotationId,
      expectedRevision: 1,
    });
    expect(removed.record?.deletedAt).not.toBeNull();
    expect(
      (
        await f.store.mutate({
          action: "edit",
          operationId: NodeCrypto.randomUUID(),
          annotationId: f.command.annotationId,
          expectedRevision: 2,
          note: "should fail",
          highlighted: false,
        })
      ).outcome,
    ).toBe("conflict");
    const restored = await f.store.mutate({
      action: "restore",
      operationId: NodeCrypto.randomUUID(),
      annotationId: f.command.annotationId,
      expectedRevision: 2,
    });
    expect(restored.record?.deletedAt).toBeNull();
    expect(await f.store.history(f.command.annotationId)).toHaveLength(3);
  });

  it("revocation before publication prevents the commit and subsequent reads", async () => {
    let revoke: (() => Promise<void>) | undefined;
    const f = await fixture({
      at: async (point) => {
        if (point === "staged") await revoke?.();
      },
    });
    revoke = f.revoke;
    await expect(f.store.mutate(f.command)).rejects.toThrow("revoked");
    await expect(f.store.list()).rejects.toThrow("revoked");
    const reopened = await openAnnotationStore(f.root, authority().auth);
    expect(await reopened.list()).toEqual([]);
  });

  it("copied checkout IDs allow independent reading, never receipt replay into another checkout", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    const clone = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "scient-annotations-clone-"),
    );
    roots.push(clone);
    await NodeFSP.cp(f.root, clone, { recursive: true });
    const copy = await openAnnotationStore(clone, f.auth);
    expect(copy.scope.projectId).toBe(f.store.scope.projectId);
    expect(copy.scope.workspaceBinding).not.toBe(f.store.scope.workspaceBinding);
    expect(await copy.list()).toHaveLength(1);
    await expect(copy.mutate(f.command)).rejects.toThrow("authority");
  });

  it("new session generations cannot replay old receipts", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    const reopened = await openAnnotationStore(f.root, { ...f.auth, generation: "new-session" });
    await expect(reopened.mutate(f.command)).rejects.toThrow("authority");
  });

  it("replacing the project identity invalidates an in-flight store binding", async () => {
    const f = await fixture();
    const identityPath = NodePath.join(f.root, ".scient/project.json");
    const identity = JSON.parse(await NodeFSP.readFile(identityPath, "utf8"));
    await NodeFSP.writeFile(
      identityPath,
      JSON.stringify({ ...identity, projectId: NodeCrypto.randomUUID() }),
    );
    await expect(f.store.mutate(f.command)).rejects.toThrow("current workspace");
  });

  it("rejects traversal, unsafe store aliases, and out-of-project PDFs", async () => {
    const f = await fixture();
    await expect(f.store.resourceFor("../outside.pdf", true)).rejects.toThrow(
      "inside this project",
    );
    const outside = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "scient-annotations-outside-"),
    );
    roots.push(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "paper.pdf"), pdf);
    await NodeFSP.symlink(NodePath.join(outside, "paper.pdf"), NodePath.join(f.root, "linked.pdf"));
    const resource = (await f.store.resourceFor("linked.pdf", true))!;
    if (f.command.action !== "create") throw new Error("fixture");
    await expect(f.store.mutate({ ...f.command, resourceId: resource.resourceId })).rejects.toThrow(
      "outside its project",
    );
    await NodeFSP.symlink(outside, NodePath.join(f.root, ".scient/evidence/v1/annotations"));
    await expect(f.store.list()).rejects.toThrow("traverse links");
  });

  it("refuses gaps and corrupted history rather than treating them as fresh empty storage", async () => {
    const f = await fixture();
    await f.store.mutate(f.command);
    const dir = NodePath.join(f.root, ".scient/evidence/v1/annotations", f.command.annotationId);
    await NodeFSP.rename(NodePath.join(dir, "00000001.json"), NodePath.join(dir, "00000002.json"));
    // The stored revision must agree with the file slot as well as the contiguous history.
    await expect(f.store.history(f.command.annotationId)).rejects.toThrow();
  });
});
