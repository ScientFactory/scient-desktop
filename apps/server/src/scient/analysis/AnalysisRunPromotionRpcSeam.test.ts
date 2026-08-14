// @effect-diagnostics nodeBuiltinImport:off -- static audit for additive shared RPC mounts.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

function source(relativePath: string): string {
  return NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("analysis run promotion RPC seam", () => {
  it("keeps the command typed, authenticated as a write, and mounted through AnalysisService", () => {
    const contracts = source("../../../../../packages/contracts/src/rpc.ts");
    expect(contracts).toContain('analysisPromoteRun: "analysis.promoteRun"');
    expect(contracts).toContain("WsAnalysisPromoteRunRpc");

    const authorization = source("../../auth/RpcAuthorization.ts");
    expect(authorization).toContain(
      "[WS_METHODS.analysisPromoteRun]: AuthOrchestrationOperateScope",
    );

    const websocket = source("../../ws.ts");
    expect(websocket).toContain("analysis.promoteRun(input)");
    expect(websocket).toContain("[WS_METHODS.analysisPromoteRun]");
  });
});
