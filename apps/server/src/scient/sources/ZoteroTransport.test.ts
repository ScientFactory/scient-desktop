// @effect-diagnostics nodeBuiltinImport:off -- Real HTTP sockets and disposable synthetic files exercise transport lifetimes.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { startHttpTransport, truncateHttpResponse } from "./nodeHttpResponse.testkit.ts";
import type { ZoteroRawItem } from "./ZoteroItems.ts";
import { makeLocalZoteroRequest } from "./ZoteroLocalAdapter.ts";
import { makeNodeZoteroWebHttp, makeZoteroWebLibrary } from "./ZoteroWebAdapter.ts";

const apiUrl = (path: string) => new URL(path, "https://api.zotero.org");
const headers = { "Zotero-API-Key": "synthetic-zotero-key" };

async function temporaryDirectory() {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-http-test-"));
  return {
    path,
    [Symbol.asyncDispose]: () => NodeFSP.rm(path, { recursive: true, force: true }),
  };
}

const attachment: ZoteroRawItem = {
  key: "ABCDEFGH",
  version: 1,
  library: { type: "user", id: 42 },
  data: {
    key: "ABCDEFGH",
    version: 1,
    itemType: "attachment",
    filename: "synthetic.pdf",
    contentType: "application/pdf",
    linkMode: "imported_file",
    url: "https://untrusted-item.example/never-a-download-target",
  },
};

const account = {
  userId: "42",
  username: "synthetic",
  canRead: true,
  canWrite: true,
  canReadFiles: true,
  groupAccess: {},
};

describe("Zotero Node HTTP completion", () => {
  it.each(["local", "web"] as const)(
    "rejects a truncated %s response and permits the next request",
    async (kind) => {
      await using fixture = await startHttpTransport((request, response) => {
        request.resume();
        if (request.url === "/api/truncated") truncateHttpResponse(response);
        else response.end("complete");
      });
      const read =
        kind === "local"
          ? makeLocalZoteroRequest(fixture.send)
          : (path: string) =>
              makeNodeZoteroWebHttp(fixture.send).request({
                method: "GET",
                url: apiUrl(path),
                headers,
              });

      await expect(read("/api/truncated")).rejects.toThrow();
      expect((await read("/api/complete")).body).toBe("complete");
      expect(fixture.targets.map((target) => target.hostname)).toEqual([
        kind === "local" ? "127.0.0.1" : "api.zotero.org",
        kind === "local" ? "127.0.0.1" : "api.zotero.org",
      ]);
    },
  );

  it.each(["local", "web"] as const)(
    "bounds %s response bytes and permits the next request",
    async (kind) => {
      await using fixture = await startHttpTransport((request, response) => {
        request.resume();
        response.end(
          request.url === "/api/oversized" ? Buffer.alloc(8 * 1024 * 1024 + 1, 120) : "complete",
        );
      });
      const read =
        kind === "local"
          ? makeLocalZoteroRequest(fixture.send)
          : (path: string) =>
              makeNodeZoteroWebHttp(fixture.send).request({
                method: "GET",
                url: apiUrl(path),
                headers,
              });

      await expect(read("/api/oversized")).rejects.toThrow(/more data/);
      expect((await read("/api/complete")).body).toBe("complete");
    },
  );

  it("closes a truncated PDF before removing its temporary directory and can download again", async () => {
    await using directory = await temporaryDirectory();
    let downloads = 0;
    await using fixture = await startHttpTransport((request, response) => {
      request.resume();
      downloads += 1;
      if (downloads === 1) truncateHttpResponse(response);
      else response.end("%PDF-synthetic-complete");
    });
    const { transport } = makeZoteroWebLibrary({
      apiKey: headers["Zotero-API-Key"],
      account,
      http: makeNodeZoteroWebHttp(fixture.send),
      temporaryDirectory: directory.path,
    });

    await expect(transport.attachmentFile(attachment)).rejects.toThrow();
    expect(await NodeFSP.readdir(directory.path)).toEqual([]);
    const downloaded = await transport.attachmentFile(attachment);
    expect(downloaded).not.toBeNull();
    expect(await NodeFSP.readFile(downloaded!.path, "utf8")).toBe("%PDF-synthetic-complete");
    await downloaded!.release();
    expect(await NodeFSP.readdir(directory.path)).toEqual([]);
    expect(fixture.targets.map((target) => target.href)).toEqual([
      "https://api.zotero.org/users/42/items/ABCDEFGH/file",
      "https://api.zotero.org/users/42/items/ABCDEFGH/file",
    ]);
  });

  it("rejects truncated and oversized upload replies without poisoning a subsequent upload", async () => {
    await using directory = await temporaryDirectory();
    const path = NodePath.join(directory.path, "synthetic.pdf");
    await NodeFSP.writeFile(path, "file-bytes");
    const uploaded: string[] = [];
    await using fixture = await startHttpTransport((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        uploaded.push(Buffer.concat(chunks).toString("utf8"));
        if (request.url === "/truncated") truncateHttpResponse(response);
        else if (request.url === "/oversized") response.end(Buffer.alloc(8 * 1024 * 1024 + 1));
        else response.writeHead(201).end("accepted");
      });
    });
    const http = makeNodeZoteroWebHttp(fixture.send);
    const body = { path, prefix: "prefix:", suffix: ":suffix" };

    await expect(
      http.upload(new URL("https://storage.example/truncated"), "application/pdf", body),
    ).rejects.toThrow();
    await expect(
      http.upload(new URL("https://storage.example/oversized"), "application/pdf", body),
    ).rejects.toThrow(/more data/);
    await expect(
      http.upload(new URL("https://storage.example/complete"), "application/pdf", body),
    ).resolves.toBe(201);
    expect(uploaded).toEqual(Array(3).fill("prefix:file-bytes:suffix"));
    await NodeFSP.rm(path);
  });

  it("stops and closes the upload file when the response disconnects before receiving it", async () => {
    await using directory = await temporaryDirectory();
    const path = NodePath.join(directory.path, "synthetic.pdf");
    await NodeFSP.writeFile(path, "");
    await NodeFSP.truncate(path, 16 * 1024 * 1024);
    const requestClosed = Promise.withResolvers<boolean>();
    const responseStarted = Promise.withResolvers<void>();
    await using fixture = await startHttpTransport((request, response) => {
      request.once("close", () => requestClosed.resolve(request.complete));
      response.writeHead(200, { "Content-Length": "128", Connection: "close" });
      response.write('{"partial":');
      // Deliver the response first, then fully disconnect the unread upload socket.
      void responseStarted.promise.then(() => request.destroy());
    });
    const http = makeNodeZoteroWebHttp((url, options, onResponse) =>
      fixture.send(url, options, (response) => {
        onResponse(response);
        responseStarted.resolve();
      }),
    );

    await expect(
      http.upload(new URL("https://storage.example/early-disconnect"), "application/pdf", {
        path,
        prefix: "prefix:",
        suffix: ":suffix",
      }),
    ).rejects.toThrow();
    expect(await requestClosed.promise).toBe(false);
    await NodeFSP.rm(path);
  });

  it("retains service restrictions and strips the API key from storage redirects", async () => {
    await using directory = await temporaryDirectory();
    const receivedKeys: Array<string | string[] | undefined> = [];
    await using fixture = await startHttpTransport((request, response) => {
      request.resume();
      receivedKeys.push(request.headers["zotero-api-key"]);
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "https://storage.example/complete" }).end();
      } else response.end("%PDF-complete");
    });
    const http = makeNodeZoteroWebHttp(fixture.send);
    await expect(
      http.request({ method: "GET", url: new URL("https://other.example/items"), headers }),
    ).rejects.toThrow(/api\.zotero\.org/);
    await expect(
      http.request({ method: "GET", url: new URL("http://api.zotero.org/items"), headers }),
    ).rejects.toThrow(/api\.zotero\.org/);
    await expect(makeLocalZoteroRequest(fixture.send)("/outside-api")).rejects.toThrow(/local API/);
    await expect(makeLocalZoteroRequest(fixture.send)("/api/../../outside-api")).rejects.toThrow(
      /local API/,
    );
    const destination = NodePath.join(directory.path, "download.pdf");
    await expect(
      http.download(new URL("http://storage.example/file"), headers, destination),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      http.upload(new URL("http://storage.example/file"), "application/pdf", {
        path: "never-opened",
        prefix: "",
        suffix: "",
      }),
    ).rejects.toThrow(/HTTPS/);
    expect(fixture.targets).toEqual([]);

    await expect(http.download(apiUrl("/redirect"), headers, destination)).resolves.toEqual({
      status: 200,
    });
    expect(receivedKeys).toEqual(["synthetic-zotero-key", undefined]);
    expect(await NodeFSP.readFile(destination, "utf8")).toBe("%PDF-complete");
  });
});
