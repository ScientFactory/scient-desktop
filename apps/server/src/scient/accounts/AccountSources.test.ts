import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { ItemCreateParams, ItemField } from "@1password/sdk";
import { AccountId } from "@t3tools/contracts";
import { Effect, Layer, Redacted } from "effect";
import { layerTest as configTestLayer } from "../../config.ts";
import { layerTest as settingsTestLayer } from "../../serverSettings.ts";
import { AccountsSecretStore } from "./AccountsSecretStore.ts";
import { AccountSources, layer } from "./AccountSources.ts";
import { syntheticValue, website } from "./Accounts.testkit.ts";

const fixture = vi.hoisted(() => ({
  items: [] as Array<{ id: string; vaultId: string; tags: string[]; fields: ItemField[] }>,
}));
vi.mock("@1password/sdk", () => ({
  ItemCategory: { Login: "Login" },
  ItemFieldType: { Text: "Text", Concealed: "Concealed", Totp: "Totp" },
  AutofillBehavior: { ExactDomain: "ExactDomain", AnywhereOnWebsite: "AnywhereOnWebsite" },
  // Constructed with `new`; the mock needs no members.
  DesktopAuth: function DesktopAuth() {},
  createClient: async () => ({
    vaults: { list: async () => [{ id: "vault", title: "Synthetic vault" }] },
    items: {
      list: async () => structuredClone(fixture.items),
      get: async (_vault: string, id: string) =>
        structuredClone(fixture.items.find((item) => item.id === id)),
      create: async (input: ItemCreateParams) => {
        const item = {
          id: `item-${fixture.items.length}`,
          vaultId: input.vaultId,
          tags: input.tags ?? [],
          fields: structuredClone(input.fields ?? []),
        };
        fixture.items.push(item);
        return structuredClone(item);
      },
      put: async (input: (typeof fixture.items)[number]) => {
        fixture.items[fixture.items.findIndex((item) => item.id === input.id)] =
          structuredClone(input);
        return structuredClone(input);
      },
    },
  }),
}));

it.effect("reuses an external copy after its create response was not committed locally", () =>
  Effect.gen(function* () {
    fixture.items = [];
    const sources = yield* AccountSources.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              configTestLayer(process.cwd(), { prefix: "accounts-sources-test-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
              settingsTestLayer({}),
              Layer.mock(AccountsSecretStore)({}),
            ),
          ),
        ),
      ),
    );
    const client = yield* sources.onePassword(
      Redacted.make({ mode: "desktop", accountName: "Synthetic" }),
    );
    const input = {
      vaultId: "vault",
      copyId: "synthetic-copy",
      title: "Synthetic",
      details: website().details,
      field: "password",
      value: Redacted.make(syntheticValue()),
    };
    const original = yield* client.createLogin!(input);
    const rotated = syntheticValue();
    const retried = yield* client.createLogin!({ ...input, value: Redacted.make(rotated) });
    expect(retried).toEqual(original);
    expect(fixture.items.length).toBe(1);
    expect(
      fixture.items[0]?.fields.find((field) => field.id === "password")?.value === rotated,
    ).toBe(true);
  }),
);

it.effect("refuses a legacy source once a connection points at an Accounts key", () =>
  Effect.gen(function* () {
    const connection = {
      id: "synthetic-model",
      name: "Synthetic models",
      protocol: "openai-completions" as const,
      baseUrl: "https://models.example.test",
      models: [],
      credentialId: "still-present",
      accountId: AccountId.make("acc_private_target"),
    };
    const sources = yield* AccountSources.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              configTestLayer(process.cwd(), { prefix: "accounts-model-link-test-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
              settingsTestLayer({ customModels: { connections: [connection] } }),
              Layer.mock(AccountsSecretStore)({}),
            ),
          ),
        ),
      ),
    );
    expect(yield* sources.customModelKeys).toEqual([]);
    const denied = yield* sources.customModel(connection.id).pipe(Effect.flip);
    expect(denied.message).toContain("Use the saved API key directly in Accounts");
  }),
);
