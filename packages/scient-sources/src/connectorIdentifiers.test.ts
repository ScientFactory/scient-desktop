import { describe, expect, it } from "@effect/vitest";

import { canonicalConnectorIdentifier } from "./connectorIdentifiers.ts";
import { detectSourceIdentifier, SOURCE_ADD_IDENTIFIER_SCHEMES } from "./identifierInput.ts";

const S2 = "649def34f8be52c8b66281af98ae884c09aef38b";

describe("connector identifiers", () => {
  it.each([
    ["W2741809807", "openalex", "W2741809807"],
    ["https://openalex.org/W2741809807", "openalex", "W2741809807"],
    ["https://api.openalex.org/works/w2741809807", "openalex", "W2741809807"],
    [
      `https://www.semanticscholar.org/paper/Attention-is-All-you-Need/${S2.toUpperCase()}`,
      "s2",
      S2,
    ],
    [`s2:${S2}`, "s2", S2],
    ["CorpusId:13756489", "s2", "CorpusId:13756489"],
  ])("reads %s as a %s identifier", (text, scheme, value) => {
    expect(detectSourceIdentifier(text)).toEqual({ scheme, value });
  });

  it("checks registry identifiers before catalogue ones", () => {
    expect(SOURCE_ADD_IDENTIFIER_SCHEMES.slice(-2)).toEqual(["openalex", "s2"]);
    expect(detectSourceIdentifier("10.1038/s41586-020-2649-2")?.scheme).toBe("doi");
  });

  it("keeps an agent's spelling of a connector ID to one canonical form", () => {
    expect(canonicalConnectorIdentifier("openalex", " openalex:w123456 ")).toBe("W123456");
    expect(canonicalConnectorIdentifier("s2", "corpusid:42")).toBe("CorpusId:42");
    expect(canonicalConnectorIdentifier("openalex", "not an id")).toBeNull();
  });
});
