import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";

/**
 * Treats every folder as a known workspace, for Scient suites that write into a temporary
 * root no project registers. `WorkspaceFileSystem.test.ts` covers the rejection itself.
 */
export const layerKnownWorkspacesAllowAll = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
  contains: () => Effect.succeed(true),
  assertContains: () => Effect.void,
});
