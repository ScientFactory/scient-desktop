import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request, runStream } from "@t3tools/client-runtime/rpc";
import { WS_METHODS, type DataProfileEvent, type EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { refreshProjectFiles } from "~/components/files/projectFilesQueryState";
import { connectionAtomRuntime } from "~/connection/runtime";

/** Pages are cached by the grid that shows them, so the query keeps nothing once read. */
export const dataFileTablePage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:data:read-file-table",
  tag: WS_METHODS.dataReadFileTable,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const computeTablePage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:compute:read-table",
  tag: WS_METHODS.computeReadTable,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
  },
});

export const dataViewPage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:data:read-view",
  tag: WS_METHODS.dataReadView,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const saveDataView = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:data:save-view",
  tag: WS_METHODS.dataSaveView,
  onSuccess: ({ environmentId, input }) =>
    Effect.sync(() => refreshProjectFiles(environmentId, input.cwd)),
});

export const materializeDataView = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:data:materialize-view",
  tag: WS_METHODS.dataMaterializeView,
  onSuccess: ({ environmentId, input }) =>
    Effect.sync(() => refreshProjectFiles(environmentId, input.cwd)),
});

export type ProfileTarget =
  | {
      readonly kind: "file";
      readonly input: EnvironmentRpcInput<typeof WS_METHODS.dataProfileFile>;
    }
  | {
      readonly kind: "view";
      readonly input: EnvironmentRpcInput<typeof WS_METHODS.dataProfileView>;
    }
  | {
      readonly kind: "variable";
      readonly input: EnvironmentRpcInput<typeof WS_METHODS.dataProfileVariable>;
    };

export const dataProfile = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:profile",
  execute: Effect.fn("profileData")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly target: ProfileTarget;
    readonly signal: AbortSignal;
    readonly onEvent: (event: DataProfileEvent) => void;
  }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const { target, signal, onEvent } = input;
    const stop = Effect.callback<void>((resume) => {
      if (signal.aborted) return resume(Effect.void);
      const abort = () => resume(Effect.void);
      signal.addEventListener("abort", abort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", abort));
    });
    const receive = (event: DataProfileEvent) => Effect.sync(() => onEvent(event));
    const profile = Effect.gen(function* () {
      switch (target.kind) {
        case "file":
          return yield* registry
            .runStream(input.environmentId, runStream(WS_METHODS.dataProfileFile, target.input))
            .pipe(Stream.runForEach(receive));
        case "view":
          return yield* registry
            .run(input.environmentId, request(WS_METHODS.dataProfileView, target.input))
            .pipe(Effect.flatMap((profile) => receive({ _tag: "Complete", profile })));
        case "variable":
          return yield* registry
            .run(input.environmentId, request(WS_METHODS.dataProfileVariable, target.input))
            .pipe(Effect.flatMap((profile) => receive({ _tag: "Complete", profile })));
      }
    });
    yield* Effect.raceFirst(profile, stop);
  }),
});
