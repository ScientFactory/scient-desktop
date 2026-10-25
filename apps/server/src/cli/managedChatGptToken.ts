// SCIENT-FORK:START — the held credential entry point validates selectors but never opens IPC.
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Protocol from "../provider/CodexManagedTokenProtocol.ts";
import {
  CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE,
  rejectCodexSubscriptionSharing,
} from "../scient/providerLifecycle/codexSubscriptionSharingPolicy.ts";

const decodeArguments = Schema.decodeUnknownEffect(
  Schema.Tuple([
    Schema.NonEmptyString,
    Protocol.Request.fields.instanceId,
    Protocol.Request.fields.environmentId,
    Protocol.Request.fields.profileKey,
  ]),
);
export async function runManagedChatGptTokenCli(args: ReadonlyArray<string>): Promise<void> {
  const program = Effect.gen(function* () {
    const [, instanceId] = yield* decodeArguments(args);
    return yield* rejectCodexSubscriptionSharing(
      ProviderInstanceId.make(instanceId),
      "managedChatGptToken",
    );
  });
  await Effect.runPromiseExit(program);
  process.stderr.write(`${CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE}\n`);
  process.exitCode = 1;
}
// SCIENT-FORK:END
