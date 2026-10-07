import { assert, it } from "vite-plus/test";
import { formatTransferBudgetResult } from "../apps/server/integration/TransferBudgetReport.integration.ts";
import reporter from "../.github/scripts/thread-transfer-report.cjs";

it("produces artifacts accepted by the trusted publisher for each startup transport", () => {
  for (const startupTransport of [
    "full-compact-http-with-live-cursor",
    "bounded-compact-http-with-live-cursor",
  ]) {
    const runs = ["codex", "claudeAgent"].map((provider) => ({
      provider,
      startupTransport,
      threadSnapshot: { wireBytes: 4_365, decodedBodyBytes: 200_000 },
      measuredTurnWebSocket: { wireBytes: 1_342, decodedBytes: 10_000, messages: 5 },
    }));
    const current = reporter.validateResult(JSON.parse(formatTransferBudgetResult(runs)));
    assert.equal(current.schemaVersion, 2);
    assert.deepEqual(current.scenario.startupTransport, [startupTransport]);
    assert.equal(current.providers.codex.observed.totalWireBytes, 5_707);
    assert.equal(current.providers.claudeAgent.ceiling.threadSnapshotWireBytes, 5_000);
  }
});
