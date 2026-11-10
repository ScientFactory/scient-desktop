// @effect-diagnostics nodeBuiltinImport:off -- Preserve legacy provenance with the host-owned Source adapter.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { AnnotationRecord } from "@scientfactory/annotations";
import type { openAnnotationStore } from "@scientfactory/annotations/store";
import {
  readScientAnnotationMigrationSnapshots,
  retireScientEmbeddedPassages,
  sourceAttachmentAbsolutePath,
} from "@scientfactory/scient-sources/store";

export async function migrateLegacyAnnotations(
  store: Awaited<ReturnType<typeof openAnnotationStore>>,
) {
  const { records: sources, snapshots } = await readScientAnnotationMigrationSnapshots(
    store.scope.root,
  );
  const imported = await store.importedRecords();
  if (imported === null) {
    const records: AnnotationRecord[] = [];
    for (const source of sources) {
      const sourceSnapshot = snapshots.find((s) => s.sourceId === source.sourceId)!;
      const sourceSnapshotHash = NodeCrypto.createHash("sha256")
        .update(sourceSnapshot.content)
        .digest("hex");
      for (const passage of source.savedPassages ?? []) {
        const attachment = source.attachments.find((a) => a.attachmentId === passage.attachmentId);
        if (!attachment)
          throw new Error(
            "A legacy annotation has no PDF attachment. Migration stopped; originals were kept.",
          );
        const locator = NodePath.relative(
          store.scope.root,
          sourceAttachmentAbsolutePath(store.scope.root, attachment),
        )
          .split(NodePath.sep)
          .join("/");
        const resource = (await store.resourceFor(locator, true))!;
        records.push({
          formatVersion: 1,
          annotationId: passage.passageId,
          revision: passage.revision,
          bodyFormat: "plain-text",
          owner: { kind: "project", projectId: store.scope.projectId },
          region: {
            regionId: NodeCrypto.randomUUID(),
            resourceId: resource.resourceId,
            capture: passage.capture,
          },
          note: passage.note,
          highlighted: passage.highlighted ?? passage.note.length === 0,
          correctedText: null,
          // Legacy actor="user" is not an authenticated historical identity.
          authorship: { kind: "imported", principal: "legacy-user-identity-unavailable" },
          review: { state: "imported", principal: "legacy-review-identity-unavailable" },
          importedFrom: {
            sourceId: source.sourceId,
            attachmentId: passage.attachmentId,
            sourceSnapshotHash,
            legacyRevision: passage.revision,
          },
          createdAt: passage.createdAt,
          updatedAt: passage.updatedAt,
          deletedAt: passage.deletedAt,
        });
      }
    }
    await store.importLegacy({ snapshots, records });
  }
  const baseline = await store.importedRecords();
  for (const source of sources) {
    if (source.formatVersion !== 2 && !source.savedPassages) continue;
    const complete = (source.savedPassages ?? []).every((passage) =>
      baseline?.some((commit) => {
        const record = commit.record;
        return (
          record.annotationId === passage.passageId &&
          record.importedFrom?.sourceId === source.sourceId &&
          record.importedFrom?.attachmentId === passage.attachmentId &&
          record.revision === passage.revision &&
          record.note === passage.note &&
          record.deletedAt === passage.deletedAt &&
          record.highlighted === (passage.highlighted ?? passage.note.length === 0) &&
          JSON.stringify(record.region.capture) === JSON.stringify(passage.capture)
        );
      }),
    );
    if (!complete)
      throw new Error("Legacy annotations changed after import. Originals were kept for review.");
    await retireScientEmbeddedPassages({
      root: store.scope.root,
      sourceId: source.sourceId,
      expectedPassages: source.savedPassages ?? [],
      publish: store.publish,
    });
  }
}
