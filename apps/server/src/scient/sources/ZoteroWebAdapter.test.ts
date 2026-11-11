import { describe, expect, it } from "@effect/vitest";

import { inspectZotero, listZoteroGroups, zoteroTransport } from "./ZoteroConnections.ts";
import type { ZoteroResponse } from "./ZoteroLibraryReader.ts";
import { betterBibTexLibraryId, localZoteroGroupsFrom } from "./ZoteroLocalAdapter.ts";
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
  groupAccess: {},
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

  it("lists the groups the key can read, writable only where the group lets the user edit", async () => {
    const { http, requests } = recordedHttp((request) =>
      request.url.pathname === "/keys/current"
        ? ok({
            userID: 475425,
            access: {
              user: { library: true },
              groups: { all: { library: true, write: true }, "33": { library: false } },
            },
          })
        : ok(
            [
              { id: 11, data: { name: "Lab", libraryEditing: "members" } },
              { id: 22, data: { name: "Admins only", libraryEditing: "admins", owner: 9 } },
              { id: 33, data: { name: "Hidden from the key" } },
            ],
            { "total-results": "3" },
          ),
    );

    const groups = await listZoteroGroups({ webKey: async () => KEY, http }, "web", {
      fresh: true,
    });

    expect(groups).toEqual([
      { groupId: "11", name: "Lab", canWrite: true },
      { groupId: "22", name: "Admins only", canWrite: false },
    ]);
    expect(requests[1]?.url.pathname).toBe("/users/475425/groups");
    const library = makeZoteroWebLibrary({ apiKey: KEY, account, groupId: "11", http });
    await library.transport.get("/items/top");
    expect(requests[2]?.url.href).toBe("https://api.zotero.org/groups/11/items/top");
  });

  it("reads the groups Zotero on this computer syncs and their Better BibTeX library", () => {
    const body = JSON.stringify({ data: [{ id: 11, data: { name: "Lab" } }, { id: 0 }] });

    expect(localZoteroGroupsFrom(body)).toEqual([{ groupId: "11", name: "Lab", canWrite: false }]);
    const libraries = (names: string[]) =>
      JSON.stringify({ result: names.map((name, index) => ({ id: index + 1, name })) });
    expect(betterBibTexLibraryId(libraries(["My Library", "Lab"]), "Lab")).toBe(2);
    expect(betterBibTexLibraryId(libraries(["Lab", "Lab"]), "Lab")).toBeNull();
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

  it("works with a key that reads groups but not My Library", async () => {
    const { http, requests } = recordedHttp((request) =>
      request.url.pathname === "/keys/current"
        ? ok({
            userID: 475425,
            access: { user: { library: false }, groups: { all: { library: true } } },
          })
        : ok([{ id: 11, data: { name: "Lab" } }], { "total-results": "1" }),
    );
    const access = { webKey: async () => "groups-only-key", http };

    expect(await inspectZotero(access, "web")).toMatchObject({
      state: "ready",
      canWrite: false,
      myLibrary: false,
    });
    expect(await listZoteroGroups(access, "web")).toEqual([
      { groupId: "11", name: "Lab", canWrite: false },
    ]);
    await expect(zoteroTransport(access, "web")).rejects.toThrow("cannot read My Library");
    await (await zoteroTransport(access, "web", "11")).get("/items/top");
    expect(requests.at(-1)?.url.href).toBe("https://api.zotero.org/groups/11/items/top");
  });

  it("refuses a key that reads no library at all", async () => {
    const { http } = recordedHttp(() => ok({ userID: 475425, access: { user: {} } }));

    expect(
      await inspectZotero({ webKey: async () => "reads-nothing-key", http }, "web"),
    ).toMatchObject({ state: "access-disabled" });
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
