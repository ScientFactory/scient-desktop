import {
  getEnvironmentDocumentAnnotations,
  getEnvironmentSourceAnnotations,
} from "@t3tools/client-runtime/state/scient-annotations";
import type {
  EnvironmentId,
  ScientAnnotationMutationRequest,
  ScientAnnotationsDocumentRequest,
  ScientAnnotationsSourceRequest,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";
import { runSourcesCommand, sourcesCommands } from "../sources/sourcesCommands";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

// Async, so a disconnected environment rejects instead of throwing in a caller's effect.
export async function readDocumentAnnotations(
  environmentId: EnvironmentId,
  request: ScientAnnotationsDocumentRequest,
) {
  return runtime.runPromise(
    getEnvironmentDocumentAnnotations({ prepared: prepared(environmentId), request }),
  );
}

export async function readSourceAnnotations(
  environmentId: EnvironmentId,
  request: ScientAnnotationsSourceRequest,
) {
  return runtime.runPromise(
    getEnvironmentSourceAnnotations({ prepared: prepared(environmentId), request }),
  );
}

export async function mutateAnnotation(
  environmentId: EnvironmentId,
  request: ScientAnnotationMutationRequest,
) {
  return runSourcesCommand(sourcesCommands.annotationsMutate, environmentId, { request });
}
