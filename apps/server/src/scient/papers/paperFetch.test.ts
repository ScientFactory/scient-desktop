import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AccountsService } from "../accounts/AccountsService.ts";
import { fakeAccounts } from "../accounts/agent/AccountsService.testkit.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { fetchFromPage } from "./paperFetch.ts";
import { paperPageScript, type PaperPage } from "./paperPage.ts";

const PDF = new TextEncoder().encode("%PDF-1.7 fixture");
const DOWNLOAD = "/downloads/paper.pdf";
const scope = { threadId: ThreadId.make("thread-fixture"), projectId: undefined, unattended: true };

/** A browser showing one page, whose in-page download lands as a file. */
const browser = (page: Partial<PaperPage>) => {
  const operations: string[] = [];
  let downloaded = false;
  const shown: PaperPage = {
    url: "https://journal.example.org/article/1",
    title: "Article",
    status: 200,
    pdf: false,
    pdfUrl: null,
    login: false,
    challenge: false,
    institutionUrl: null,
    buy: false,
    ...page,
  };
  const answer = (operation: string, input: { readonly expression?: string }) => {
    if (operation === "open") return { tabId: "tab-1", downloads: [] };
    if (operation === "status")
      return { defaultProfileId: "main", downloads: downloaded ? [{ path: DOWNLOAD }] : [] };
    if (operation !== "evaluate") return undefined;
    if (input.expression === paperPageScript) return shown;
    if (input.expression === "window.__scientPaper") return downloaded ? "saved" : "working";
    downloaded = true;
    return true;
  };
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: { readonly operation: string; readonly input: unknown }) =>
      Effect.sync(() => {
        operations.push(request.operation);
        return answer(request.operation, request.input as { expression?: string }) as A;
      }),
  });
  return { broker, operations };
};

const fetchWith = (page: Partial<PaperPage>) => {
  const { broker, operations } = browser(page);
  return fetchFromPage({
    session: scope,
    url: "https://journal.example.org/article/1",
    profileId: undefined,
    signIn: () => undefined,
    accept: () => Effect.succeed(true),
  }).pipe(
    Effect.map((result) => ({ result, operations })),
    Effect.provideService(PreviewAutomationBroker, broker),
    Effect.provideService(AccountsService, fakeAccounts().service),
    Effect.provideService(AgentInvocationContext, {
      ...scope,
      environmentId: EnvironmentId.make("env-fixture"),
      providerSessionId: "session-fixture",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"] as const),
      issuedAt: 0,
    }),
    Effect.provide(
      FileSystem.layerNoop({
        readFile: (path) =>
          path === DOWNLOAD ? Effect.succeed(PDF) : Effect.die(`unexpected read of ${path}`),
      }),
    ),
  );
};

it.effect("saves a page that is already the PDF, and closes its tab", () =>
  Effect.gen(function* () {
    const { result, operations } = yield* fetchWith({ pdf: true });
    expect(result).toEqual({ status: "saved", bytes: PDF });
    expect(operations.at(-1)).toBe("close");
  }),
);

it.effect("stops at a sign-in it has no saved account for, and says so", () =>
  Effect.gen(function* () {
    const { result, operations } = yield* fetchWith({ login: true });
    expect(result).toMatchObject({
      status: "needs-sign-in",
      reason: "sign-in",
      openUrl: "https://journal.example.org/article/1",
      profileId: "main",
    });
    expect(operations.at(-1)).toBe("close");
  }),
);
