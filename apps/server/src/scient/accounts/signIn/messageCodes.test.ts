// @effect-diagnostics nodeBuiltinImport:off -- Builds a synthetic Messages database.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { attributedText, codeInText, readMessageCode } from "./messageCodes.ts";

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

describe("sign-in codes in messages", () => {
  it.each([
    ["Your verification code is 482913", "482913"],
    ["482913 is your one-time password", "482913"],
    ["קוד האימות שלך: 482913", "482913"],
    ["Your order 482913 has shipped", undefined],
    ["Your code expires 12/10/2026", undefined],
    ["Call 03-1234567 about your code", undefined],
  ])("%s", (text, code) => {
    expect(codeInText(text)).toBe(code);
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

  it("reads the newest received code since the sign-in began", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "messages-"));
    const path = NodePath.join(directory, "chat.db");
    const db = new NodeSqlite.DatabaseSync(path);
    db.exec(
      "CREATE TABLE message (text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER)",
    );
    const at = (ms: number) => BigInt(ms - APPLE_EPOCH_MS) * 1_000_000n;
    const insert = db.prepare("INSERT INTO message VALUES (?, NULL, ?, ?)");
    const now = Date.UTC(2026, 9, 30, 10);
    insert.run("Your code is 111111", at(now - 600_000), 0);
    insert.run("Your code is 222222", at(now - 1_000), 0);
    insert.run("Your code is 333333", at(now - 500), 1);
    db.close();
    expect(readMessageCode(now - 60_000, path)).toBe("222222");
    expect(readMessageCode(now, path)).toBeUndefined();
    NodeFS.rmSync(directory, { recursive: true });
  });
});
