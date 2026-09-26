/**
 * Revision-attached permission for direct editing of one immutable LaTeX PDF.
 *
 * The encoded manifest is handed to GeneratedDocumentStore before publication
 * and written inside the same staged revision directory as the PDF. The PDF,
 * metadata, and this proof therefore become visible together and share the
 * store's retention lifecycle; there is no second durability window or orphan
 * cleanup policy to coordinate.
 */
import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
} from "@scientfactory/document-artifacts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  GeneratedDocumentStore,
  MAX_REVISION_ATTACHMENT_BYTES,
  type GeneratedDocumentRevisionAttachment,
} from "../documentArtifacts/GeneratedDocumentStore.ts";

const LATEX_VISUAL_REVISION_ATTACHMENT = "latex-visual-revision.json";

const SourceRevision = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u));

const LatexVisualRevisionManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workspaceRoot: Schema.String,
  rootRelativePath: Schema.String,
  sourceRevisions: Schema.Record(Schema.String, SourceRevision),
});
type LatexVisualRevisionManifest = typeof LatexVisualRevisionManifest.Type;

const ManifestJson = Schema.fromJsonString(LatexVisualRevisionManifest);
const encodeManifest = Schema.encodeEffect(ManifestJson);
const decodeManifest = Schema.decodeUnknownOption(ManifestJson);

export interface LatexVisualRevisionRef {
  readonly artifactId: ArtifactId;
  readonly revisionId: ArtifactRevisionId;
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
}

export interface PrepareLatexVisualRevisionInput {
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
  readonly sourceRevisions: Readonly<Record<string, string>>;
}

export class LatexVisualRevisionStore extends Context.Service<
  LatexVisualRevisionStore,
  {
    /** `null` leaves the PDF publishable but deliberately read-only in Visual. */
    readonly prepare: (
      input: PrepareLatexVisualRevisionInput,
    ) => Effect.Effect<GeneratedDocumentRevisionAttachment | null, Schema.SchemaError>;
    /** `null` is the only answer for missing, corrupt, evicted, or mismatched evidence. */
    readonly load: (
      input: LatexVisualRevisionRef,
    ) => Effect.Effect<Readonly<Record<string, string>> | null>;
  }
>()("t3/scient/latex/LatexVisualRevisionStore") {}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const store = yield* GeneratedDocumentStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const authority = ArtifactAuthority.make(yield* environment.getEnvironmentId);

  const prepare = Effect.fnUntraced(function* (input: PrepareLatexVisualRevisionInput) {
    const manifest: LatexVisualRevisionManifest = {
      schemaVersion: 1,
      workspaceRoot: path.resolve(input.workspaceRoot),
      rootRelativePath: normalizeRelativePath(input.rootRelativePath),
      sourceRevisions: input.sourceRevisions,
    };
    const encoded = yield* encodeManifest(manifest);
    const bytes = new TextEncoder().encode(`${encoded}\n`);
    // Visual evidence is optional authorization, never a reason to reject a
    // valid PDF. Refuse it here, before the document store's aggregate
    // attachment validator would reject the entire immutable publication.
    if (bytes.byteLength > MAX_REVISION_ATTACHMENT_BYTES) return null;
    return {
      name: LATEX_VISUAL_REVISION_ATTACHMENT,
      bytes,
    };
  });

  const load = Effect.fnUntraced(function* (input: LatexVisualRevisionRef) {
    const bytes = yield* store
      .readRevisionAttachment({
        authority,
        artifactId: input.artifactId,
        revisionId: input.revisionId,
        name: LATEX_VISUAL_REVISION_ATTACHMENT,
      })
      .pipe(Effect.option);
    if (Option.isNone(bytes) || bytes.value === null) return null;
    const decoded = decodeManifest(new TextDecoder().decode(bytes.value));
    if (Option.isNone(decoded)) return null;
    const manifest = decoded.value;
    if (
      path.resolve(manifest.workspaceRoot) !== path.resolve(input.workspaceRoot) ||
      manifest.rootRelativePath !== normalizeRelativePath(input.rootRelativePath)
    )
      return null;
    return manifest.sourceRevisions;
  });

  return LatexVisualRevisionStore.of({ prepare, load });
});

export const layer = Layer.effect(LatexVisualRevisionStore, make);
