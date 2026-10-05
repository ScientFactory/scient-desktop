/**
 * Signed-claim shapes for Scient's asset kinds: generated documents, analysis
 * artifacts, compute outputs and environment files. AssetAccess decodes them
 * as part of its claims union, in this order.
 */
import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
} from "@scientfactory/document-artifacts";
import { AnalysisArtifactResourceRef } from "@scientfactory/analysis";
import { ComputeOutputResourceRef } from "@scientfactory/compute";
import * as Schema from "effect/Schema";

export const ScientAssetClaimsSchemas = [
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("generated-document"),
    authority: ArtifactAuthority,
    artifactId: ArtifactId,
    revisionId: ArtifactRevisionId,
    path: Schema.String,
    fileName: Schema.String,
    expiresAt: Schema.Number,
    revisionSize: Schema.Number,
    revisionMtimeMs: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("analysis-artifact"),
    ...AnalysisArtifactResourceRef.fields,
    path: Schema.String,
    fileName: Schema.String,
    expiresAt: Schema.Number,
    revisionSize: Schema.Number,
    revisionMtimeMs: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("compute-output"),
    ...ComputeOutputResourceRef.fields,
    path: Schema.String,
    fileName: Schema.String,
    expiresAt: Schema.Number,
    revisionSize: Schema.Number,
    revisionMtimeMs: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("environment-file-exact"),
    path: Schema.String,
    fileName: Schema.String,
    expiresAt: Schema.Number,
    revisionSize: Schema.Number,
    revisionMtimeMs: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("environment-html-document"),
    baseDirectory: Schema.String,
    entryFileName: Schema.String,
    expiresAt: Schema.Number,
  }),
] as const;

export type ScientAssetClaims = (typeof ScientAssetClaimsSchemas)[number]["Type"];
