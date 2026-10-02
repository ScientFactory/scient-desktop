// @effect-diagnostics nodeBuiltinImport:off -- Native CI qualification runs the downloaded executable from an isolated temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { makeOmpExecutableGate, OmpExecutableGate } from "../src/provider/omp/OmpExecutableGate.ts";
import { qualifyManagedScientAgentRuntime } from "../src/scient/providerLifecycle/ScientAgentManagedRuntimeActions.ts";

/**
 * Runs the app's managed-activation check against an installed Scient Agent
 * executable: the RPC v2 handshake, the reported version, and `get_state`, in
 * an isolated home with no session, tools, extensions, skills or rules. The
 * managed-runtime catalog qualification calls this before a release can be
 * published, so a binary that only answers `--version` never reaches clients.
 *
 *   node apps/server/scripts/qualifyScientAgentManagedRuntime.ts --binary <path> --version <x.y.z>
 */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const binary = argument("--binary");
const version = argument("--version");
if (!binary || !version) throw new Error("--binary and --version are required.");

const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
const cwd = await NodeFSP.mkdtemp(
  NodePath.join(NodeOS.tmpdir(), "scient-agent-rpc-qualification-"),
);
try {
  await Effect.runPromise(
    qualifyManagedScientAgentRuntime({
      executablePath: NodePath.resolve(binary),
      expectedVersion: version,
      cwd,
      environment: process.env,
      activations: [],
    }).pipe(
      Effect.provideServiceEffect(OmpExecutableGate, makeOmpExecutableGate()),
      Effect.provide(NodeServices.layer),
    ),
    { signal: cancellation.signal },
  );
  process.stdout.write(`Scient Agent ${version} passed the RPC v2 handshake and get_state.\n`);
} finally {
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
  await NodeFSP.rm(cwd, { recursive: true, force: true });
}
