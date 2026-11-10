import {
  openEnvironmentAnnotations,
  prepareEnvironmentAnnotations,
  mutateEnvironmentAnnotation,
  getEnvironmentAnnotationMaterial,
} from "@t3tools/client-runtime/state/scient-annotations";
import type {
  EnvironmentId,
  AnnotationDocumentRequest,
  AnnotationPrepareRequest,
  AnnotationMutationRequest,
  AnnotationMaterialRequest,
} from "@t3tools/contracts";
import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

function prepared(environmentId: EnvironmentId) {
  const value = readPreparedConnection(environmentId);
  if (!value) throw new Error("This environment is not connected.");
  return value;
}
export const openAnnotations = (environmentId: EnvironmentId, input: AnnotationDocumentRequest) =>
  runtime.runPromise(openEnvironmentAnnotations({ prepared: prepared(environmentId), ...input }));
export const prepareAnnotations = (environmentId: EnvironmentId, input: AnnotationPrepareRequest) =>
  runtime.runPromise(
    prepareEnvironmentAnnotations({ prepared: prepared(environmentId), ...input }),
  );
export const mutateAnnotation = (environmentId: EnvironmentId, input: AnnotationMutationRequest) =>
  runtime.runPromise(mutateEnvironmentAnnotation({ prepared: prepared(environmentId), ...input }));
export const annotationMaterial = (
  environmentId: EnvironmentId,
  input: AnnotationMaterialRequest,
) =>
  runtime.runPromise(
    getEnvironmentAnnotationMaterial({ prepared: prepared(environmentId), ...input }),
  );
