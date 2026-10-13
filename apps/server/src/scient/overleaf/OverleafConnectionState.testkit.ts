import type { OverleafConnectionDocument } from "./OverleafConnectionState.ts";

/** A valid freshly connected document: empty base, no attempts, no pending apply. */
export const overleafConnectionFixture = (
  connectionId = "connection-1",
): OverleafConnectionDocument => ({
  schemaVersion: 1,
  connectionId,
  revision: 1,
  environmentId: "environment-1",
  binding: { bindingId: "binding-1", authorityGeneration: 1, scopeRevision: 1 },
  checkout: { canonicalRoot: "/workspace", identity: { dev: "1", ino: "2" } },
  folder: { relativePath: "paper", identity: { dev: "1", ino: "3" } },
  remote: { host: "www.overleaf.com", projectId: "0123456789abcdef01234567", branch: "main" },
  mode: "manual",
  state: "active",
  base: { commit: null, tree: null, generation: 0 },
  priorBases: [],
  localSnapshots: [],
  managedPaths: [],
  localOnlyPaths: [],
  attentionPaths: [],
  retention: { vaultIdentity: { dev: "1", ino: "4" }, copies: [] },
  activeApply: null,
  lastAttemptNumber: 0,
  attempts: [],
  createdAt: "2026-10-13T10:00:00.000Z",
  updatedAt: "2026-10-13T10:00:00.000Z",
});
