// @effect-diagnostics nodeBuiltinImport:off -- Native CI qualification runs the downloaded executable from an isolated temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { makeOmpExecutableGate, OmpExecutableGate } from "../src/provider/omp/OmpExecutableGate.ts";
import { qualifyManagedOmpRuntime } from "../src/scient/providerLifecycle/OmpManagedRuntimeActions.ts";

/**
 * Qualification must complete RPC v2 handshake, version, and get_state in an isolated home;
 * --version alone cannot qualify a release binary.
 */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const binary = argument("--binary");
const version = argument("--version");
if (!binary || !version) throw new Error("--binary and --version are required.");

const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-omp-rpc-qualification-"));
try {
  await Effect.runPromise(
    qualifyManagedOmpRuntime({
      executablePath: NodePath.resolve(binary),
      expectedVersion: version,
      cwd,
      environment: process.env,
      activations: [],
    }).pipe(
      Effect.provideServiceEffect(OmpExecutableGate, makeOmpExecutableGate()),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.stdout.write(`Oh My Pi ${version} passed the RPC v2 handshake and get_state.\n`);
} finally {
  await NodeFSP.rm(cwd, { recursive: true, force: true });
}
