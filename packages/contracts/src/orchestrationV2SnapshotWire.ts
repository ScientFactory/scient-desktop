import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { NonNegativeInt } from "./baseSchemas.ts";
import {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "./orchestrationV2.ts";

/** Explicit HTTP negotiation; existing clients and servers keep the full shape. */
export const THREAD_SNAPSHOT_FORMAT_HEADER = "x-scient-thread-snapshot-format";
export const COMPACT_THREAD_SNAPSHOT_FORMAT = "item-refs-v1";

const ItemReference = Schema.Struct({
  position: OrchestrationV2ProjectedTurnItem.fields.position,
  visibility: OrchestrationV2ProjectedTurnItem.fields.visibility,
  sourceThreadId: OrchestrationV2ProjectedTurnItem.fields.sourceThreadId,
  sourceItemId: OrchestrationV2ProjectedTurnItem.fields.sourceItemId,
  itemIndex: NonNegativeInt,
});
const CompactProjection = Schema.Struct({
  ...OrchestrationV2ThreadProjection.fields,
  visibleTurnItems: Schema.Array(Schema.Union([OrchestrationV2ProjectedTurnItem, ItemReference])),
}).check(
  Schema.makeFilter(
    (projection) =>
      projection.visibleTurnItems.every(
        (row) => !("itemIndex" in row) || row.itemIndex < projection.turnItems.length,
      ) || "A visible item reference must address this snapshot's canonical items.",
  ),
);

const encodeItem = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2TurnItem)),
);

/** Reference only byte-equivalent canonical records; other versions stay inline. */
function compactProjection(
  projection: OrchestrationV2ThreadProjection,
): typeof CompactProjection.Type {
  const indices = new Map(projection.turnItems.map((item, index) => [item.id, index]));
  const fingerprints = new Map<number, string>();
  return {
    ...projection,
    visibleTurnItems: projection.visibleTurnItems.map((row) => {
      const index = indices.get(row.item.id);
      if (index === undefined) return row;
      const canonical = projection.turnItems[index];
      if (canonical === undefined) return row;
      let fingerprint = fingerprints.get(index);
      if (fingerprint === undefined) {
        fingerprint = encodeItem(canonical);
        fingerprints.set(index, fingerprint);
      }
      if (encodeItem(row.item) !== fingerprint) return row;
      return {
        position: row.position,
        visibility: row.visibility,
        sourceThreadId: row.sourceThreadId,
        sourceItemId: row.sourceItemId,
        itemIndex: index,
      };
    }),
  };
}

/** Decode restores the exact public projection, including order and all three arrays. */
export const OrchestrationV2CompactThreadProjection = CompactProjection.pipe(
  Schema.decodeTo(Schema.toType(OrchestrationV2ThreadProjection), {
    decode: SchemaGetter.transform((projection) => ({
      ...projection,
      visibleTurnItems: projection.visibleTurnItems.map((row) => {
        if (!("itemIndex" in row)) return row;
        const item = projection.turnItems[row.itemIndex];
        // The input refinement runs before expansion; this is also a guard
        // against unchecked callers passing a forged decoded value.
        if (item === undefined) throw new RangeError("Invalid compact snapshot item reference");
        return {
          position: row.position,
          visibility: row.visibility,
          sourceThreadId: row.sourceThreadId,
          sourceItemId: row.sourceItemId,
          item,
        };
      }),
    })),
    encode: SchemaGetter.transform(compactProjection),
  }),
);

const CompactThreadDetailSnapshot = Schema.Struct({
  ...OrchestrationV2ThreadDetailSnapshot.fields,
  snapshotFormat: Schema.Literal(COMPACT_THREAD_SNAPSHOT_FORMAT),
  projection: OrchestrationV2CompactThreadProjection,
});
const CompactThreadBoundedSnapshot = Schema.Struct({
  ...OrchestrationV2ThreadBoundedSnapshot.fields,
  snapshotFormat: Schema.Literal(COMPACT_THREAD_SNAPSHOT_FORMAT),
  projection: OrchestrationV2CompactThreadProjection,
});

// Compact comes first: its explicit marker selects compact encoding. A full
// unmarked response remains valid for new clients talking to older servers.
export const OrchestrationV2HttpThreadDetailSnapshot = Schema.Union([
  CompactThreadDetailSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
]);
export const OrchestrationV2HttpThreadBoundedSnapshot = Schema.Union([
  CompactThreadBoundedSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
]);
