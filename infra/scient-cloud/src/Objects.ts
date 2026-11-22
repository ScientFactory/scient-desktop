import type * as Workers from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface StoredObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

/** The bucket. Bodies are streamed; `length` is the exact byte count of `body`. */
export class Objects extends Context.Service<
  Objects,
  {
    readonly put: (
      key: string,
      body: ReadableStream<Uint8Array>,
      length: number,
    ) => Effect.Effect<void>;
    readonly get: (key: string) => Effect.Effect<StoredObject | undefined>;
    readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("@scientfactory/scient-cloud-worker/Objects") {}

/** R2 needs a stream of known length; `FixedLengthStream` also checks the count. */
export const r2Objects = (bucket: Workers.R2Bucket): Objects["Service"] => ({
  put: (key, body, length) =>
    Effect.promise(() =>
      bucket.put(
        key,
        body.pipeThrough(new FixedLengthStream(length)) as unknown as Workers.ReadableStream,
      ),
    ).pipe(Effect.asVoid),
  get: (key) =>
    Effect.promise(() => bucket.get(key)).pipe(
      Effect.map((object) =>
        object === null
          ? undefined
          : { body: object.body as unknown as ReadableStream<Uint8Array>, size: object.size },
      ),
    ),
  delete: (keys) =>
    keys.length === 0
      ? Effect.void
      : Effect.promise(async () => {
          // R2 deletes at most 1000 keys per call.
          for (let index = 0; index < keys.length; index += 1000) {
            await bucket.delete(keys.slice(index, index + 1000));
          }
        }),
});

export const readAll = async (body: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(body).arrayBuffer());

/** For tests and the local dev server. */
export const memoryObjects = (store = new Map<string, Uint8Array>()): Objects["Service"] => ({
  put: (key, body, length) =>
    Effect.promise(async () => {
      const bytes = await readAll(body);
      if (bytes.length !== length) throw new Error(`Length mismatch for ${key}`);
      store.set(key, bytes);
    }),
  get: (key) =>
    Effect.sync(() => {
      const bytes = store.get(key);
      if (bytes === undefined) return undefined;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        size: bytes.length,
      };
    }),
  delete: (keys) =>
    Effect.sync(() => {
      for (const key of keys) store.delete(key);
    }),
});
