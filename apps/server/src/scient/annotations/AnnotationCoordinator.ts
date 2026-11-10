// @effect-diagnostics nodeBuiltinImport:off -- Host-resolved document adapters and preview activation.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { openAnnotationStore, type AnnotationAuthority } from "@scientfactory/annotations/store";
import type {
  AnnotationDocumentRequest,
  AnnotationDocumentResult,
  AnnotationPrepareRequest,
  AnnotationMutationRequest,
  AnnotationMaterialRequest,
} from "@t3tools/contracts";
import {
  listScientSourceRecords,
  readScientSourceRecord,
  sourceAttachmentAbsolutePath,
} from "@scientfactory/scient-sources/store";
import { migrateLegacyAnnotations } from "./migrateLegacyAnnotations.ts";

/** Explicit root opt-in keeps the Proposed storage format out of live projects. */
export function makeAnnotationCoordinator(input: {
  readonly previewRoot: string | undefined;
  readonly authority: AnnotationAuthority;
}) {
  async function enabled(root: string) {
    if (!input.previewRoot) return false;
    return (await NodeFSP.realpath(root)) === (await NodeFSP.realpath(input.previewRoot));
  }
  async function openStore(root: string) {
    if (!(await enabled(root)))
      throw new Error("Document annotations are not enabled for this project.");
    return openAnnotationStore(root, input.authority);
  }
  async function locators(
    request: AnnotationDocumentRequest,
    store: Awaited<ReturnType<typeof openStore>>,
  ) {
    if (request.target.kind === "file") return [request.target.relativePath];
    if (request.target.kind === "resource")
      return [(await store.resourceById(request.target.resourceId)).locator];
    const root = await NodeFSP.realpath(request.root);
    const source = await readScientSourceRecord(root, request.target.sourceId);
    if (!source) {
      const target = request.target;
      const ids = [
        ...new Set(
          (await store.list())
            .filter(
              (record) =>
                record.importedFrom?.sourceId === target.sourceId &&
                (!target.attachmentId || record.importedFrom.attachmentId === target.attachmentId),
            )
            .map((record) => record.region.resourceId),
        ),
      ];
      if (!ids.length) throw new Error("This Source is unavailable.");
      return Promise.all(ids.map(async (id) => (await store.resourceById(id)).locator));
    }
    const attachmentId = request.target.attachmentId;
    return source.attachments
      .filter((attachment) => !attachmentId || attachment.attachmentId === attachmentId)
      .map((attachment) =>
        NodePath.relative(root, sourceAttachmentAbsolutePath(root, attachment))
          .split(NodePath.sep)
          .join("/"),
      );
  }
  async function bound(request: AnnotationPrepareRequest | AnnotationMaterialRequest) {
    const store = await openStore(request.root);
    if (
      request.binding.workspaceBinding !== store.scope.workspaceBinding ||
      request.binding.generation !== store.scope.generation
    )
      throw new Error("The document context changed. Reopen it before saving.");
    return store;
  }
  async function document(
    request: AnnotationDocumentRequest | AnnotationPrepareRequest,
    prepare: boolean,
  ): Promise<AnnotationDocumentResult> {
    if (!(await enabled(request.root)))
      return {
        enabled: false,
        needsMigration: false,
        binding: null,
        resource: null,
        annotations: [],
      };
    const store = "binding" in request ? await bound(request) : await openStore(request.root);
    if (prepare) await migrateLegacyAnnotations(store);
    const needsMigration =
      (await store.importedRecords()) === null &&
      (await listScientSourceRecords(store.scope.root)).some(
        (source) => !!source.savedPassages?.length,
      );
    const resources = await Promise.all(
      (await locators(request, store)).map((locator) => store.resourceFor(locator, prepare)),
    );
    const ids = new Set(resources.flatMap((resource) => (resource ? [resource.resourceId] : [])));
    const resource = resources.length === 1 ? resources[0]! : null;
    return {
      enabled: true,
      needsMigration,
      binding: {
        workspaceBinding: store.scope.workspaceBinding,
        generation: store.scope.generation,
      },
      resource,
      annotations: ids.size
        ? (await store.list()).filter((record) => ids.has(record.region.resourceId))
        : [],
    };
  }
  async function mutate(request: AnnotationMutationRequest) {
    const store = await bound(request);
    const resources = await Promise.all(
      (await locators(request, store)).map((locator) => store.resourceFor(locator)),
    );
    const record =
      request.command.action === "create"
        ? null
        : (await store.history(request.command.annotationId)).at(-1)?.record;
    const requestedResourceId =
      request.command.action === "create" ? request.command.resourceId : record?.region.resourceId;
    const resource = resources.find((item) => item?.resourceId === requestedResourceId);
    if (!resource)
      throw new Error("This annotation target does not belong to the selected document.");
    if (request.command.action === "create") {
      if (request.command.resourceId !== resource.resourceId)
        throw new Error("The annotation target does not match this document.");
    } else {
      if (record && record.region.resourceId !== resource.resourceId)
        throw new Error("This annotation belongs to another document.");
    }
    return store.mutate(request.command, resource.locator);
  }
  async function material(request: AnnotationMaterialRequest) {
    const store = await bound(request);
    const absolutePath = await store.retainedMaterial(request.annotationId);
    const record = (await store.history(request.annotationId)).at(-1)!.record;
    return {
      workspaceRoot: store.scope.root,
      relativePath: NodePath.relative(store.scope.root, absolutePath).split(NodePath.sep).join("/"),
      resourceId: record.region.resourceId,
    };
  }
  return { document, mutate, material };
}
