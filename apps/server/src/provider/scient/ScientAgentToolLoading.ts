import { compareSemverVersions } from "@t3tools/shared/semver";

import type { OmpExecutableIdentity, OmpTarget } from "../omp/OmpTarget.ts";

export const SCIENT_CONNECTOR_LOAD_MODE_ENV = "SCIENT_AGENT_CONNECTOR_LOAD_MODE";

/** The small core that stays direct while other tools use the runtime's discovery transport. */
export const SCIENT_ALWAYS_LOADED_TOOLS: ReadonlyArray<string> = [
  "scient_compute_run",
  "scient_paper_get",
  "send_to_user",
  "html_render",
  "scient_thread_inspect",
  "scient_thread_launch",
  "scient_thread_organize",
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "request_secret",
  "scient_skills_list",
  "scient_skill_load",
];

/** Scient 0.1.4 / OMP 18.18.0 preserves mounted tools across cold subagent revival. */
export const scientConnectorLoadMode = (target: OmpTarget, identity: OmpExecutableIdentity) => {
  const canDiscover =
    (target.driverKind === "omp" ||
      (target.driverKind === "scient" && compareSemverVersions(identity.version, "0.1.4") >= 0)) &&
    compareSemverVersions(identity.runtimeVersion, "18.18.0") >= 0;
  if (!canDiscover) return "essential";
  return compareSemverVersions(identity.runtimeVersion, "19.1.0") >= 0
    ? "commands"
    : "discoverable";
};
