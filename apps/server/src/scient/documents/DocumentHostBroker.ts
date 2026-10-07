// SCIENT-FORK:START — document rendering owns a narrow desktop request rail.
import {
  ScientDocumentHostRequest,
  type PreviewAutomationError,
  type ScientDocumentHost,
  type ScientDocumentHostResponse,
  type ScientDocumentHostStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as PreviewBroker from "../../mcp/PreviewAutomationBroker.ts";

export const documentHostOperations = [
  "documentPdfRender",
  "documentPagePdfRender",
  "documentPdfPresent",
  "documentLatexPresent",
] as const;
type DocumentOperation = (typeof documentHostOperations)[number];
export type DocumentHostInvokeInput = Omit<
  PreviewBroker.PreviewAutomationInvokeInput,
  "operation" | "tabId" | "onTargetTab" | "updateCurrentTab"
> & { readonly operation: DocumentOperation };

export class DocumentHostBroker extends Context.Service<
  DocumentHostBroker,
  {
    readonly connect: (
      host: ScientDocumentHost,
    ) => Effect.Effect<Stream.Stream<ScientDocumentHostStreamEvent>>;
    readonly respond: (
      response: ScientDocumentHostResponse,
    ) => Effect.Effect<{ readonly accepted: boolean }, PreviewAutomationError>;
    readonly invoke: <A = unknown>(
      input: DocumentHostInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
  }
>()("t3/scient/documents/DocumentHostBroker") {}

export const layer = Layer.effect(
  DocumentHostBroker,
  Effect.gen(function* () {
    // Reuse the lease implementation with independently acquired state. Browser
    // and document hosts have different physical capabilities and cannot share
    // one provider-session assignment, pending queue, or connection generation.
    const broker = yield* PreviewBroker.make;
    const clientKey = (clientId: string) => `scient-documents:${clientId}`;
    return DocumentHostBroker.of({
      connect: (host) =>
        broker
          .connect({
            ...host,
            clientId: clientKey(host.clientId),
            supportedOperations: (host.supportedOperations ?? documentHostOperations).filter(
              (operation) => documentHostOperations.includes(operation),
            ),
          })
          .pipe(
            Effect.map((events) =>
              events.pipe(
                Stream.mapEffect((event): Effect.Effect<ScientDocumentHostStreamEvent> => {
                  if (event.type === "connected") return Effect.succeed(event);
                  return Schema.decodeUnknownEffect(ScientDocumentHostRequest)(event.request).pipe(
                    // Requests originate in decoded Scient document tools. A mismatched broker event
                    // is a broken server invariant and must never reach the document renderer.
                    Effect.orDie,
                    Effect.map((request) => ({
                      type: "request" as const,
                      connectionId: event.connectionId,
                      request,
                    })),
                  );
                }),
              ),
            ),
          ),
      respond: (response) =>
        broker
          .respond({ ...response, clientId: clientKey(response.clientId) })
          .pipe(Effect.as({ accepted: true })),
      invoke: (input) =>
        Effect.suspend(() => {
          if (!documentHostOperations.some((operation) => operation === input.operation)) {
            return Effect.die(
              new Error(`Unsupported Scient document operation: ${input.operation}`),
            );
          }
          return broker.invoke(input);
        }),
    });
  }),
);
// SCIENT-FORK:END
