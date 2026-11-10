import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { makeAnnotationCoordinator } from "./AnnotationCoordinator.ts";

export const scientAnnotationsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientAnnotations",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* SessionStore;
    function handle<A>(
      endpoint: string,
      write: boolean,
      run: (coordinator: ReturnType<typeof makeAnnotationCoordinator>) => Promise<A>,
    ) {
      return Effect.gen(function* () {
        yield* annotateEnvironmentRequest(endpoint);
        yield* requireEnvironmentScope(
          write ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
        );
        const principal = yield* EnvironmentAuthenticatedPrincipal;
        const coordinator = makeAnnotationCoordinator({
          previewRoot: process.env.SCIENT_ANNOTATIONS_PREVIEW_ROOT,
          authority: {
            principal: principal.subject,
            generation: principal.sessionId,
            check: () => Effect.runPromise(sessions.checkActive(principal.sessionId)),
            publish: (operation) =>
              Effect.runPromise(
                sessions.withActiveSession(principal.sessionId, Effect.tryPromise(operation)),
              ),
          },
        });
        return yield* Effect.tryPromise(() => run(coordinator)).pipe(
          Effect.catch((cause) =>
            failEnvironmentInternal("scient_annotations_operation_failed", cause),
          ),
        );
      });
    }
    return handlers
      .handle("open", (args) =>
        handle(args.endpoint.name, false, (c) => c.document(args.payload, false)),
      )
      .handle("prepare", (args) =>
        handle(args.endpoint.name, true, (c) => c.document(args.payload, true)),
      )
      .handle("mutate", (args) => handle(args.endpoint.name, true, (c) => c.mutate(args.payload)))
      .handle("material", (args) =>
        handle(args.endpoint.name, false, (c) => c.material(args.payload)),
      );
  }),
);
