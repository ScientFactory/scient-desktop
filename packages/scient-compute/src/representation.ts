import * as Schema from "effect/Schema";

import { ByteLength, ContentHash, Count, ObservedAt, Sequence } from "./primitives.ts";

export const MAXIMUM_COMPUTE_REPRESENTATIONS_PER_BUNDLE = 32;
export const MAXIMUM_COMPUTE_INLINE_REPRESENTATION_BYTES = 1024 * 1024;
export const MAXIMUM_COMPUTE_REPRESENTATION_METADATA_BYTES = 256 * 1024;
export const MAXIMUM_COMPUTE_REPRESENTATION_BUNDLE_BYTES = 8 * 1024 * 1024;

const utf8 = new TextEncoder();

const utf8Bound = (maximum: number) =>
  Schema.makeFilter((value: string) =>
    utf8.encode(value).byteLength <= maximum ? true : `Expected at most ${maximum} UTF-8 bytes.`,
  );

const validJson = Schema.makeFilter((value: string) => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return "Expected valid JSON.";
  }
});

const validJsonObject = Schema.makeFilter((value: string) => {
  try {
    const decoded: unknown = JSON.parse(value);
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? true
      : "Expected a JSON object.";
  } catch {
    return "Expected a JSON object.";
  }
});

/** Canonical MIME key used by a representation bundle and renderer registry. */
export const ComputeMediaType = Schema.NonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
);
export type ComputeMediaType = typeof ComputeMediaType.Type;

const InlineRepresentationText = Schema.String.check(
  Schema.isMaxLength(MAXIMUM_COMPUTE_INLINE_REPRESENTATION_BYTES),
  utf8Bound(MAXIMUM_COMPUTE_INLINE_REPRESENTATION_BYTES),
);

const InlineRepresentationJson = InlineRepresentationText.check(validJson);

const RepresentationMetadataJson = Schema.String.check(
  Schema.isMaxLength(MAXIMUM_COMPUTE_REPRESENTATION_METADATA_BYTES),
  utf8Bound(MAXIMUM_COMPUTE_REPRESENTATION_METADATA_BYTES),
  validJsonObject,
);

/**
 * One independently renderable form of the same scientific result.
 *
 * Text and JSON stay inline only while individually bounded. Binary and large
 * representations are content-addressed resources, so durable transcript JSON
 * never becomes a binary transport or a second artifact store. JSON remains an
 * encoded string so its exact bytes are preserved and bounded before a
 * renderer performs format-specific validation.
 */
export const ComputeRepresentation = Schema.Struct({
  mediaType: ComputeMediaType,
  data: Schema.Union([
    Schema.TaggedStruct("text", { text: InlineRepresentationText }),
    Schema.TaggedStruct("json", { json: InlineRepresentationJson }),
    Schema.TaggedStruct("resource", {
      contentHash: ContentHash,
      byteLength: ByteLength.check(
        Schema.isLessThanOrEqualTo(MAXIMUM_COMPUTE_REPRESENTATION_BUNDLE_BYTES),
      ),
    }),
  ]),
});
export type ComputeRepresentation = typeof ComputeRepresentation.Type;

export function computeRepresentationByteLength(representation: ComputeRepresentation): number {
  switch (representation.data._tag) {
    case "text":
      return utf8.encode(representation.data.text).byteLength;
    case "json":
      return utf8.encode(representation.data.json).byteLength;
    case "resource":
      return representation.data.byteLength;
  }
}

function computeBundlePayloadByteLength(bundle: {
  readonly representations: ReadonlyArray<ComputeRepresentation>;
  readonly metadataJson: string | null;
}): number {
  return (
    bundle.representations.reduce(
      (total, representation) => total + computeRepresentationByteLength(representation),
      0,
    ) + (bundle.metadataJson === null ? 0 : utf8.encode(bundle.metadataJson).byteLength)
  );
}

const RepresentationList = Schema.Array(ComputeRepresentation).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAXIMUM_COMPUTE_REPRESENTATIONS_PER_BUNDLE),
  Schema.makeFilter((representations) => {
    const mediaTypes = new Set<string>();
    for (const representation of representations) {
      if (mediaTypes.has(representation.mediaType)) {
        return `Duplicate representation media type: ${representation.mediaType}.`;
      }
      mediaTypes.add(representation.mediaType);
    }
    return true;
  }),
);

/** A bounded Jupyter-compatible MIME bundle without adopting Jupyter authority. */
export const ComputeRepresentationBundle = Schema.Struct({
  representations: RepresentationList,
  metadataJson: Schema.NullOr(RepresentationMetadataJson),
}).check(
  Schema.makeFilter((bundle) =>
    computeBundlePayloadByteLength(bundle) <= MAXIMUM_COMPUTE_REPRESENTATION_BUNDLE_BYTES
      ? true
      : `Representation bundle exceeded ${MAXIMUM_COMPUTE_REPRESENTATION_BUNDLE_BYTES} bytes.`,
  ),
);
export type ComputeRepresentationBundle = typeof ComputeRepresentationBundle.Type;

export function computeRepresentationBundleByteLength(bundle: ComputeRepresentationBundle): number {
  return computeBundlePayloadByteLength(bundle);
}

export function sameComputeRepresentationBundle(
  left: ComputeRepresentationBundle,
  right: ComputeRepresentationBundle,
): boolean {
  if (
    left.metadataJson !== right.metadataJson ||
    left.representations.length !== right.representations.length
  ) {
    return false;
  }
  const rightByMediaType = new Map(
    right.representations.map((representation) => [representation.mediaType, representation]),
  );
  return left.representations.every((representation) => {
    const candidate = rightByMediaType.get(representation.mediaType);
    if (
      candidate === undefined ||
      representation.mediaType !== candidate.mediaType ||
      representation.data._tag !== candidate.data._tag
    ) {
      return false;
    }
    switch (representation.data._tag) {
      case "text":
        return candidate.data._tag === "text" && representation.data.text === candidate.data.text;
      case "json":
        return candidate.data._tag === "json" && representation.data.json === candidate.data.json;
      case "resource":
        return (
          candidate.data._tag === "resource" &&
          representation.data.contentHash === candidate.data.contentHash &&
          representation.data.byteLength === candidate.data.byteLength
        );
    }
  });
}

export const ComputeDisplayId = Schema.NonEmptyString.check(Schema.isMaxLength(256));
export type ComputeDisplayId = typeof ComputeDisplayId.Type;

const DisplayEnvelope = {
  sequence: Sequence,
  observedAt: ObservedAt,
} as const;

/** Append-only display facts. Projection, not mutation, creates the visible output area. */
export const ComputeDisplayOutput = Schema.Union([
  Schema.TaggedStruct("display-data", {
    ...DisplayEnvelope,
    bundle: ComputeRepresentationBundle,
    displayId: Schema.NullOr(ComputeDisplayId),
  }),
  Schema.TaggedStruct("execute-result", {
    ...DisplayEnvelope,
    bundle: ComputeRepresentationBundle,
    executionCount: Schema.NullOr(Count),
  }),
  Schema.TaggedStruct("display-update", {
    ...DisplayEnvelope,
    bundle: ComputeRepresentationBundle,
    displayId: ComputeDisplayId,
  }),
  Schema.TaggedStruct("clear-output", {
    ...DisplayEnvelope,
    wait: Schema.Boolean,
  }),
]);
export type ComputeDisplayOutput = typeof ComputeDisplayOutput.Type;

export type ComputeRepresentationSelection =
  | { readonly _tag: "supported"; readonly representation: ComputeRepresentation }
  | { readonly _tag: "unsupported"; readonly availableMediaTypes: ReadonlyArray<ComputeMediaType> };

/**
 * Selects the first representation supported by a caller-owned renderer list.
 * No global registry or hidden fallback decides that active HTML is safer than
 * a static image; each product surface supplies its reviewed priority order.
 */
export function selectComputeRepresentation(
  bundle: ComputeRepresentationBundle,
  supportedMediaTypes: ReadonlyArray<string>,
): ComputeRepresentationSelection {
  const byMediaType = new Map(
    bundle.representations.map((representation) => [representation.mediaType, representation]),
  );
  for (const mediaType of supportedMediaTypes) {
    const representation = byMediaType.get(mediaType);
    if (representation !== undefined) return { _tag: "supported", representation };
  }
  return {
    _tag: "unsupported",
    availableMediaTypes: bundle.representations.map(({ mediaType }) => mediaType),
  };
}
