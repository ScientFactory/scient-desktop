import { scientInvocationForMcp } from "../../ScientMcpInvocation.ts";
import * as Effect from "effect/Effect";
import * as Preview from "../../../preview/Manager.ts";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { PreviewControlsToolkit } from "./tools.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
// SCIENT-FORK:START — Scient Accounts: hide and protect tabs in profiles this session may not see.
import {
  profileUnavailable,
  visibleProfiles,
  withPreviewAccounts,
} from "../../../scient/accounts/agent/previewProfileAccess.ts";
import type { PreviewSessionSnapshot } from "@t3tools/contracts";

/** The sessions whose profile this agent session may see; all of them without Accounts. */
const visibleSessions = (sessions: ReadonlyArray<PreviewSessionSnapshot>) =>
  withPreviewAccounts(Effect.succeed(sessions), (scope) =>
    visibleProfiles(
      scope,
      sessions.flatMap((session) => (session.profileId ? [session.profileId] : [])),
    ).pipe(Effect.map((visible) => sessions.filter((session) => visible(session.profileId)))),
  );
// SCIENT-FORK:END

const access = Effect.gen(function* () {
  const scope = yield* requireThreadMcpCapability("preview");
  return { scope, manager: yield* Preview.PreviewManager };
});
export const layer = McpToolAccess.toLayer(PreviewControlsToolkit, {
  scient_preview_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const result = yield* manager.list({ threadId: scope.thread.threadId });
      // SCIENT-FORK:START — Scient Accounts: list only tabs in profiles this session may see.
      const sessions = yield* visibleSessions(result.sessions);
      // SCIENT-FORK:END
      const start = input.cursor ?? 0;
      const end = start + (input.limit ?? 20);
      return {
        ...result,
        sessions: sessions.slice(start, end),
        nextCursor: end < sessions.length ? end : null,
      };
    }),
  ),
  scient_preview_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      // SCIENT-FORK:START — Scient Accounts: refuse closing a tab in a profile this session may not see.
      const target = sessions.find((session) => session.tabId === input.tabId);
      if (target && (yield* visibleSessions([target])).length === 0)
        return yield* profileUnavailable();
      // SCIENT-FORK:END
      if (target?.runtime === "server") {
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        yield* broker.invoke({
          scope: scientInvocationForMcp(scope),
          operation: "close",
          input: {},
          tabId: input.tabId,
        });
        return {};
      }
      yield* manager
        .close({ threadId: scope.thread.threadId, tabId: input.tabId })
        .pipe(Effect.mapError(unavailable));
      return {};
    }),
  ),
});
