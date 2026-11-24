import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";

export const copyRecording = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:recordings:import",
  tag: WS_METHODS.projectsChangeEntries,
});
