/** V1 facade retained until its remaining consumers are deleted. */
import type { ModelSelection, ThreadId, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderAdapterRegistry } from "../../../provider/Services/ProviderAdapterRegistry.ts";
import { resolveNativeModelContextWindow } from "../NativeModelContextWindow.ts";
export { forkModelWindowKey } from "../NativeModelContextWindow.ts";

export const resolveForkModelWindow = Effect.fn("resolveForkModelWindow")(function* (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly settings: ServerSettings;
  readonly registry: ProviderAdapterRegistry["Service"] | undefined;
  readonly sql: SqlClient.SqlClient;
}) {
  const discovered =
    input.registry === undefined
      ? undefined
      : yield* input.registry.getByInstance(input.modelSelection.instanceId).pipe(
          Effect.flatMap(
            (adapter) =>
              adapter.getModelContextWindow?.({
                threadId: input.threadId,
                modelSelection: input.modelSelection,
              }) ?? Effect.succeed(undefined),
          ),
          Effect.orElseSucceed(() => undefined),
        );
  return yield* resolveNativeModelContextWindow({ ...input, reported: discovered });
});
