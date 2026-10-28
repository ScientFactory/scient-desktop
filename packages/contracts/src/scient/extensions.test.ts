import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DiscoverEntry, ConnectorAddInput, ConnectorUpdateInput } from "./extensions.ts";

const decodeDiscover = Schema.decodeUnknownSync(DiscoverEntry);
const isDiscover = Schema.is(DiscoverEntry);
const decodesAdd = Schema.is(ConnectorAddInput);
const decodesUpdate = Schema.is(ConnectorUpdateInput);

describe("connector input text bounds", () => {
  const url = (length: number) => `https://example.com/${"m".repeat(length - 20)}`;

  it("accepts names, descriptions and URLs at their limits and refuses one more", () => {
    const at = {
      target: { type: "url", url: url(2_048) },
      displayName: "n".repeat(200),
      description: "d".repeat(1_000),
    };
    expect(at.target.url).toHaveLength(2_048);
    expect(decodesAdd(at)).toBe(true);
    expect(decodesAdd({ ...at, target: { type: "url", url: url(2_049) } })).toBe(false);
    expect(decodesAdd({ ...at, displayName: "n".repeat(201) })).toBe(false);
    expect(decodesAdd({ ...at, description: "d".repeat(1_001) })).toBe(false);
    expect(
      decodesAdd({
        target: { type: "registry", name: "r".repeat(201), version: "1", url: url(100) },
      }),
    ).toBe(false);
  });

  it("bounds a rename the same way", () => {
    expect(decodesUpdate({ connectorId: "con_abcdefgh", displayName: "n".repeat(200) })).toBe(true);
    expect(decodesUpdate({ connectorId: "con_abcdefgh", displayName: "n".repeat(201) })).toBe(
      false,
    );
  });
});

describe("curated setup metadata", () => {
  it("retains key and address requirements across decoding and rejects unknown strategies", () => {
    const entry = {
      name: "scient.curated/lab",
      version: "1",
      categories: ["biology"],
      remotes: [],
      installable: true,
      hosting: "Official",
      paidPlan: true,
      beta: true,
      accountRequired: true,
      apiKey: {
        strategy: "header",
        headerName: "X-API-Key",
        fieldLabel: "Lab key",
        helpUrl: "https://example.com/keys",
      },
      address: {
        urlTemplate: "https://<tenant>.mcp.example.com/mcp",
        fieldLabel: "Lab address",
        placeholder: "https://lab.mcp.example.com/mcp",
      },
    };
    expect(decodeDiscover(entry)).toEqual(entry);
    expect(isDiscover({ ...entry, apiKey: { ...entry.apiKey, strategy: "query" } })).toBe(false);
  });
});
