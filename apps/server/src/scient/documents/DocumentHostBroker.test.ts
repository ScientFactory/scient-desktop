import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PreviewBroker from "../../mcp/PreviewAutomationBroker.ts";
import * as DocumentBroker from "./DocumentHostBroker.ts";

const scope = {
  environmentId: EnvironmentId.make("environment:separate-hosts"),
  threadId: ThreadId.make("thread:separate-hosts"),
  providerSessionId: "provider-session:separate-hosts",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview", "documents:build"] as const),
  issuedAt: 1,
};

it.effect.each(
  (["browser-first", "document-first"] as const).map((order) => ({
    caseTitle: `keeps browser and document leases independent (${order})`,
    order,
  })),
)("$caseTitle", ({ order }) =>
  Effect.gen(function* () {
    const browser = yield* PreviewBroker.PreviewAutomationBroker;
    const documents = yield* DocumentBroker.DocumentHostBroker;
    const routed: string[] = [];
    const browserReady = yield* Deferred.make<void>();
    const documentsReady = yield* Deferred.make<void>();
    const browserEvents = yield* browser.connect({
      clientId: "physical-browser",
      environmentId: scope.environmentId,
      supportedOperations: ["open"],
    });
    const documentEvents = yield* documents.connect({
      clientId: "physical-documents",
      environmentId: scope.environmentId,
      supportedOperations: ["documentPdfRender"],
    });
    yield* Stream.runForEach(browserEvents, (event) => {
      if (event.type === "connected")
        return Deferred.succeed(browserReady, undefined).pipe(Effect.asVoid);
      routed.push("browser");
      return browser
        .respond({
          clientId: "physical-browser",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: { browser: true },
        })
        .pipe(Effect.asVoid);
    }).pipe(Effect.forkScoped);
    yield* Stream.runForEach(documentEvents, (event) => {
      if (event.type === "connected")
        return Deferred.succeed(documentsReady, undefined).pipe(Effect.asVoid);
      routed.push("document");
      expect(event.request.operation).toBe("documentPdfRender");
      return documents
        .respond({
          clientId: "physical-documents",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: { document: true },
        })
        .pipe(Effect.asVoid);
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(browserReady);
    yield* Deferred.await(documentsReady);
    const browse = browser.invoke({ scope, operation: "open", input: {} });
    const render = documents.invoke({
      scope,
      operation: "documentPdfRender",
      input: { assetRelativeUrl: "/api/document-source/test" },
    });
    if (order === "browser-first") {
      yield* browse;
      yield* render;
    } else {
      yield* render;
      yield* browse;
    }
    // Existing affinity survives the other domain's request.
    yield* browse;
    yield* render;
    expect(routed).toEqual(
      order === "browser-first"
        ? ["browser", "document", "browser", "document"]
        : ["document", "browser", "browser", "document"],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(PreviewBroker.layer, DocumentBroker.layer).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
