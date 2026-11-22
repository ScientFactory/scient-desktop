import * as Effect from "effect/Effect";

import { AccountSessionFiles } from "../../../scient/accounts/agent/sessionFiles.ts";
import type { NetworkDetail, NetworkListItem } from "../../../scient/browser/NetworkStudy.ts";
import { AgentInvocationContext } from "../../../scient/operations/AgentInvocationContext.ts";
import { PreviewAutomationBroker } from "../../PreviewAutomationBroker.ts";
import { ScientBrowserNetworkError, ScientBrowserNetworkToolkit } from "./tools.ts";

const LIST_LIMIT = 60;

const unavailable = (message: string) =>
  new ScientBrowserNetworkError({ code: "unavailable", message });

export const ScientBrowserNetworkToolkitHandlersLive = ScientBrowserNetworkToolkit.toLayer(
  Effect.succeed({
    preview_network: Effect.fn("ScientBrowserNetwork.read")(function* (input) {
      const invocation = yield* AgentInvocationContext;
      const broker = yield* PreviewAutomationBroker;
      const invoke = <A>(operation: "networkList" | "networkRequest", body: unknown) =>
        broker
          .invoke<A>({
            scope: invocation,
            operation,
            input: body,
            ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
            updateCurrentTab: false,
          })
          .pipe(Effect.mapError((error) => unavailable(error.message)));
      if (input.requestId === undefined) {
        const listed = yield* invoke<ReadonlyArray<NetworkListItem>>(
          "networkList",
          input.filter === undefined ? {} : { filter: input.filter },
        );
        return { requests: listed.slice(-LIST_LIMIT) };
      }
      const detail = yield* invoke<NetworkDetail | undefined>("networkRequest", {
        requestId: input.requestId,
      });
      if (detail === undefined)
        return yield* new ScientBrowserNetworkError({
          code: "not-found",
          message: "That request is no longer kept. List the tab's requests again.",
        });
      const { largeBody, ...rest } = detail;
      if (largeBody === undefined) return rest;
      const files = yield* AccountSessionFiles;
      const path = yield* files
        .write(invocation.threadId, `response-${detail.id}.txt`, largeBody)
        .pipe(Effect.mapError(() => unavailable("The response body could not be saved.")));
      return { ...rest, responseBodyPath: path };
    }),
  }),
);
