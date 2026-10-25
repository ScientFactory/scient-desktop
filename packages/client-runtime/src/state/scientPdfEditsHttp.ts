import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ScientPdfEditSourceJson, type ScientPdfEditSaveResult } from "@t3tools/contracts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const encodePdfEditSource = Schema.encodeEffect(ScientPdfEditSourceJson);

export const saveEnvironmentPdfEdit = Effect.fn("clientRuntime.state.saveEnvironmentPdfEdit")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly source: ScientPdfEditSaveResult["source"];
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly bytes: Uint8Array;
  }) {
    const payload = new FormData();
    payload.append("source", yield* encodePdfEditSource(input.source));
    payload.append("expectedRevision", input.expectedRevision);
    payload.append("operationId", input.operationId);
    payload.append(
      "file",
      new Blob([new Uint8Array(input.bytes)], { type: "application/pdf" }),
      input.source.fileName,
    );
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
      method: "POST",
      url: (urls) => urls.save(),
      timeoutMs: 120_000,
      group: "scientPdf",
      request: ({ client, headers }) => client.save({ headers, payload }),
    });
  },
);
