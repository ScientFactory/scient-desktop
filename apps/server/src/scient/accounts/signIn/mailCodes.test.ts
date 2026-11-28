// @effect-diagnostics nodeBuiltinImport:off -- Builds a synthetic Mail index.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { mailReadable, readMailCodes } from "./mailCodes.ts";

it("reads mailed codes only from the site's domain, saying whether they reached the login", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mail-"));
  const path = NodePath.join(directory, "Envelope Index");
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(`
    CREATE TABLE messages (sender INTEGER, subject INTEGER, summary INTEGER, date_received INTEGER, deleted INTEGER);
    CREATE TABLE subjects (subject TEXT);
    CREATE TABLE summaries (summary TEXT);
    CREATE TABLE addresses (address TEXT);
    CREATE TABLE recipients (message INTEGER, address INTEGER);
  `);
  const now = Date.UTC(2026, 10, 26, 10);
  const address = db.prepare("INSERT INTO addresses VALUES (?)");
  for (const value of ["no-reply@mail.example.com", "me@example.org", "other@example.org"])
    address.run(value);
  const subject = db.prepare("INSERT INTO subjects VALUES (?)");
  subject.run("Your Example sign-in code");
  db.prepare("INSERT INTO summaries VALUES (?)").run("Example: use 482913 to sign in.");
  const message = db.prepare("INSERT INTO messages VALUES (?, 1, 1, ?, 0)");
  const seconds = Math.floor(now / 1000);
  message.run(1, seconds); // from the site, to the account
  message.run(1, seconds); // from the site, to someone else
  message.run(2, seconds); // from another domain
  message.run(1, seconds - 600); // before the sign-in
  const to = db.prepare("INSERT INTO recipients VALUES (?, ?)");
  to.run(1, 2);
  to.run(2, 3);
  to.run(3, 2);
  db.close();
  const found = readMailCodes(
    now - 60_000,
    ["example"],
    { sites: ["example.com"], username: "me@example.org" },
    path,
  );
  // Mail from another site is left out; what's left says whether it reached this login.
  expect(found.map(({ key, sender, toAccount }) => [key, sender, toAccount])).toEqual([
    ["mail:1", "no-reply@mail.example.com", true],
    ["mail:2", "no-reply@mail.example.com", false],
  ]);
  NodeFS.rmSync(directory, { recursive: true });
});

it("says Mail can't be read, rather than failing, when even finding its index is refused", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mail-"));
  // A file where the Mail folder should be: listing it throws, as a refusal by macOS does.
  const root = NodePath.join(directory, "Mail");
  NodeFS.writeFileSync(root, "");
  expect(mailReadable(root)).toBe(false);
  NodeFS.rmSync(directory, { recursive: true });
});
