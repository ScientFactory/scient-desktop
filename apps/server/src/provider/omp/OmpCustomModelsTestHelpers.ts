// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalFetchInEffect:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";

import type { OmpRpcProcessOptions } from "./OmpRpcProcess.ts";

interface RegisteredModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly input?: ReadonlyArray<string>;
}

interface ModelsBody {
  readonly generation: number;
  readonly connections: ReadonlyArray<{
    readonly id: string;
    readonly models: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly input?: ReadonlyArray<string>;
    }>;
  }>;
}

/**
 * The protocol side of Scient's generated OMP extension, driven by a test:
 * load the models, acknowledge a generation, and long-poll for a newer one.
 * `watch()` runs the same loop the real extension runs.
 */
/**
 * Reads, then deletes like OMP does, the bootstrap of the last `--extension`
 * a launch passes: the custom-model extension, which the factory appends.
 */
export const consumeOmpModelsBootstrap = (options: OmpRpcProcessOptions) => {
  const extension = options.extraArgs?.at(-1);
  if (!extension) throw new Error("custom-model extension was not configured");
  const embedded = /\bSCIENT_BOOTSTRAP_PATH = ("(?:[^"\\]|\\.)*");/u.exec(
    NodeFS.readFileSync(extension, "utf8"),
  )?.[1];
  if (!embedded) throw new Error("custom-model extension does not name its bootstrap");
  const bootstrapPath = JSON.parse(embedded) as string;
  const bootstrap = JSON.parse(NodeFS.readFileSync(bootstrapPath, "utf8")) as {
    readonly url?: string;
    readonly token?: string;
    readonly keys?: Readonly<Record<string, string>>;
  };
  NodeFS.rmSync(bootstrapPath);
  return { bootstrapPath, ...bootstrap };
};

export const makeFakeOmpModelsExtension = (options: OmpRpcProcessOptions) => {
  const { url, token } = consumeOmpModelsBootstrap(options);
  if (!url || !token) throw new Error("custom-model endpoint was not configured");
  const headers = { authorization: `Bearer ${token}` };
  const stopped = new AbortController();
  let registered: ReadonlyArray<RegisteredModel> = [];
  let applied = 0;
  const load = async (): Promise<ModelsBody> => {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`custom-model endpoint returned ${response.status}`);
    return (await response.json()) as ModelsBody;
  };
  const register = (body: ModelsBody) => {
    registered = body.connections.flatMap((connection) =>
      connection.models.map((model) => ({
        provider: connection.id,
        id: model.id,
        name: model.name,
        ...(model.input ? { input: model.input } : {}),
      })),
    );
    applied = Math.max(applied, body.generation);
  };
  const acknowledge = async (generation: number, error?: string): Promise<number> => {
    const response = await fetch(`${url}/applied`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(error === undefined ? { generation } : { generation, error }),
    });
    return response.status;
  };
  const wait = async (after: number) => {
    const response = await fetch(`${url}/wait?after=${after}`, {
      headers,
      signal: stopped.signal,
    });
    return {
      status: response.status,
      generation: response.ok
        ? ((await response.json()) as { readonly generation: number }).generation
        : undefined,
    };
  };
  const refresh = async () => {
    const body = await load();
    register(body);
    await acknowledge(body.generation);
  };
  const watch = async () => {
    while (!stopped.signal.aborted) {
      try {
        const next = await wait(applied);
        if (next.status === 503 || next.status === 403) return;
        if (next.generation !== undefined && next.generation > applied) await refresh();
      } catch {
        if (stopped.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  };
  return {
    url,
    headers,
    load,
    register,
    acknowledge,
    wait,
    refresh,
    /** Start the extension's background loop, after the initial refresh. */
    start: async () => {
      await refresh();
      void watch();
    },
    stop: () => stopped.abort(),
    models: () => registered,
    applied: () => applied,
  };
};
