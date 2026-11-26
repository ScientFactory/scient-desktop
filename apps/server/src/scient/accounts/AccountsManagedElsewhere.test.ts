import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { SourceControlCredentialError } from "@t3tools/source-control-core/server/driver";
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from "effect";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { GitHubSourceControlCredential } from "../extensions/connectors/GitHubSourceControlCredential.ts";
import { makeHarness, website } from "./Accounts.testkit.ts";

it.effect(
  "keeps snapshots and writes immediate while external GitHub discovery stays on demand, off the write lock, and never runs aggregate discovery",
  () =>
    Effect.gen(function* () {
      let aggregateDiscoveries = 0;
      let githubDiscoveries = 0;
      const started = yield* Deferred.make<void>();
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
                    Effect.andThen(Deferred.succeed(started, undefined)),
                    Effect.andThen(Deferred.await(gate)),
                    Effect.as(Option.some(githubItem)),
                  )
                : Effect.die("Accounts must not probe non-GitHub source-control providers."),
          }),
        ),
      );

      // Snapshots alone never trigger external GitHub discovery.
      expect((yield* service.snapshot).managedElsewhere).toEqual([
        {
          kind: "custom-model",
          id: "keyed",
          name: "Endpoint",
          detail: "https://models.example.test",
          href: "/settings/custom-models",
        },
      ]);
      expect(aggregateDiscoveries).toBe(0);
      expect(githubDiscoveries).toBe(0);

      // Start an in-flight external discovery and prove snapshots and writes still complete
      // immediately while discovery is blocked (i.e., discovery never holds the write semaphore).
      const discoveryFiber = yield* Effect.forkChild(service.externalIdentities);
      yield* Deferred.await(started);
      expect((yield* service.snapshot).managedElsewhere).toHaveLength(1);
      yield* service.save(website());
      expect(aggregateDiscoveries).toBe(0);
      expect(githubDiscoveries).toBe(1);

      // Releasing discovery completes the fiber and caches the complete result.
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(discoveryFiber)).toEqual([
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

it.effect("does not cache incomplete GitHub identity probes when credential lookup fails", () =>
  Effect.gen(function* () {
    let credentialCalls = 0;
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
              accounts: [
                { host: "github.com", account: "octo", active: true, authenticated: true },
              ],
            },
          },
        ]),
        github: GitHubSourceControlCredential.of({
          mcpUrl: "https://api.githubcopilot.com/mcp/",
          get: (host) => {
            credentialCalls += 1;
            return credentialCalls === 1
              ? Effect.fail(new SourceControlCredentialError({ host }))
              : Effect.succeedSome({
                  token: Redacted.make("ghu_synthetic"),
                  via: "app",
                  login: "Octo",
                });
          },
          invalidate: () => Effect.void,
        }),
      },
    });

    expect(yield* service.externalIdentities).toEqual([
      {
        kind: "github",
        id: "github.com:octo",
        name: "octo",
        detail: "github.com",
        href: "/settings/source-control",
        via: "gh",
      },
    ]);
    // Because the first credential lookup failed, the partial result is not pinned for 1 minute.
    expect(yield* service.externalIdentities).toEqual([
      {
        kind: "github",
        id: "github.com:octo",
        name: "Octo",
        detail: "github.com",
        href: "/settings/source-control",
        via: "app",
      },
    ]);
    expect(credentialCalls).toBe(2);
    // Once complete, subsequent reads reuse the cached entry.
    yield* service.externalIdentities;
    expect(credentialCalls).toBe(2);
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
