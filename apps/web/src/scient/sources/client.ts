import {
  advanceEnvironmentZoteroImport,
  beginEnvironmentZoteroImport,
  cancelEnvironmentZoteroImport,
  getEnvironmentScientSourcesOverview,
  getEnvironmentZoteroStatus,
  listEnvironmentZoteroLibrary,
  preflightEnvironmentZoteroImport,
} from "@t3tools/client-runtime/state/scient-sources";
import type { EnvironmentId } from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";
import { SCIENT_UX_LAB_ENABLED } from "../uxLab/state";
import * as labClient from "../uxLab/zoteroSourcesFixtures";

const sourcesLabEnabled = SCIENT_UX_LAB_ENABLED;

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

export function readScientSources(environmentId: EnvironmentId, root: string) {
  if (sourcesLabEnabled) return labClient.readScientSources(root);
  return runtime.runPromise(
    getEnvironmentScientSourcesOverview({ prepared: prepared(environmentId), root }),
  );
}

export function readZoteroStatus(environmentId: EnvironmentId) {
  if (sourcesLabEnabled) return labClient.readZoteroStatus();
  return runtime.runPromise(getEnvironmentZoteroStatus(prepared(environmentId)));
}

export function readZoteroLibrary(
  environmentId: EnvironmentId,
  input: { readonly query: string; readonly start: number; readonly limit: number },
) {
  if (sourcesLabEnabled) return labClient.readZoteroLibrary(input);
  return runtime.runPromise(
    listEnvironmentZoteroLibrary({ prepared: prepared(environmentId), ...input }),
  );
}

export function preflightZoteroItems(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly itemKeys: ReadonlyArray<string> },
) {
  if (sourcesLabEnabled) return labClient.preflightZoteroItems(input);
  return runtime.runPromise(
    preflightEnvironmentZoteroImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function beginZoteroItemsImport(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly itemKeys: ReadonlyArray<string>;
  },
) {
  if (sourcesLabEnabled) return labClient.beginZoteroItemsImport(input);
  return runtime.runPromise(
    beginEnvironmentZoteroImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function advanceZoteroItemsImport(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly operationId: string },
) {
  if (sourcesLabEnabled) return labClient.advanceZoteroItemsImport(input);
  return runtime.runPromise(
    advanceEnvironmentZoteroImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function cancelZoteroItemsImport(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly operationId: string },
) {
  if (sourcesLabEnabled) return labClient.cancelZoteroItemsImport(input);
  return runtime.runPromise(
    cancelEnvironmentZoteroImport({ prepared: prepared(environmentId), ...input }),
  );
}
