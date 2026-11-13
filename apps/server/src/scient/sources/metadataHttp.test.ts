import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  contactedRegistryRequest,
  METADATA_USER_AGENT,
  registryContactEmail,
  setRegistryContactEmail,
} from "./metadataHttp.ts";

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
