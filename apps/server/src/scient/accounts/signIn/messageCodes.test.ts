// @effect-diagnostics nodeBuiltinImport:off -- Builds a synthetic Messages database.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { attributedText, codeInText, readMessageCodes, serviceWords } from "./messageCodes.ts";

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

describe("sign-in codes in messages", () => {
  const service = ["example"];
  it.each([
    ["Example: your verification code is 482913", "482913"],
    ["482913 is your Example one-time password", "482913"],
    ["Example קוד האימות שלך: 482913", "482913"],
    ["Example: your order 482913 has shipped", undefined],
    ["Example: your code expires 12/10/2026", undefined],
    ["Call Example on 03-1234567 about your code", undefined],
    ["Your Other Bank code is 482913", undefined],
  ])("%s", (text, code) => {
    expect(codeInText(text, service)).toBe(code);
  });

  it("names a service by its sites and account, not by what every site shares", () => {
    expect(serviceWords({ name: "HUJI library", sites: ["huji.ac.il"] })).toEqual(["huji"]);
    expect(serviceWords({ name: "Work", sites: ["https://login.github.com"] })).toEqual([
      "github",
      "work",
    ]);
  });

  it("reads the text out of an archived message body", () => {
    const text = "Your code is 482913";
    const body = Buffer.concat([
      Buffer.from("streamtyped\u0084\u0001@NSString\u0001\u0094\u0084\u0001+"),
      Buffer.from([text.length]),
      Buffer.from(text),
      Buffer.from("\u0086\u0084"),
    ]);
    expect(attributedText(body)).toBe(text);
  });

  it("reads every received code since the sign-in began that names the service", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "messages-"));
    const path = NodePath.join(directory, "chat.db");
    const db = new NodeSqlite.DatabaseSync(path);
    db.exec(
      "CREATE TABLE message (text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER); CREATE TABLE handle (id TEXT)",
    );
    const at = (ms: number) => BigInt(ms - APPLE_EPOCH_MS) * 1_000_000n;
    const insert = db.prepare("INSERT INTO message VALUES (?, NULL, ?, ?, NULL)");
    const now = Date.UTC(2026, 9, 30, 10);
    insert.run("Example code is 111111", at(now - 600_000), 0);
    insert.run("Example code is 222222", at(now - 1_000), 0);
    insert.run("Other Bank code is 444444", at(now - 800), 0);
    insert.run("Example code is 333333", at(now - 500), 1);
    db.close();
    // Another service's code is read too, marked as naming none: it is only ever offered.
    expect(readMessageCodes(now - 60_000, ["example"], path)).toEqual([
      {
        key: "messages:3",
        code: "444444",
        source: "messages",
        at: now - 800,
        sender: "",
        toAccount: undefined,
        named: false,
      },
      {
        key: "messages:2",
        code: "222222",
        source: "messages",
        at: now - 1_000,
        sender: "",
        toAccount: undefined,
      },
    ]);
    expect(readMessageCodes(now, ["example"], path)).toEqual([]);
    NodeFS.rmSync(directory, { recursive: true });
  });
});

it("needs the service's whole name, so a domain label can't match inside another word", () => {
  const service = serviceWords({ name: "Sydney", sites: ["sydney.edu.au"] });
  expect(service).not.toContain("edu");
  expect(codeInText("Your Schedule code is 123456", service)).toBeUndefined();
  expect(codeInText("Sydney University code 123456", service)).toBe("123456");
});

it("takes the code from the message, never the sender's number or a year", () => {
  const service = serviceWords({ name: "Example", sites: ["example.com"] });
  expect(codeInText("Your verification code is 482913", service, "Example")).toBe("482913");
  expect(codeInText("Example: your code is 482913", service, "32665")).toBe("482913");
  expect(codeInText("In 2026 Example code is 482913", service)).toBe("482913");
  expect(codeInText("G-482913 is your Example verification code.", service)).toBe("482913");
});

describe("codes for a site named only with generic words (Step 7)", () => {
  it("matches login.gov.il's codes by its domain, written out or as the sender ID", () => {
    const service = serviceWords({ name: "login.gov.il", sites: ["login.gov.il"] });
    // regression: "login" and "gov" are generic and "il" too short, so nothing matched.
    expect(service).toEqual(["gov.il", "govil"]);
    expect(codeInText("קוד האימות שלך לאתר gov.il הוא 482913", service, "GOVIL")).toBe("482913");
    expect(codeInText("קוד אימות: 482913", service, "GOVIL")).toBe("482913");
    // Another service's code is not this site's.
    expect(codeInText("Your Bank code is 482913", service, "MYBANK")).toBeUndefined();
  });

  it("keeps the specific words a site has, and falls back for every all-generic host", () => {
    expect(serviceWords({ name: "Secure", sites: ["secure.example.org"] })).toEqual(["example"]);
    expect(serviceWords({ name: "SSO", sites: ["https://sso.edu.au"] })).toEqual([
      "edu.au",
      "eduau",
    ]);
  });
});
