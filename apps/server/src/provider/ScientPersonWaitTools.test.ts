import { describe, expect, it } from "vite-plus/test";

import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ScientAccountsToolkit } from "../scient/accounts/agent/tools.ts";
import { SCIENT_PERSON_WAIT_TOOLS } from "./ScientPersonWaitTools.ts";

describe("Scient tools that wait on a card", () => {
  it("are all real tool names, so none silently falls back into Code Mode", () => {
    const names = new Set([
      ...Object.keys(OrchestratorToolkit.tools),
      ...Object.keys(ScientAccountsToolkit.tools),
    ]);
    expect(SCIENT_PERSON_WAIT_TOOLS.filter((name) => !names.has(name))).toEqual([]);
  });
});
