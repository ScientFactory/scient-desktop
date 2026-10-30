import { AccountId, ProviderInstanceId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ServerSettingsService } from "../../serverSettings.ts";
import { fakeAccounts } from "./agent/AccountsService.testkit.ts";
import { makeAccountKeyLinks } from "./keyLinks.ts";

const accountId = AccountId.make("acc_fixture1");
const instanceId = ProviderInstanceId.make("codex");
const link = { accountId, instanceId, variable: "OPENAI_API_KEY" };

const run = (value: string) => {
  const updates: Array<unknown> = [];
  const settings = {
    getSettings: Effect.succeed({
      providerInstances: {
        [instanceId]: {
          driver: "codex",
          environment: [
            { name: "OPENAI_API_KEY", value, sensitive: true },
            { name: "CODEX_HOME", value: "/home", sensitive: false },
          ],
        },
      },
    }),
    updateSettings: (patch: unknown) =>
      Effect.sync(() => {
        updates.push(patch);
        return {};
      }),
  } as unknown as ServerSettingsService["Service"];
  const fake = fakeAccounts({ values: { token: "saved-key" } });
  return Effect.scoped(
    makeAccountKeyLinks(fake.service).pipe(
      Effect.flatMap((linkKey) => linkKey(link)),
      Effect.as(updates),
      Effect.provideService(ServerSettingsService, settings),
    ),
  );
};

it.effect("copies the saved key into the variable and leaves the others alone", () =>
  Effect.gen(function* () {
    const [update] = (yield* run("old")) as Array<{
      providerInstances: Record<string, { environment: unknown }>;
    }>;
    expect(update?.providerInstances[instanceId]?.environment).toEqual([
      { name: "OPENAI_API_KEY", value: "saved-key", sensitive: true },
      { name: "CODEX_HOME", value: "/home", sensitive: false },
    ]);
  }),
);

it.effect("writes nothing when the variable already has the key", () =>
  Effect.gen(function* () {
    expect(yield* run("saved-key")).toEqual([]);
  }),
);
