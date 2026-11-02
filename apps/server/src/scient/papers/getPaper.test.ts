import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AccountsService } from "../accounts/AccountsService.ts";
import { fakeAccounts } from "../accounts/agent/AccountsService.testkit.ts";
import { getPaperForSource } from "./getPaper.ts";
import type * as PaperQueue from "./paperQueue.ts";

const asked = vi.hoisted(() => ({ requests: [] as Array<unknown> }));

/** The queue answers at once: the paper was saved and attached to its source. */
vi.mock("./paperQueue.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PaperQueue>();
  const { succeed } = await import("effect/Effect");
  const item = { itemId: "item-1", doi: "10.1/x", state: "saved" as const };
  const requestPapers: typeof actual.requestPapers = (root, papers, requester) => {
    asked.requests.push({ root, papers, requester });
    return succeed([{ ...item, state: "waiting" as const }]);
  };
  const waitForPaper: typeof actual.waitForPaper = () =>
    succeed({ ...item, path: "papers/x.pdf", route: "open-access" as const, published: false });
  return { ...actual, requestPapers, waitForPaper };
});

it.effect("reports a saved paper as attached to its source, as the user's own request", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("env-fixture");
    const result = yield* getPaperForSource(
      { root: "/project", sourceId: "source-1", expectedRevision: 3, doi: "10.1/x" },
      environmentId,
    );
    expect(result).toEqual({ status: "attached", published: false });
    expect(asked.requests).toEqual([
      {
        root: "/project",
        papers: [{ doi: "10.1/x", source: { sourceId: "source-1", expectedRevision: 3 } }],
        requester: { environmentId, browser: true, accounts: "all" },
      },
    ]);
  }).pipe(
    // The queue is stubbed, so these only satisfy its signature.
    Effect.provideService(AccountsService, fakeAccounts().service),
    Effect.provideService(
      PreviewAutomationBroker,
      PreviewAutomationBroker.of({
        connect: () => Effect.succeed(Stream.empty),
        focusHost: () => Effect.void,
        respond: () => Effect.void,
        invoke: () => Effect.die("no browser in this test"),
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
