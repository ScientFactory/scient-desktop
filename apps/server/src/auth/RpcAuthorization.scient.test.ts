import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  WS_METHODS,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { RPC_REQUIRED_SCOPES } from "./RpcAuthorization.ts";

it("requires settings permission to manage Words", () => {
  expect(RPC_REQUIRED_SCOPES[WS_METHODS.voiceManageWords]).toBe(AuthSettingsWriteScope);
});

it("requires dictation permission to read a project's Words", () => {
  expect(RPC_REQUIRED_SCOPES[WS_METHODS.voiceReadWords]).toBe(AuthOrchestrationOperateScope);
});
