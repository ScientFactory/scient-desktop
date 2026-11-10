import { describe, expect, it } from "@effect/vitest";

import { inspectZotero } from "./ZoteroConnections.ts";
import type { ZoteroResponse } from "./ZoteroLibraryReader.ts";
import {
  inspectZoteroWebKey,
  makeZoteroWebLibrary,
  type ZoteroWebHttp,
  type ZoteroWebRequest,
} from "./ZoteroWebAdapter.ts";

const KEY = "synthetic-zotero-key";
const account = {
  userId: "475425",
  username: "ada",
  canRead: true,
  canWrite: true,
  canReadFiles: true,
};

function recordedHttp(answer: (request: ZoteroWebRequest) => ZoteroResponse) {
  const requests: ZoteroWebRequest[] = [];
  const http: ZoteroWebHttp = {
    request: async (request) => {
      requests.push(request);
      return answer(request);
    },
    download: async () => ({ status: 404 }),
  };
  return { http, requests };
}

const ok = (body: unknown, headers: Record<string, string> = {}): ZoteroResponse => ({
  status: 200,
  headers,
  body: JSON.stringify(body),
});

describe("Zotero web adapter", () => {
  it("keeps only the owner and permissions from the key check", async () => {
    const { http, requests } = recordedHttp(() =>
      ok({
        key: KEY,
        userID: 475425,
        username: "ada",
        access: { user: { library: true, files: true, write: false } },
      }),
    );

    const result = await inspectZoteroWebKey(KEY, http);

    expect(result).toEqual({
      state: "ready",
      account: { ...account, canWrite: false },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(requests[0]?.url.href).toBe("https://api.zotero.org/keys/current");
    expect(requests[0]?.headers["Zotero-API-Key"]).toBe(KEY);
  });

  it("reports a refused key without treating zotero.org as down", async () => {
    const { http } = recordedHttp(() => ({ status: 403, headers: {}, body: "Forbidden" }));

    expect(await inspectZoteroWebKey(KEY, http)).toEqual({ state: "rejected" });
  });

  it("reads the key owner's personal library", async () => {
    const { http, requests } = recordedHttp(() => ok([]));
    const library = makeZoteroWebLibrary({ apiKey: KEY, account, http });

    await library.transport.get("/items/top?limit=1");

    expect(requests[0]?.url.href).toBe("https://api.zotero.org/users/475425/items/top?limit=1");
    expect(requests[0]?.method).toBe("GET");
  });

  it("creates items with a write token and returns their keys in order", async () => {
    const { http, requests } = recordedHttp(() =>
      ok({
        successful: { "1": { key: "NEWB2345", version: 12 } },
        failed: { "0": { code: 400, message: "Invalid field" } },
      }),
    );
    const library = makeZoteroWebLibrary({ apiKey: KEY, account, http });

    const created = await library.createItems([{ itemType: "book" }, { itemType: "book" }], "t1");

    expect(created).toEqual([null, { key: "NEWB2345", version: 12 }]);
    expect(requests[0]?.headers["Zotero-Write-Token"]).toBe("t1");
  });

  it("refuses to overwrite an item changed in Zotero since it was read", async () => {
    const { http, requests } = recordedHttp(() => ({ status: 412, headers: {}, body: "" }));
    const library = makeZoteroWebLibrary({ apiKey: KEY, account, http });

    expect(await library.updateItem("ABCD2345", 7, { title: "New" })).toEqual({
      outcome: "changed",
    });
    expect(requests[0]?.headers["If-Unmodified-Since-Version"]).toBe("7");
  });
});

describe("Zotero connection choice", () => {
  const keyCheck = recordedHttp(() =>
    ok({ userID: 1, username: "ada", access: { user: { library: true } } }),
  );
  const unreachableLocal = async () => ({
    state: "unreachable" as const,
    apiVersion: null,
    message: "Open Zotero on the computer running this project, then check again.",
  });

  it("uses zotero.org when Zotero is not open here and Accounts has a key", async () => {
    const status = await inspectZotero({
      webKey: async () => "web-only-key",
      http: keyCheck.http,
      inspectLocal: unreachableLocal,
    });

    expect(status).toMatchObject({ state: "ready", connection: "web", canWrite: false });
  });

  it("explains the local setup when there is no key either", async () => {
    const status = await inspectZotero({
      webKey: async () => null,
      inspectLocal: unreachableLocal,
    });

    expect(status).toMatchObject({ state: "unreachable", connection: "local" });
  });

  it("prefers Zotero on this computer when it is ready", async () => {
    const status = await inspectZotero({
      webKey: async () => {
        throw new Error("The key must not be read while local Zotero is ready.");
      },
      inspectLocal: async () => ({ state: "ready", apiVersion: 3, message: "Ready." }),
    });

    expect(status).toMatchObject({ state: "ready", connection: "local" });
  });
});
