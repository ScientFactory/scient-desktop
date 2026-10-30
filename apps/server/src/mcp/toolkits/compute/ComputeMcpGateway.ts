import type { ComputeOperationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as ScientificRuntimePreferences from "../../../scient/compute/ScientificRuntimePreferences.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  makeComputeRpcGateway,
  type ComputeRpcGateway,
} from "../../../scient/compute/ComputeRpcGateway.ts";
import * as ComputeSessionService from "../../../scient/compute/ComputeSessionService.ts";
import type { ComputeOutputResourceRef } from "@scientfactory/compute";

export interface ComputeOutputBytes {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** The same project-scoped operations the app uses, so agent and user share sessions. */
export interface ComputeMcpGatewayShape extends ComputeRpcGateway {
  /** Bytes of a stored figure or resource, for returning figures to the agent. */
  readonly readOutput: (
    ref: ComputeOutputResourceRef,
    kind: "image" | "resource",
  ) => Effect.Effect<ComputeOutputBytes | null, ComputeOperationError>;
}

export class ComputeMcpGateway extends Context.Service<ComputeMcpGateway, ComputeMcpGatewayShape>()(
  "t3/mcp/toolkits/compute/ComputeMcpGateway",
) {}

export const ComputeMcpGatewayLive = Layer.effect(
  ComputeMcpGateway,
  Effect.gen(function* () {
    const compute = yield* ComputeSessionService.ComputeSessionService;
    const fileSystem = yield* FileSystem.FileSystem;
    const rpc = makeComputeRpcGateway({
      compute,
      workspaceResolver: yield* WorkspaceBindingResolver,
      serverSettings: yield* ScientificRuntimePreferences.ScientificRuntimePreferences,
      workspaceFileSystem: yield* WorkspaceFileSystem.WorkspaceFileSystem,
    });
    const readOutput = Effect.fn("ComputeMcpGateway.readOutput")(function* (
      ref: ComputeOutputResourceRef,
      kind: "image" | "resource",
    ) {
      const resolved =
        kind === "image"
          ? yield* compute.resolveOutputImage(ref)
          : yield* compute.resolveOutputResource(ref);
      if (resolved === null) return null;
      const bytes = yield* fileSystem.readFile(resolved.path).pipe(Effect.option);
      return Option.isSome(bytes) ? { mediaType: resolved.mediaType, bytes: bytes.value } : null;
    });
    return ComputeMcpGateway.of({ ...rpc, readOutput });
  }),
);
