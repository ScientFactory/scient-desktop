/**
 * Asset URLs for Scient's own resources: analysis artifacts, compute
 * outputs and retained generated documents. ws.ts hands these resources
 * here before resolving shared workspace assets.
 *
 * @module ScientAssetUrls
 */
import {
  AssetAnalysisArtifactNotFoundError,
  AssetAnalysisArtifactResolutionError,
  AssetComputeOutputNotFoundError,
  AssetComputeOutputResolutionError,
  AssetGeneratedDocumentAuthorityMismatchError,
  AssetGeneratedDocumentNotFoundError,
  AssetGeneratedDocumentResolutionError,
  type AssetResource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { issueAssetUrl } from "../assets/AssetAccess.ts";
import type * as AnalysisService from "./analysis/AnalysisService.ts";
import type * as ComputeSessionService from "./compute/ComputeSessionService.ts";
import type * as GeneratedDocumentStore from "./documentArtifacts/GeneratedDocumentStore.ts";

type ScientAssetResource = Extract<
  AssetResource,
  { readonly _tag: "analysis-artifact" | "compute-output" | "generated-document" }
>;

export const isScientAssetResource = (resource: AssetResource): resource is ScientAssetResource =>
  resource._tag === "analysis-artifact" ||
  resource._tag === "compute-output" ||
  resource._tag === "generated-document";

export const issueScientAssetUrl = (
  input: { readonly resource: ScientAssetResource },
  {
    analysis,
    compute,
    generatedDocuments,
  }: {
    readonly analysis: AnalysisService.AnalysisService["Service"];
    readonly compute: ComputeSessionService.ComputeSessionService["Service"];
    readonly generatedDocuments: GeneratedDocumentStore.GeneratedDocumentStore["Service"];
  },
) =>
  Effect.gen(function* () {
    if (input.resource._tag === "analysis-artifact") {
      const analysisArtifact = yield* analysis.resolveArtifact(input.resource).pipe(
        Effect.mapError(
          (cause) =>
            new AssetAnalysisArtifactResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      if (analysisArtifact === null) {
        return yield* new AssetAnalysisArtifactNotFoundError({
          resource: input.resource,
        });
      }
      return yield* issueAssetUrl({ resource: input.resource, analysisArtifact });
    }
    if (input.resource._tag === "compute-output") {
      const computeOutput = yield* compute.resolveOutputResource(input.resource).pipe(
        Effect.mapError(
          (cause) =>
            new AssetComputeOutputResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      // An image whose bytes are gone or no longer hash to what was
      // asked for is not an image: a session's transcript outlives
      // the files it points at, so this is an ordinary outcome
      // rather than a fault.
      if (computeOutput === null) {
        return yield* new AssetComputeOutputNotFoundError({
          resource: input.resource,
        });
      }
      return yield* issueAssetUrl({ resource: input.resource, computeOutput });
    }
    const retained = yield* generatedDocuments.resolveRevisionForAsset(input.resource).pipe(
      Effect.mapError((cause) => {
        if (cause.reason === "authority-mismatch") {
          return new AssetGeneratedDocumentAuthorityMismatchError({
            resource: input.resource,
          });
        }
        if (cause.reason === "missing-revision") {
          return new AssetGeneratedDocumentNotFoundError({
            resource: input.resource,
          });
        }
        return new AssetGeneratedDocumentResolutionError({
          resource: input.resource,
          cause,
        });
      }),
    );
    return yield* issueAssetUrl({
      resource: input.resource,
      generatedDocument: retained.document,
      generatedDocumentExpiresAtEpochMs: retained.expiresAtEpochMs,
    });
  });
