import {
  CloudErrorBody,
  CloudLimits,
  cloudPaths,
  ComputerListResponse,
  ComputerNonceResponse,
  ComputerRecord,
  CreateShareResponse,
  LEASE_GENERATION_HEADER,
  SCIENT_CLOUD_ORIGIN,
  ShareListResponse,
  ShareRecord,
  ThreadIndexResponse,
  type CloudConversation,
  type CreateShareRequest,
  type EnrollComputerRequest,
  type PatchShareRequest,
} from "@scientfactory/scient-cloud/api";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { decodeCloudConversation } from "./cloudConversationCodec";

/** The cloud API. Local development points it at a Worker with `VITE_SCIENT_CLOUD_URL`. */
function cloudApiOrigin(): string {
  const configured = (import.meta.env.VITE_SCIENT_CLOUD_URL as string | undefined)?.trim();
  return configured || SCIENT_CLOUD_ORIGIN;
}

export class CloudApiError extends Schema.TaggedError<CloudApiError>()("CloudApiError", {
  status: Schema.Number,
  code: Schema.Union([CloudErrorBody.fields.error, Schema.Literals(["network", "unknown"])]),
  message: Schema.String,
  movedTo: Schema.NullOr(Schema.String),
}) {}

function cloudError(
  status: number,
  code: CloudApiError["code"],
  message: string,
  movedTo: string | null = null,
) {
  return new CloudApiError({ status, code, message, movedTo });
}

const decodeErrorBody = Schema.decodeUnknownOption(CloudErrorBody);

export type CloudTokenReader = () => Promise<string | null>;

async function send(
  readToken: CloudTokenReader,
  path: string,
  init: { method?: string; json?: unknown; body?: BodyInit } = {},
): Promise<Response> {
  const token = await readToken();
  if (token === null) throw cloudError(401, "unauthorized", "Sign in to Scient to continue.");
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, cloudApiOrigin()), {
      method: init.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw cloudError(0, "network", "Scient Cloud can't be reached right now.");
  }
  if (response.ok) return response;
  const parsed = decodeErrorBody(await response.json().catch(() => null));
  if (parsed._tag === "Some") {
    throw cloudError(
      response.status,
      parsed.value.error,
      parsed.value.message,
      parsed.value.movedTo ?? null,
    );
  }
  throw cloudError(response.status, "unknown", "Scient Cloud couldn't finish that.");
}

async function json<S extends Schema.Top>(schema: S, response: Response): Promise<S["Type"]> {
  return Schema.decodeUnknownSync(schema as never)(await response.json()) as S["Type"];
}

/** Everything the person's renderer asks the cloud with their own session. */
export function cloudApi(readToken: CloudTokenReader) {
  return {
    limits: async () => json(CloudLimits, await send(readToken, cloudPaths.limits())),
    computers: async () =>
      (await json(ComputerListResponse, await send(readToken, cloudPaths.computers()))).computers,
    computerNonce: async () =>
      (
        await json(
          ComputerNonceResponse,
          await send(readToken, cloudPaths.computerNonce(), { method: "POST" }),
        )
      ).nonce,
    enrollComputer: async (request: EnrollComputerRequest) =>
      json(
        ComputerRecord,
        await send(readToken, cloudPaths.computers(), { method: "POST", json: request }),
      ),
    removeComputer: async (environmentId: string) => {
      await send(readToken, cloudPaths.computer(environmentId), { method: "DELETE" });
    },
    threads: async () =>
      (await json(ThreadIndexResponse, await send(readToken, cloudPaths.threads()))).threads,
    thread: async (environmentId: string, threadId: string): Promise<CloudConversation> =>
      decodeCloudConversation(
        new Uint8Array(
          await (await send(readToken, cloudPaths.thread(environmentId, threadId))).arrayBuffer(),
        ),
      ),
    /** Continues the conversation on `to`: the cloud moves the lease and returns the copy. */
    lease: async (environmentId: string, threadId: ThreadId | string, to: EnvironmentId) => {
      const response = await send(readToken, cloudPaths.threadLease(environmentId, threadId), {
        method: "POST",
        json: { to },
      });
      const generation = Number(response.headers.get(LEASE_GENERATION_HEADER));
      const conversation = await decodeCloudConversation(
        new Uint8Array(await response.arrayBuffer()),
      );
      return { generation: Number.isSafeInteger(generation) ? generation : 0, conversation };
    },
    blob: async (sha256: string) => (await send(readToken, cloudPaths.blob(sha256))).blob(),
    shares: async () =>
      (await json(ShareListResponse, await send(readToken, cloudPaths.shares()))).shares,
    createShare: async (request: CreateShareRequest) =>
      (
        await json(
          CreateShareResponse,
          await send(readToken, cloudPaths.shares(), { method: "POST", json: request }),
        )
      ).id,
    putShareObject: async (id: string, version: number, object: string, bytes: Uint8Array) => {
      await send(readToken, cloudPaths.shareObject(id, version, object), {
        method: "PUT",
        body: new Blob([Uint8Array.from(bytes)]),
      });
    },
    publishShare: async (id: string, version: number) => {
      await send(readToken, cloudPaths.sharePublish(id, version), { method: "POST" });
    },
    updateShare: async (id: string, patch: PatchShareRequest) =>
      json(
        ShareRecord,
        await send(readToken, cloudPaths.share(id), { method: "PATCH", json: patch }),
      ),
    deleteShare: async (id: string) => {
      await send(readToken, cloudPaths.share(id), { method: "DELETE" });
    },
  };
}

export type CloudApi = ReturnType<typeof cloudApi>;
