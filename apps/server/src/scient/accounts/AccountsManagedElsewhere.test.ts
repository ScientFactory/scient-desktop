import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { Effect, Layer, Option, Redacted } from "effect";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { GitHubSourceControlCredential } from "../extensions/connectors/GitHubSourceControlCredential.ts";
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
          via: "gh",
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

it.effect(
  "lists each GitHub login once, Source Control's own choice first with how it holds it",
  () =>
    Effect.gen(function* () {
      const account = (login: string) => ({
        host: "github.com",
        account: login,
        active: false,
        authenticated: true,
      });
      const { service } = yield* makeHarness({
        sourceControl: {
          discover: Effect.succeed([
            {
              kind: SourceControlProviderKind.make("github"),
              label: "GitHub",
              status: "available",
              version: Option.none(),
              installHint: "Install gh",
              detail: Option.none(),
              auth: {
                status: "authenticated",
                account: Option.some("octo"),
                host: Option.some("github.com"),
                detail: Option.none(),
                accounts: [account("octo"), account("second")],
              },
            },
          ]),
          github: GitHubSourceControlCredential.of({
            mcpUrl: "https://api.githubcopilot.com/mcp/",
            get: () =>
              Effect.succeedSome({
                token: Redacted.make("ghu_synthetic"),
                via: "app",
                login: "Octo",
              }),
            invalidate: () => Effect.void,
          }),
        },
      });
      expect(
        (yield* service.snapshot).managedElsewhere?.map(({ id, name, via }) => ({
          id,
          name,
          via,
        })),
      ).toEqual([
        { id: "github.com:octo", name: "Octo", via: "app" },
        { id: "github.com:second", name: "second", via: "gh" },
      ]);
    }),
);
