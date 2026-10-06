import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import * as PublicContracts from "./index.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WsRpcGroup } from "./rpc.ts";
import {
  OrchestrationSearchThreadsResult,
  OrchestrationThreadSearchMatch,
} from "./scientThreadSearch.ts";
import {
  OrchestrationSearchThreadsResult as ModernSearchThreadsResult,
  OrchestrationThreadSearchMatch as ModernThreadSearchMatch,
  OrchestrationThreadSearchSource,
} from "./threadSearch.ts";

const decodeResult = Schema.decodeUnknownSync(OrchestrationSearchThreadsResult);
const encodeResult = Schema.encodeSync(OrchestrationSearchThreadsResult);
const decodeMatchExit = Schema.decodeUnknownExit(OrchestrationThreadSearchMatch);
const decodeModernResultExit = Schema.decodeUnknownExit(ModernSearchThreadsResult);
const decodeModernResult = Schema.decodeUnknownSync(ModernSearchThreadsResult);
const legacyMatch = {
  threadId: "unscoped-thread",
  projectId: null,
  source: "user",
  snippet: "x".repeat(240),
  messageCreatedAt: null,
};

describe("Scient nullable thread search contracts", () => {
  it("selects the same nullable schema objects through public exports", () => {
    expect(PublicContracts.OrchestrationThreadSearchMatch).toBe(OrchestrationThreadSearchMatch);
    expect(PublicContracts.OrchestrationSearchThreadsResult).toBe(OrchestrationSearchThreadsResult);
    expect(OrchestrationThreadSearchMatch.fields.source).toBe(OrchestrationThreadSearchSource);
  });

  it("round-trips nullable history and project-scoped matches without changing their wire fields", () => {
    const wire = {
      matches: [
        legacyMatch,
        {
          threadId: "scoped-thread",
          projectId: "project-1",
          source: "assistant",
          snippet: "",
          messageCreatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const encoded = encodeResult(decodeResult(wire));
    expect(encoded).toEqual(wire);
    expect(Object.keys(encoded.matches[0]!)).toEqual([
      "threadId",
      "projectId",
      "source",
      "snippet",
      "messageCreatedAt",
    ]);
    expect(encodeResult(decodeResult({ matches: [] }))).toEqual({ matches: [] });
  });

  it("keeps the snippet limit and required nullable fields", () => {
    expect(Exit.isSuccess(decodeMatchExit(legacyMatch))).toBe(true);
    expect(Exit.isFailure(decodeMatchExit({ ...legacyMatch, snippet: "x".repeat(241) }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeMatchExit({ ...legacyMatch, projectId: undefined }))).toBe(true);
    expect(Exit.isFailure(decodeMatchExit({ ...legacyMatch, messageCreatedAt: undefined }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeMatchExit({ ...legacyMatch, source: "tool" }))).toBe(true);
  });

  it("keeps modern RPC on its distinct non-null project variant", () => {
    const rpc = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.searchThreads);
    expect(rpc?.successSchema).toBe(ModernSearchThreadsResult);
    expect(PublicContracts.OrchestrationV2SearchThreadsResult).toBe(ModernSearchThreadsResult);
    expect(ModernSearchThreadsResult).not.toBe(OrchestrationSearchThreadsResult);
    expect(ModernThreadSearchMatch).not.toBe(OrchestrationThreadSearchMatch);
    expect(Exit.isFailure(decodeModernResultExit({ matches: [legacyMatch] }))).toBe(true);
    const scoped = { ...legacyMatch, projectId: "project-1" };
    expect(decodeModernResult({ matches: [scoped] }).matches).toEqual([scoped]);
  });
});
