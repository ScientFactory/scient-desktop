// @effect-diagnostics nodeBuiltinImport:off -- Real-filesystem migration and compatibility qualification.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { initializeScientProject } from "@scientfactory/project-init";
import { openAnnotationStore, type AnnotationAuthority } from "@scientfactory/annotations/store";
import {
  importScientSource,
  mutateScientSourcePassage,
  readScientSourceRecord,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
  sourceAttachmentAbsolutePath,
} from "@scientfactory/scient-sources/store";
import type { ScientSourceCandidate, ScientPassageCapture } from "@scientfactory/scient-sources";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { migrateLegacyAnnotations } from "./migrateLegacyAnnotations.ts";
import { makeAnnotationCoordinator } from "./AnnotationCoordinator.ts";

const roots: string[] = [];
const run = NodeUtil.promisify(NodeChildProcess.execFile);
const auth: AnnotationAuthority = {
  principal: "qa-user",
  generation: "qa-session",
  check: async () => {},
  publish: (f) => f(),
};
const candidate: ScientSourceCandidate = {
  sourceKey: "QA1",
  type: "article",
  customType: null,
  title: "Fixture paper",
  creators: [],
  issuedRaw: null,
  issuedYear: null,
  identifiers: [],
  abstract: null,
  containerTitle: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  tags: [],
  externalReferences: [],
  fieldProvenance: [],
  pdfAvailable: true,
  pdfFileName: "paper.pdf",
  pdfAttachmentCount: 1,
};
async function fixture(withPassage = true) {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "scient-annotation-migration-"),
  );
  roots.push(root);
  await initializeScientProject({ root });
  const pdfPath = NodePath.join(root, "paper.pdf");
  await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nfixture\n%%EOF");
  const imported = await importScientSource({
    root,
    operationId: NodeCrypto.randomUUID(),
    candidate,
    pdfPath,
  });
  const source = imported.record!;
  const attachment = source.attachments[0]!;
  const capture: ScientPassageCapture = {
    material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
    profile: "pdfjs-text-layer-utf16-eol-v1",
    extractorVersion: "test",
    pages: [
      {
        page: 1,
        pageTextHash: "a".repeat(64),
        viewBox: [0, 0, 600, 800],
        rotation: 0,
        userUnit: 1,
        start: 2,
        end: 4,
        quote: "😀",
        prefix: "ab",
        suffix: "cd",
        rectangles: [[10, 10, 100, 30]],
      },
    ],
  };
  const command = {
    action: "save" as const,
    passageId: "legacy-note",
    attachmentId: attachment.attachmentId,
    capture,
    note: "My interpretation",
    highlighted: false,
  };
  const input = { root, projectId: source.projectId, sourceId: source.sourceId };
  if (withPassage) {
    await mutateScientSourcePassage({ ...input, command });
    await mutateScientSourcePassage({
      ...input,
      command: {
        action: "update",
        passageId: command.passageId,
        expectedRevision: 1,
        note: "Reviewed interpretation",
      },
    });
  }
  const sourcePath = NodePath.join(
    root,
    SCIENT_SOURCE_RECORDS_DIRECTORY,
    source.sourceId + ".json",
  );
  return { root, source, attachment, capture, command, input, sourcePath };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("Phase 2A migration and host adapters", () => {
  it("recovers an experimental format-1 row without normalizing away its original bytes", async () => {
    const f = await fixture();
    const raw = JSON.parse(await NodeFSP.readFile(f.sourcePath, "utf8"));
    raw.formatVersion = 1;
    const original = JSON.stringify(raw);
    await NodeFSP.writeFile(f.sourcePath, original);
    const store = await openAnnotationStore(f.root, auth);
    await migrateLegacyAnnotations(store);
    expect((await store.list())[0]?.revision).toBe(2);
    expect(
      await NodeFSP.readFile(
        NodePath.join(
          f.root,
          ".scient/evidence/v1/imports/legacy-v1/sources",
          f.source.sourceId + ".json",
        ),
        "utf8",
      ),
    ).toBe(original);
    expect(
      (await readScientSourceRecord(f.root, f.source.sourceId))?.savedPassages,
    ).toBeUndefined();
  });

  it("rejects a different re-import instead of dropping newer legacy content", async () => {
    const f = await fixture();
    const store = await openAnnotationStore(f.root, auth);
    await migrateLegacyAnnotations(store);
    const commits = (await store.importedRecords())!;
    await expect(
      store.importLegacy({
        snapshots: [],
        records: commits.map((commit) => ({ ...commit.record, note: "Different interpretation" })),
      }),
    ).rejects.toThrow();
    expect((await store.list())[0]?.note).toBe("Reviewed interpretation");
  });

  it("resolves a retained version through the host after the original PDF disappears", async () => {
    const f = await fixture();
    const api = makeAnnotationCoordinator({ previewRoot: f.root, authority: auth });
    const request = {
      root: f.root,
      target: {
        kind: "source" as const,
        sourceId: f.source.sourceId,
        attachmentId: f.attachment.attachmentId,
      },
    };
    const open = await api.document(request, false);
    await api.document({ ...request, binding: open.binding! }, true);
    await NodeFSP.unlink(sourceAttachmentAbsolutePath(f.root, f.attachment));
    expect((await api.document(request, false)).annotations).toHaveLength(1);
    const retained = await api.material({
      root: f.root,
      binding: open.binding!,
      annotationId: "legacy-note",
    });
    expect(
      await NodeFSP.readFile(NodePath.join(retained.workspaceRoot, retained.relativePath), "utf8"),
    ).toContain("%PDF");
    expect(
      (
        await api.document(
          { root: f.root, target: { kind: "resource", resourceId: retained.resourceId } },
          false,
        )
      ).annotations,
    ).toHaveLength(1);
  });

  it("retains annotations outside Sources, with stable IDs and honest legacy provenance", async () => {
    const f = await fixture();
    const original = await NodeFSP.readFile(f.sourcePath, "utf8");
    const store = await openAnnotationStore(f.root, auth);
    await migrateLegacyAnnotations(store);
    const source = await readScientSourceRecord(f.root, f.source.sourceId);
    expect(source?.formatVersion).toBe(1);
    expect(source?.savedPassages).toBeUndefined();
    expect(source?.title).toBe(f.source.title);
    const [record] = await store.list();
    expect(record?.annotationId).toBe("legacy-note");
    expect(record?.revision).toBe(2);
    expect(record?.region.capture).toEqual(f.capture);
    expect(record?.note).toBe("Reviewed interpretation");
    expect(record?.highlighted).toBe(false);
    expect(record?.authorship.kind).toBe("imported");
    expect(record?.review.state).toBe("imported");
    expect(
      await NodeFSP.readFile(
        NodePath.join(
          f.root,
          ".scient/evidence/v1/imports/legacy-v1/sources",
          f.source.sourceId + ".json",
        ),
        "utf8",
      ),
    ).toBe(original);
    expect(
      await NodeFSP.readdir(NodePath.join(f.root, ".scient/evidence/v1/imports/legacy-v1/sources")),
    ).toHaveLength(3);
    await migrateLegacyAnnotations(await openAnnotationStore(f.root, auth));
    expect(await store.list()).toHaveLength(1);
    const edited = await store.mutate({
      action: "edit",
      operationId: NodeCrypto.randomUUID(),
      annotationId: "legacy-note",
      expectedRevision: 2,
      highlighted: false,
      note: "New independent edit",
    });
    expect(edited.record?.revision).toBe(3);
    await expect(mutateScientSourcePassage({ ...f.input, command: f.command })).rejects.toThrow(
      "belong to documents",
    );
  });

  it("migrates format-1 Sources without manufacturing annotations or replacing metadata", async () => {
    const f = await fixture(false);
    const before = await NodeFSP.readFile(f.sourcePath, "utf8");
    const store = await openAnnotationStore(f.root, auth);
    await migrateLegacyAnnotations(store);
    expect(await store.list()).toEqual([]);
    expect(await NodeFSP.readFile(f.sourcePath, "utf8")).toBe(before);
  });

  it("keeps the original source and exposes no partial import after a staged failure", async () => {
    const f = await fixture();
    const before = await NodeFSP.readFile(f.sourcePath, "utf8");
    let fail = true;
    const store = await openAnnotationStore(f.root, auth, {
      at: async (point) => {
        if (point === "staged" && fail) {
          fail = false;
          throw new Error("interrupted");
        }
      },
    });
    await expect(migrateLegacyAnnotations(store)).rejects.toThrow("interrupted");
    expect(await store.list()).toEqual([]);
    expect(await NodeFSP.readFile(f.sourcePath, "utf8")).toBe(before);
    await migrateLegacyAnnotations(await openAnnotationStore(f.root, auth));
    expect(await store.list()).toHaveLength(1);
  });

  it("recovers a published import whose compatibility cleanup never received its response", async () => {
    const f = await fixture();
    const store = await openAnnotationStore(f.root, auth, {
      at: async (point) => {
        if (point === "published") throw new Error("lost response");
      },
    });
    await expect(migrateLegacyAnnotations(store)).rejects.toThrow("lost response");
    expect((await readScientSourceRecord(f.root, f.source.sourceId))?.formatVersion).toBe(2);
    const reopened = await openAnnotationStore(f.root, auth);
    await migrateLegacyAnnotations(reopened);
    expect(await reopened.list()).toHaveLength(1);
    expect((await readScientSourceRecord(f.root, f.source.sourceId))?.formatVersion).toBe(1);
  });

  it("stops on changed PDF bytes without erasing or stripping legacy notes", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(
      sourceAttachmentAbsolutePath(f.root, f.attachment),
      "%PDF-1.7\nchanged",
    );
    await expect(migrateLegacyAnnotations(await openAnnotationStore(f.root, auth))).rejects.toThrow(
      "PDF changed",
    );
    expect((await readScientSourceRecord(f.root, f.source.sourceId))?.savedPassages).toHaveLength(
      1,
    );
  });

  it("uses the same host path for an ordinary PDF and a Source PDF, with bound mutation contexts", async () => {
    const f = await fixture(false);
    const api = makeAnnotationCoordinator({ previewRoot: f.root, authority: auth });
    const file = { root: f.root, target: { kind: "file" as const, relativePath: "paper.pdf" } };
    const opened = await api.document(file, false);
    expect(opened.resource).toBeNull();
    const prepared = await api.document({ ...file, binding: opened.binding! }, true);
    expect(prepared.resource).not.toBeNull();
    const result = await api.mutate({
      ...file,
      binding: prepared.binding!,
      command: {
        action: "create",
        operationId: NodeCrypto.randomUUID(),
        annotationId: NodeCrypto.randomUUID(),
        resourceId: prepared.resource!.resourceId,
        capture: f.capture,
        note: "Ordinary project document",
        highlighted: false,
      },
    });
    expect(result.outcome).toBe("committed");
    expect((await api.document(file, false)).annotations).toHaveLength(1);
    const source = {
      root: f.root,
      target: {
        kind: "source" as const,
        sourceId: f.source.sourceId,
        attachmentId: f.attachment.attachmentId,
      },
    };
    expect((await api.document(source, false)).annotations).toHaveLength(0);
    await expect(
      api.mutate({
        ...source,
        binding: prepared.binding!,
        command: {
          action: "remove",
          annotationId: result.record!.annotationId,
          operationId: NodeCrypto.randomUUID(),
          expectedRevision: 1,
        },
      }),
    ).rejects.toThrow();
    await expect(
      api.document(
        { ...file, binding: { ...prepared.binding!, workspaceBinding: "0".repeat(64) } },
        true,
      ),
    ).rejects.toThrow("context changed");
  });

  it("requires exact preview-root opt-in and does not enable live or sibling projects", async () => {
    const f = await fixture(false);
    const request = { root: f.root, target: { kind: "file" as const, relativePath: "paper.pdf" } };
    const disabled = makeAnnotationCoordinator({ previewRoot: undefined, authority: auth });
    expect((await disabled.document(request, false)).enabled).toBe(false);
    const other = await fixture(false);
    const scoped = makeAnnotationCoordinator({ previewRoot: other.root, authority: auth });
    expect((await scoped.document(request, false)).enabled).toBe(false);
    await expect(
      scoped.mutate({
        ...request,
        binding: { generation: "0".repeat(64), workspaceBinding: "0".repeat(64) },
        command: {
          action: "remove",
          operationId: NodeCrypto.randomUUID(),
          annotationId: "anything",
          expectedRevision: 1,
        },
      }),
    ).rejects.toThrow("not enabled");
  });

  it.skipIf(!process.env.SCIENT_LEGACY_SOURCE_WRITER)(
    "survives deletion by the actual older Source writer",
    async () => {
      const f = await fixture();
      const store = await openAnnotationStore(f.root, auth);
      await migrateLegacyAnnotations(store);
      const source = (await readScientSourceRecord(f.root, f.source.sourceId))!;
      const moduleUrl = NodeURL.pathToFileURL(process.env.SCIENT_LEGACY_SOURCE_WRITER!).href;
      const script = [
        "import { removeScientSource } from " + JSON.stringify(moduleUrl) + ";",
        "const result = await removeScientSource(JSON.parse(process.argv[1]));",
        "process.stdout.write(JSON.stringify(result));",
      ].join("\n");
      const { stdout } = await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          JSON.stringify({
            root: f.root,
            sourceId: source.sourceId,
            expectedRevision: source.revision,
          }),
        ],
        { timeout: 20_000 },
      );
      expect(JSON.parse(stdout).outcome).toBe("removed");
      expect(JSON.parse(stdout).removedAttachmentCount).toBe(1);
      await expect(
        NodeFSP.stat(sourceAttachmentAbsolutePath(f.root, f.attachment)),
      ).rejects.toThrow();
      const reopened = await openAnnotationStore(f.root, auth);
      expect(
        await NodeFSP.readFile(await reopened.retainedMaterial("legacy-note"), "utf8"),
      ).toContain("%PDF");
      expect((await reopened.list())[0]?.note).toBe("Reviewed interpretation");
    },
  );
});
