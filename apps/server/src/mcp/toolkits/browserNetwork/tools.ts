import { PreviewTabId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { AccountSessionFiles } from "../../../scient/accounts/agent/sessionFiles.ts";
import { AgentInvocationContext } from "../../../scient/operations/AgentInvocationContext.ts";
import { PreviewAutomationBroker } from "../../PreviewAutomationBroker.ts";
import { ScientOperation } from "../../ScientOperationTool.ts";

export class ScientBrowserNetworkError extends Schema.TaggedError<ScientBrowserNetworkError>()(
  "ScientBrowserNetworkError",
  { code: Schema.Literals(["unavailable", "not-found"]), message: Schema.String },
) {}

const Headers = Schema.Record(Schema.String, Schema.String);

const PreviewNetworkTool = Tool.make("preview_network", {
  description:
    "A browser tab's recent requests (method, url, status, type, ms), to study how a site loads its data. With requestId: that request's headers and body and its response's headers and body (text up to 32 KB; a larger one is saved to a file). Cookies, authorization and token-looking values are hidden; a connector gets the real session only from Scient's sign-in files.",
  parameters: Schema.Struct({
    tabId: Schema.optional(PreviewTabId),
    requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
    filter: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
      description: "Only urls containing this text.",
    }),
  }),
  success: Schema.Union([
    Schema.Struct({
      requests: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          method: Schema.String,
          url: Schema.String,
          status: Schema.NullOr(Schema.Number),
          type: Schema.String,
          ms: Schema.optional(Schema.Number),
          failed: Schema.optional(Schema.String),
        }),
      ),
    }),
    Schema.Struct({
      id: Schema.String,
      method: Schema.String,
      url: Schema.String,
      status: Schema.NullOr(Schema.Number),
      requestHeaders: Headers,
      requestBody: Schema.optional(Schema.String),
      responseHeaders: Schema.optional(Headers),
      responseBody: Schema.optional(Schema.String),
      responseBodyPath: Schema.optional(Schema.String),
      note: Schema.optional(Schema.String),
    }),
  ]),
  failure: ScientBrowserNetworkError,
  dependencies: [AgentInvocationContext, PreviewAutomationBroker, AccountSessionFiles],
})
  .annotate(Tool.Title, "Read a tab's requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, {
    id: "browser.network",
    scope: "thread",
    requiredCapabilities: ["preview"],
  });

export const ScientBrowserNetworkToolkit = Toolkit.make(PreviewNetworkTool);
