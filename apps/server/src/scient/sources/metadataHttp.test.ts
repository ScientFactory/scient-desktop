import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  contactedRegistryRequest,
  makeMetadataRequest,
  METADATA_USER_AGENT,
  registryContactEmail,
  setRegistryContactEmail,
} from "./metadataHttp.ts";
import { startHttpTransport, truncateHttpResponse } from "./nodeHttpResponse.testkit.ts";

afterEach(() => setRegistryContactEmail(null));

const agent = { "User-Agent": METADATA_USER_AGENT };

describe("registry contact", () => {
  it("sends the contact email only to Crossref and OpenAlex, and nothing when unset", () => {
    const crossref = new URL("https://api.crossref.org/works/10.1000%2Fx");
    expect(contactedRegistryRequest(crossref, agent)).toEqual({ url: crossref, headers: agent });

    setRegistryContactEmail("ada@example.org");
    expect(registryContactEmail()).toBe("ada@example.org");
    const contacted = contactedRegistryRequest(crossref, agent);
    expect(contacted.url.searchParams.get("mailto")).toBe("ada@example.org");
    expect(contacted.headers["User-Agent"]).toMatch(
      /^Scient\/\d+\.\d+\.\d+ \(.*; mailto:ada@example\.org\)$/u,
    );
    expect(
      contactedRegistryRequest(
        new URL("https://api.openalex.org/works/W1"),
        agent,
      ).url.searchParams.get("mailto"),
    ).toBe("ada@example.org");

    for (const other of ["https://doi.org/10.1000/x", "https://eutils.ncbi.nlm.nih.gov/x"]) {
      const request = contactedRegistryRequest(new URL(other), agent);
      expect(request.url.href).toBe(other);
      expect(request.headers).toBe(agent);
    }
  });
});

describe("metadata HTTP completion", () => {
  it.each([200, 503, 302])(
    "rejects a truncated HTTP %s body before returning or following it",
    async (status) => {
      await using fixture = await startHttpTransport((request, response) => {
        request.resume();
        if (request.url === "/truncated") {
          if (status === 302) response.setHeader("Location", "https://registry.example/complete");
          truncateHttpResponse(response, status);
        } else response.end("complete");
      });
      const request = makeMetadataRequest(fixture.send);

      await expect(request(new URL("https://registry.example/truncated"), agent)).rejects.toThrow();
      expect(fixture.targets).toHaveLength(1);
      expect(await request(new URL("https://registry.example/complete"), agent)).toMatchObject({
        status: 200,
        body: "complete",
      });
    },
  );

  it.each([200, 503])("bounds an HTTP %s body even when it will be discarded", async (status) => {
    await using fixture = await startHttpTransport((request, response) => {
      request.resume();
      response.writeHead(status).end("too many bytes");
    });
    const request = makeMetadataRequest(fixture.send);

    await expect(
      request(new URL("https://registry.example/oversized"), agent, { maxBytes: 8 }),
    ).rejects.toThrow(/too much data/);
  });

  it("gives a request one budget across its redirects", async () => {
    const seen: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    await using fixture = await startHttpTransport((request, response) => {
      request.resume();
      seen.push(request.url ?? "");
      if (request.url === "/first") {
        response.writeHead(302, { Location: "https://registry.example/second" }).end();
      } else {
        // Hold the second hop open until the shared deadline signal aborts it.
        response.writeHead(200);
      }
    });
    const request = makeMetadataRequest((url, options, onResponse) => {
      signals.push(options.signal);
      return fixture.send(url, options, onResponse);
    });

    await expect(
      request(new URL("https://registry.example/first"), agent, {
        deadlineMs: 120,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("The metadata request timed out.");
    expect(seen).toEqual(["/first", "/second"]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBe(signals[0]);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("follows complete HTTPS redirects and still refuses plain HTTP before opening a socket", async () => {
    await using fixture = await startHttpTransport((request, response) => {
      request.resume();
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "https://registry.example/complete" }).end("redirect");
      } else response.end("complete");
    });
    const request = makeMetadataRequest(fixture.send);
    await expect(request(new URL("http://registry.example/complete"), agent)).rejects.toThrow(
      /HTTPS/,
    );
    expect(fixture.targets).toEqual([]);
    const response = await request(new URL("https://registry.example/redirect"), agent);
    expect(response).toMatchObject({ status: 200, body: "complete" });
    expect(response.url.href).toBe("https://registry.example/complete");
  });

  it("keeps an API key on the registry's origin and drops it on a redirect to another port or host", async () => {
    const received = new Map<string, Readonly<Record<string, string | string[] | undefined>>>();
    await using fixture = await startHttpTransport((request, response) => {
      request.resume();
      received.set(request.url ?? "", request.headers);
      if (request.url === "/same") {
        response.writeHead(302, { Location: "https://registry.example/other" }).end();
      } else if (request.url === "/other") {
        response.writeHead(302, { Location: "https://registry.example:8443/port" }).end();
      } else if (request.url === "/port") {
        response.writeHead(302, { Location: "https://mirror.example/final" }).end();
      } else response.end("complete");
    });
    const request = makeMetadataRequest(fixture.send);
    const response = await request(new URL("https://registry.example/same"), {
      ...agent,
      Accept: "application/json",
      "x-api-key": "secret",
    });
    expect(response).toMatchObject({ status: 200, body: "complete" });
    expect(received.get("/other")?.["x-api-key"]).toBe("secret");
    expect(received.get("/port")?.["x-api-key"]).toBeUndefined();
    expect(received.get("/final")?.["x-api-key"]).toBeUndefined();
    expect(received.get("/final")?.["user-agent"]).toBe(METADATA_USER_AGENT);
    expect(received.get("/final")?.accept).toBe("application/json");
  });
});
