/**
 * Agent tools for Settings → Providers → Custom models: list the connections and
 * their models, add or change one, test it through an agent, and remove it.
 *
 * @module CustomModelsAgentTools
 */
import {
  CustomModelProtocol,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  SecretRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ProviderSessionManagerV2 } from "../../../orchestration-v2/ProviderSessionManager.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  // The caller checks read the live owner's invocation policy.
  dependencies: [
    ProviderSessionManagerV2,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const Text = Schema.String.check(Schema.isMaxLength(256));

const AgentStatus = Schema.Struct({
  agent: ProviderInstanceId,
  status: Schema.String,
});

const ListedModel = Schema.Struct({
  model: Schema.String,
  name: Schema.String,
  limits: Schema.String,
  agents: Schema.Array(AgentStatus),
});

const ListedConnection = Schema.Struct({
  connectionId: Schema.String,
  name: Schema.String,
  protocol: CustomModelProtocol,
  baseUrl: Schema.String,
  key: Schema.String,
  models: Schema.Array(ListedModel),
});

const CustomModelsList = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({ agent: ProviderInstanceId, name: Schema.String, enabled: Schema.Boolean }),
  ),
  connections: Schema.Array(ListedConnection),
});

const CustomModelsReadTool = Tool.make("scient_custom_models", {
  ...shared,
  description:
    "List Settings → Custom models: each connection (endpoint, whether a key is saved), its models, their limits, and their status in each agent that can use them. Never returns keys.",
  parameters: Tool.EmptyParams,
  success: CustomModelsList,
})
  .annotate(Tool.Title, "Custom models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CustomModelsManageTool = Tool.make("scient_custom_models_manage", {
  ...shared,
  description:
    "Change Settings → Custom models when the user asks. save: add a model, or change one, on an existing connection (`connectionId`) or a new one (`connection`, e.g. OpenRouter https://openrouter.ai/api/v1 with openai-completions). Scient asks the endpoint for the model's limits; give `contextWindow` and `maxOutputTokens` when it can't, as the result says. A new key: request_secret first, then pass its `secretRef`; never ask for a key in chat. test: one short request through each agent the model is connected to. remove: one model, or the whole connection and its key with `wholeConnection`.",
  parameters: Schema.Struct({
    action: Schema.Literals(["save", "test", "remove"]),
    connectionId: Schema.optionalKey(Schema.String).annotate({
      description: "An existing connection, from scient_custom_models.",
    }),
    connection: Schema.optionalKey(
      Schema.Struct({
        name: Text,
        baseUrl: Text,
        protocol: CustomModelProtocol,
      }),
    ).annotate({ description: "save: a new connection." }),
    model: Schema.optionalKey(Text).annotate({
      description: "The endpoint's model ID, e.g. openrouter/free.",
    }),
    name: Schema.optionalKey(Text).annotate({ description: "save: the name shown in Scient." }),
    agents: Schema.optionalKey(Schema.Array(ProviderInstanceId)).annotate({
      description: "save: agents that may use it. Default: every enabled agent that can.",
    }),
    contextWindow: Schema.optionalKey(Schema.Int).annotate({
      description: "save: tokens the model reads, with maxOutputTokens. Both or neither.",
    }),
    maxOutputTokens: Schema.optionalKey(Schema.Int).annotate({
      description: "save: tokens the model writes in one reply.",
    }),
    images: Schema.optionalKey(Schema.Boolean).annotate({
      description: "save, with limits: whether the model reads images.",
    }),
    secretRef: Schema.optionalKey(SecretRef).annotate({
      description: "save: the connection's key, from request_secret. It works once.",
    }),
    wholeConnection: Schema.optionalKey(Schema.Boolean).annotate({
      description: "remove: the connection, every model on it, and its key.",
    }),
  }),
  success: Schema.Struct({
    lines: Schema.Array(Schema.String),
    connectionId: Schema.optionalKey(Schema.String),
  }),
})
  .annotate(Tool.Title, "Change custom models")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true);

export const CustomModelsToolkit = Toolkit.make(CustomModelsReadTool, CustomModelsManageTool);
