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
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ompProcessEnvironment } from "./OmpEnvironment.ts";

export const ompQualifyBinary = process.env.OMP_QUALIFY_BINARY || undefined;
export const ompQualifyFullTurn = process.env.OMP_QUALIFY_FULL_TURN === "1";
export const ompQualifyModel = process.env.OMP_QUALIFY_MODEL || "ollama/gemma4:12b-it-qat";
export const ompQualifyManaged = process.env.OMP_QUALIFY_MANAGED === "1";

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
  const environment = ompProcessEnvironment({
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
    homePath: agent,
    platform: HostProcessPlatform.defaultValue(),
  });
  return { environment, homePath: agent };
};
