// @effect-diagnostics nodeBuiltinImport:off
/**
 * Live suites are opt-in and must report skipped without OMP_QUALIFY_BINARY. Full turns and managed
 * downloads require separate flags; default the model to local Ollama. OMP_QUALIFY_TARGET=scient
 * applies the same qualification to Scient Agent.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
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
  readonly homeDirectory: string;
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
        homeDirectory: input.homeDirectory,
        homePath: input.agent,
        platform: input.platform,
      });

/**
 * Build HOME/instance home through the production environment path. blockEgress sends non-loopback
 * HTTP to a dead proxy and disables default Ollama probing so only local stubs can answer.
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
    homeDirectory: home,
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
    platform: HostProcess.Platform.defaultValue(),
  });
  return { environment, homePath: agent };
};
