import {
  checkEnvironmentReferences,
  listEnvironmentReferenceDocuments,
} from "@t3tools/client-runtime/state/scient-references";
import type {
  EnvironmentId,
  ScientReferenceCheckRequest,
  ScientReferenceResolveRequest,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";
import { runSourcesCommand, sourcesCommands } from "../sources/sourcesCommands";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

export function readReferenceDocuments(environmentId: EnvironmentId, root: string) {
  return runtime.runPromise(
    listEnvironmentReferenceDocuments({ prepared: prepared(environmentId), root }),
  );
}

export function checkReferences(environmentId: EnvironmentId, input: ScientReferenceCheckRequest) {
  return runtime.runPromise(
    checkEnvironmentReferences({ prepared: prepared(environmentId), ...input }),
  );
}

export function resolveReferences(
  environmentId: EnvironmentId,
  input: ScientReferenceResolveRequest,
) {
  return runSourcesCommand(sourcesCommands.referencesResolve, environmentId, input);
}
