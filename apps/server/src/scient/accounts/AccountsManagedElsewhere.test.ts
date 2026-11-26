import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { Deferred, Effect, Layer, Option, Redacted } from "effect";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { GitHubSourceControlCredential } from "../extensions/connectors/GitHubSourceControlCredential.ts";
import { makeHarness, website } from "./Accounts.testkit.ts";

it.effect(
  "keeps snapshots and writes immediate while external GitHub discovery stays on demand and never runs aggregate discovery",
  () =>
    Effect.gen(function* () {
      let aggregateDiscoveries = 0;
      let githubDiscoveries = 0;
      const gate = yield* Deferred.make<void>();
      const githubItem = {
        kind: SourceControlProviderKind.make("github"),
        label: "GitHub",
        implemented: true,
        status: "available" as const,
        version: Option.none(),
        installHint: "",
        detail: Option.none(),
        auth: {
          status: "authenticated" as const,
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
      };
      const { service } = yield* makeHarness({
        sourceOverrides: {
          customModelKeys: Effect.succeed([
            { connectionId: "keyed", name: "Endpoint", origin: "https://models.example.test" },
          ]),
        },
      }).pipe(
        Effect.provide(
          Layer.mock(SourceControlProviderRegistry)({
            resolveLink: () => undefined,
            discover: Effect.sync(() => (aggregateDiscoveries += 1)).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as([githubItem]),
            ),
            discoverProvider: (kind) =>
              kind === "github"
                ? Effect.sync(() => (githubDiscoveries += 1)).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.as(Option.some(githubItem)),
                  )
                : Effect.die("Accounts must not probe non-GitHub source-control providers."),
          }),
        ),
      );

      // Core snapshot and writes complete without blocking on pending CLI probes.
      expect((yield* service.snapshot).managedElsewhere).toEqual([
        {
          kind: "custom-model",
          id: "keyed",
          name: "Endpoint",
          detail: "https://models.example.test",
          href: "/settings/custom-models",
        },
      ]);
      yield* service.save(website());
      expect(aggregateDiscoveries).toBe(0);
      expect(githubDiscoveries).toBe(0);

      // External identity lookup probes only GitHub and caches the result.
      yield* Deferred.succeed(gate, undefined);
      expect(yield* service.externalIdentities).toEqual([
        {
          kind: "github",
          id: "github.example.test:synthetic-user",
          name: "synthetic-user",
          detail: "github.example.test",
          href: "/settings/source-control",
          via: "gh",
        },
      ]);
      yield* service.externalIdentities;
      expect(aggregateDiscoveries).toBe(0);
      expect(githubDiscoveries).toBe(1);
    }),
);

it.effect("omits unavailable GitHub discovery and retains optional snapshot compatibility", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    expect((yield* service.snapshot).managedElsewhere).toEqual([]);
    expect(yield* service.externalIdentities).toEqual([]);
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
        (yield* service.externalIdentities).map(({ id, name, via }) => ({
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
