// @effect-diagnostics nodeBuiltinImport:off
/**
 * Shared opt-in settings for the live Oh My Pi suites. Each suite runs only
 * when its variables are set, so CI reports it as skipped rather than passed:
 *
 * - `OMP_QUALIFY_BINARY`: the `omp` executable to qualify.
 * - `OMP_QUALIFY_FULL_TURN=1`: also run a turn against a real model.
 * - `OMP_QUALIFY_MODEL`: that model, as `<provider>/<model>` (default a local
 *   Ollama model, so no paid provider is contacted).
 * - `OMP_QUALIFY_MANAGED=1`: download and qualify the managed runtime.
 * - `OMP_QUALIFY_TARGET=scient`: `OMP_QUALIFY_BINARY` is a `scient-agent`
 *   executable. The same suites then qualify Scient Agent, which must do
 *   everything Oh My Pi does here.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { scientAgentProcessEnvironment, scientAgentTarget } from "../scient/ScientAgentTarget.ts";
import { ompProcessEnvironment } from "./OmpEnvironment.ts";
import { ompTarget, type OmpTarget } from "./OmpTarget.ts";

export const ompQualifyBinary = process.env.OMP_QUALIFY_BINARY || undefined;
export const ompQualifyFullTurn = process.env.OMP_QUALIFY_FULL_TURN === "1";
export const ompQualifyModel = process.env.OMP_QUALIFY_MODEL || "ollama/gemma4:12b-it-qat";
export const ompQualifyManaged = process.env.OMP_QUALIFY_MANAGED === "1";
/** The product `OMP_QUALIFY_BINARY` is. */
export const ompQualifyTarget: OmpTarget =
  process.env.OMP_QUALIFY_TARGET === "scient" ? scientAgentTarget : ompTarget;
const qualifiesScientAgent = ompQualifyTarget === scientAgentTarget;
/** A variable the product's own process always carries, naming where its state is. */
export const ompQualifyStateVariable = qualifiesScientAgent
  ? "SCIENT_AGENT_ROOT"
  : ompTarget.environment.agentDir;
/**
 * Scient's own internals, which must never reach the agent or its shell: a
 * variable name, and an assignment anywhere in a process's environment.
 * Scient Agent's state variables share the `SCIENT_` prefix and are its own.
 */
export const scientInternalName = qualifiesScientAgent
  ? /^(?:SCIENT_(?!AGENT_)|T3CODE_)/u
  : /^(?:SCIENT_|T3CODE_)/u;
export const scientInternalAssignment = qualifiesScientAgent
  ? /\b(?:SCIENT_(?!AGENT_)|T3CODE_)[A-Z_]*=/u
  : /\b(?:SCIENT_|T3CODE_)[A-Z_]*=/u;
/** Where the product writes its log under `ompLiveInstance`'s root, relative to that root. */
export const ompQualifyLogsDir = qualifiesScientAgent
  ? NodePath.join("home", "logs")
  : NodePath.join("home", ".omp", "logs");

/**
 * The product's environment with its state at `agent`'s parent: Oh My Pi
 * takes the agent directory, Scient Agent the config root that contains it.
 */
export const ompQualifyEnvironment = (input: {
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly agent: string;
  readonly platform: NodeJS.Platform;
}): NodeJS.ProcessEnv =>
  qualifiesScientAgent
    ? scientAgentProcessEnvironment({
        baseEnv: input.baseEnv,
        root: NodePath.dirname(input.agent),
        platform: input.platform,
      })
    : ompProcessEnvironment({
        baseEnv: input.baseEnv,
        homePath: input.agent,
        platform: input.platform,
      });

/**
 * A live instance built the way the driver builds one: the test's own
 * environment with `root/home` as HOME, passed through the production
 * builder with the instance home setting `homePath` (`root/home/agent`).
 * Hand both to the adapter, as the driver does. With `blockEgress`,
 * non-loopback HTTP goes to a dead proxy and OMP's default Ollama probe is
 * disabled, so only local stubs can answer.
 */
export const ompLiveInstance = (
  root: string,
  options: { readonly blockEgress?: boolean; readonly baseEnv?: NodeJS.ProcessEnv } = {},
): { readonly environment: NodeJS.ProcessEnv; readonly homePath: string } => {
  const home = NodePath.join(root, "home");
  const agent = NodePath.join(home, "agent");
  NodeFS.mkdirSync(agent, { recursive: true });
  if (options.blockEgress) {
    NodeFS.writeFileSync(
      NodePath.join(agent, "config.yml"),
      "retry:\n  enabled: false\ndisabledProviders:\n  - ollama\n",
    );
  }
  const environment = ompQualifyEnvironment({
    baseEnv: {
      ...(options.baseEnv ?? process.env),
      HOME: home,
      ...(options.blockEgress
        ? {
            HTTPS_PROXY: "http://127.0.0.1:9",
            HTTP_PROXY: "http://127.0.0.1:9",
            NO_PROXY: "127.0.0.1,localhost",
          }
        : {}),
    },
    agent,
    platform: HostProcessPlatform.defaultValue(),
  });
  return { environment, homePath: agent };
};
