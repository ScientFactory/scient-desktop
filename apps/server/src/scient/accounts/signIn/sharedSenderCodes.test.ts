// @effect-diagnostics nodeBuiltinImport:off -- Builds synthetic Messages and Mail databases.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { chooseCodeFor } from "./codeChoice.ts";
import { runSignInCodesWorker, type CodeReaders } from "./codeSourcesHelper.ts";
import { readMailCodes } from "./mailCodes.ts";
import type { CodeCandidate } from "./messageCodes.ts";
import { readMessageCodes, serviceIdentity, serviceWords, sharedService } from "./messageCodes.ts";

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const now = Date.UTC(2026, 10, 26, 10);
const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shared-codes-"));
afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

/** Texts as Messages keeps them: each from its sender's handle. */
function messages(rows: ReadonlyArray<{ readonly from: string; readonly text: string }>) {
  const path = NodePath.join(directory, `chat-${NodeFS.readdirSync(directory).length}.db`);
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(
    "CREATE TABLE message (text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER); CREATE TABLE handle (id TEXT)",
  );
  const handle = db.prepare("INSERT INTO handle VALUES (?)");
  const insert = db.prepare("INSERT INTO message VALUES (?, NULL, ?, 0, ?)");
  rows.forEach(({ from, text }, index) => {
    handle.run(from);
    insert.run(text, BigInt(now - 1_000 + index - APPLE_EPOCH_MS) * 1_000_000n, index + 1);
  });
  db.close();
  return path;
}

/** Mail's index: one message, its subject and preview, from a sender to the account. */
function mail(from: string, subject: string, summary: string) {
  const path = NodePath.join(directory, `mail-${NodeFS.readdirSync(directory).length}`);
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(`
    CREATE TABLE messages (sender INTEGER, subject INTEGER, summary INTEGER, date_received INTEGER, deleted INTEGER);
    CREATE TABLE subjects (subject TEXT);
    CREATE TABLE summaries (summary TEXT);
    CREATE TABLE addresses (address TEXT);
    CREATE TABLE recipients (message INTEGER, address INTEGER);
  `);
  const address = db.prepare("INSERT INTO addresses VALUES (?)");
  address.run(from);
  address.run("ada@example.org");
  db.prepare("INSERT INTO subjects VALUES (?)").run(subject);
  db.prepare("INSERT INTO summaries VALUES (?)").run(summary);
  db.prepare("INSERT INTO messages VALUES (1, 1, 1, ?, 0)").run(Math.floor(now / 1000));
  db.prepare("INSERT INTO recipients VALUES (1, 2)").run();
  db.close();
  return path;
}

const govIl = { name: "login.gov.il", sites: ["login.gov.il"] };
const look = (account: typeof govIl, username?: string) => ({
  sinceMs: now - 60_000,
  service: serviceWords(account),
  shared: sharedService(account),
  sites: account.sites,
  ...(username ? { username } : {}),
});

/** The reader process's own work, on these databases, then the engine's choice from what it gave. */
function chosen(
  args: { readonly messages?: string; readonly mail?: string },
  lookAt: ReturnType<typeof look>,
  confirmed: ReadonlyArray<string>,
) {
  const readers: CodeReaders = {
    messagesReadable: () => true,
    mailReadable: () => true,
    readMessageCodes: (sinceMs, service, _database, shared) =>
      args.messages ? readMessageCodes(sinceMs, service, args.messages, shared) : [],
    readMailCodes: (sinceMs, service, account, _database, shared) =>
      args.mail ? readMailCodes(sinceMs, service, account, args.mail, shared) : [],
  };
  // Across the process boundary, as JSON, as the engine receives it.
  const found = JSON.parse(
    JSON.stringify(runSignInCodesWorker(["codes", JSON.stringify(lookAt)], readers)),
  ) as ReadonlyArray<CodeCandidate>;
  return chooseCodeFor(found, {
    used: new Set(),
    alone: true,
    requestedAt: now - 30_000,
    confirmed: new Set(confirmed),
  });
}

describe("a code from a sender other services share is the person's to tap (round 6c, finding 8)", () => {
  it("never types a gov.il mail's code by itself, though its sender worked before", () => {
    // The government's identity service mails every gov.il service's codes.
    const path = mail(
      "noreply@login.gov.il",
      "Your one-time code",
      "Tax portal (tax.gov.il) code: 482913. Not you? Ignore it.",
    );
    const choice = chosen({ mail: path }, look(govIl, "ada@example.org"), ["noreply@login.gov.il"]);
    expect(choice.automatic).toBeUndefined();
    expect(choice.offered.map(({ code, named }) => [code, named])).toEqual([["482913", "shared"]]);
  });

  it("names a shared service only by who sent it, never by a mention in the text", () => {
    const path = messages([
      { from: "+972500000000", text: "Your gov.il code is 111111" },
      { from: "GOVIL", text: "קוד אימות: 482913" },
    ]);
    const choice = chosen({ messages: path }, look(govIl), []);
    expect(choice.automatic).toBeUndefined();
    // GOVIL's is offered with its sender; the other names no service, so it waits behind it.
    expect(choice.offered.map(({ code, sender, named }) => [code, sender, named])).toEqual([
      ["482913", "govil", "shared"],
    ]);
  });

  it("offers nothing as this service's from a message that holds two codes", () => {
    const path = messages([
      { from: "Example", text: "Example code 111111. Your previous code 222222 has expired." },
    ]);
    const choice = chosen(
      { messages: path },
      {
        sinceMs: now - 60_000,
        service: serviceWords({ name: "Example", sites: ["example.com"] }),
        shared: false,
        sites: ["example.com"],
      },
      [],
    );
    expect(choice.offered).toEqual([]);
  });

  it("keeps a code's attribution through the reader process, so an unnamed one stays unnamed", () => {
    const path = messages([{ from: "+972500000000", text: "Your code is 777777" }]);
    const choice = chosen(
      { messages: path },
      {
        sinceMs: now - 60_000,
        service: serviceWords({ name: "Example", sites: ["example.com"] }),
        shared: false,
        sites: ["example.com"],
      },
      [],
    );
    expect(choice.offered.map(({ code, named }) => [code, named])).toEqual([["777777", false]]);
  });
});

describe("a code is this service's only when the message says so, and holds one code (round 6d)", () => {
  const overleaf = { name: "Overleaf", sites: ["overleaf.com"] };
  const overleafLook = {
    sinceMs: now - 60_000,
    service: serviceWords(overleaf),
    shared: sharedService(overleaf),
    sites: overleaf.sites,
    username: "ada@example.org",
  };
  it("doesn't take a sibling service's mail for this one's, though their domain names both", () => {
    // Moodle at the university; the library, another of its services, mails from the same domain.
    const moodle = { name: "HUJI Moodle", sites: ["moodle.huji.ac.il"] };
    const look = {
      sinceMs: now - 60_000,
      ...serviceIdentity(moodle),
      sites: moodle.sites,
      username: "ada@example.org",
    };
    const library = mail("noreply@huji.ac.il", "Your HUJI library code", "Use 482913 to sign in.");
    const choice = chosen({ mail: library }, look, ["noreply@huji.ac.il"]);
    expect(choice.automatic).toBeUndefined();
    expect(choice.offered).toEqual([]);
    // The library's mail mentions Moodle in passing: its subject is what it is for.
    const passing = mail(
      "noreply@huji.ac.il",
      "Your HUJI code",
      "Use 482913 to sign in to the library. Moodle users sign in as before.",
    );
    expect(chosen({ mail: passing }, look, ["noreply@huji.ac.il"]).offered).toEqual([]);
    // Moodle's own names it only in its subject: offered for the person to tap, never typed
    // (round 6e). regression: a subject's mention typed the code by itself.
    const own = mail("noreply@huji.ac.il", "Your Moodle code", "Use 482913 to sign in.");
    const ownChoice = chosen({ mail: own }, look, ["noreply@huji.ac.il"]);
    expect(ownChoice.automatic).toBeUndefined();
    expect(ownChoice.offered.map(({ code }) => code)).toEqual(["482913"]);
  });

  it("takes a year-like code when the message says it is the code (round 6e)", () => {
    const said = messages([{ from: "Overleaf", text: "Your Overleaf code is 2026" }]);
    // regression: 2026 was taken for a year and the code was lost.
    expect(chosen({ messages: said }, overleafLook, []).offered.map(({ code }) => code)).toEqual([
      "2026",
    ]);
  });

  it("offers no code from a message holding codes of different lengths", () => {
    const path = messages([
      { from: "Overleaf", text: "Your Overleaf code is 482913. Ticket 4821 if it wasn't you." },
    ]);
    expect(chosen({ messages: path }, overleafLook, []).offered).toEqual([]);
    // A year beside it is no code.
    const dated = messages([{ from: "Overleaf", text: "Overleaf 2026: your code is 482913" }]);
    expect(chosen({ messages: dated }, overleafLook, []).offered.map(({ code }) => code)).toEqual([
      "482913",
    ]);
  });
});
