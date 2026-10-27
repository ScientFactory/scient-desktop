import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { makeHarness } from "./Accounts.testkit.ts";

it.effect(
  "projects authenticated GitHub identities and the existing Custom models key inventory",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        sourceOverrides: {
          customModelKeys: Effect.succeed([
            { connectionId: "keyed", name: "Endpoint", origin: "https://models.example.test" },
          ]),
        },
      });
      expect((yield* service.snapshot).managedElsewhere).toEqual([
        {
          kind: "github",
          id: "github.example.test:synthetic-user",
          name: "synthetic-user",
          detail: "github.example.test",
          href: "/settings/source-control",
        },
        {
          kind: "custom-model",
          id: "keyed",
          name: "Endpoint",
          detail: "https://models.example.test",
          href: "/settings/custom-models",
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          discover: Effect.succeed([
            {
              kind: SourceControlProviderKind.make("github"),
              label: "GitHub",
              implemented: true,
              status: "available",
              version: Option.none(),
              installHint: "",
              detail: Option.none(),
              auth: {
                status: "authenticated",
                account: Option.some("synthetic-user"),
                host: Option.some("github.example.test"),
                detail: Option.none(),
                accounts: [
                  {
                    host: "github.example.test",
                    account: "synthetic-user",
                    active: true,
                    authenticated: true,
                  },
                  {
                    host: "github.example.test",
                    account: "signed-out",
                    active: false,
                    authenticated: false,
                  },
                ],
              },
            },
          ]),
        }),
      ),
    ),
);

it.effect("omits unavailable GitHub discovery and retains optional snapshot compatibility", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    expect((yield* service.snapshot).managedElsewhere).toEqual([]);
  }),
);

it.effect("shows the Overleaf managed row only while a token is saved", () =>
  Effect.gen(function* () {
    let saved = false;
    const { service } = yield* makeHarness({
      sourceOverrides: {
        overleafTokenSaved: Effect.sync(() => saved),
      },
    });
    expect((yield* service.snapshot).managedElsewhere).toEqual([]);
    saved = true;
    expect((yield* service.snapshot).managedElsewhere).toEqual([
      {
        kind: "overleaf",
        id: "www.overleaf.com",
        name: "Overleaf Git token — www.overleaf.com",
        href: "/settings/synced-folders",
      },
    ]);
    saved = false;
    expect((yield* service.snapshot).managedElsewhere).toEqual([]);
  }),
);
