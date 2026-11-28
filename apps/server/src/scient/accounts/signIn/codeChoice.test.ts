import { describe, expect, it } from "vite-plus/test";
import type { CodeCandidate } from "./messageCodes.ts";
import { chooseCode, chooseCodeFor } from "./codeChoice.ts";

const requestedAt = Date.UTC(2026, 10, 26, 10);
const code = (key: string, digits: string, fields: Partial<CodeCandidate> = {}): CodeCandidate => ({
  key,
  code: digits,
  source: key.startsWith("mail") ? "mail" : "messages",
  at: requestedAt + 5_000,
  sender: "32665",
  toAccount: undefined,
  ...fields,
});
const sure: Parameters<typeof chooseCode>[1] = {
  used: new Set<string>(),
  alone: true,
  requestedAt,
  confirmed: new Set(["32665", "no-reply@example.com"]),
};
const automatic = (candidates: ReadonlyArray<CodeCandidate>, context = sure) =>
  chooseCode(candidates, context).automatic?.code;

describe("which found code goes in by itself", () => {
  const mailed = (key: string, digits: string, fields: Partial<CodeCandidate> = {}) =>
    code(key, digits, { sender: "no-reply@example.com", toAccount: true, ...fields });

  it("only a certain one: after the request, from a known sender, to this login, alone", () => {
    expect(automatic([mailed("mail:1", "111111")])).toBe("111111");
    // The same code by text and by mail is still one code, and the mailed copy binds it.
    expect(automatic([code("messages:1", "111111"), mailed("mail:1", "111111")])).toBe("111111");
  });

  it("never inserts a texted code by itself: a text doesn't say which login it's for", () => {
    expect(automatic([code("messages:1", "111111")])).toBeUndefined();
    expect(chooseCode([code("messages:1", "111111")], sure).offered).toHaveLength(1);
  });

  it("offers instead whenever any of that is unclear", () => {
    const one = [mailed("mail:1", "111111")];
    // A sender whose code this site never accepted: text naming the site proves nothing.
    expect(automatic([mailed("mail:1", "111111", { sender: "x@example.com" })])).toBeUndefined();
    // Sent before the request Scient saw, or with no request seen at all.
    expect(automatic([mailed("mail:1", "111111", { at: requestedAt - 1 })])).toBeUndefined();
    expect(automatic(one, { ...sure, requestedAt: undefined })).toBeUndefined();
    // Another sign-in on the site could be waiting for this very code.
    expect(automatic(one, { ...sure, alone: false })).toBeUndefined();
    const two = chooseCode([code("messages:1", "111111"), code("messages:2", "222222")], sure);
    expect(two.automatic).toBeUndefined();
    expect(two.offered.map(({ code }) => code)).toEqual(["111111", "222222"]);
  });

  it("never offers another login's code, even for a click; an unknown recipient may be clicked", () => {
    const other = mailed("mail:1", "111111", { toAccount: false });
    expect(chooseCode([other], sure)).toEqual({ automatic: undefined, offered: [] });
    // Its texted copy names no recipient, but the mail says whose it is.
    expect(chooseCode([code("messages:1", "111111"), other], sure).offered).toEqual([]);
    const unknown = mailed("mail:2", "222222", { toAccount: undefined });
    expect(chooseCode([unknown], sure)).toEqual({ automatic: undefined, offered: [unknown] });
  });

  it("never offers a message, or digits, that already went into a page", () => {
    const used = { ...sure, used: new Set(["messages:1", "digits:333333"]) };
    const choice = chooseCode(
      [code("messages:1", "111111"), mailed("mail:9", "333333"), mailed("mail:2", "222222")],
      used,
    );
    expect(choice.offered.map(({ key }) => key)).toEqual(["mail:2"]);
    expect(choice.automatic?.code).toBe("222222");
  });
});

describe("codes that name no service (Step 7)", () => {
  const candidate = (key: string, code: string, named?: false) => ({
    key,
    code,
    source: "messages" as const,
    at: 2,
    sender: "+972500000000",
    toAccount: undefined,
    ...(named === false ? { named } : {}),
  });
  const context = {
    used: new Set<string>(),
    alone: true,
    requestedAt: 1,
    confirmed: new Set<string>(),
  };

  it("offers a single fresh unnamed code for the person's tap, and never types it", () => {
    const only = chooseCodeFor([candidate("messages:1", "482913", false)], {
      ...context,
      confirmed: new Set(["+972500000000"]),
    });
    expect(only).toEqual({
      automatic: undefined,
      offered: [candidate("messages:1", "482913", false)],
    });
    // Two from unknown senders: nobody can tell which is this site's, so neither is offered.
    expect(
      chooseCodeFor(
        [candidate("messages:1", "482913", false), candidate("messages:2", "118822", false)],
        context,
      ).offered,
    ).toEqual([]);
    // A code that names the service wins over any unnamed one.
    expect(
      chooseCodeFor(
        [candidate("messages:1", "482913", false), candidate("messages:2", "118822")],
        context,
      ).offered.map(({ code }) => code),
    ).toEqual(["118822"]);
  });
});
