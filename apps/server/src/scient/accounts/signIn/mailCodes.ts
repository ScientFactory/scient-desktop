// @effect-diagnostics nodeBuiltinImport:off -- Reads Apple Mail's index with Node's own SQLite.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { siteHost, siteOf } from "@t3tools/shared/scientSiteMatch";
import { namedCodeInText, type CodeCandidate } from "./messageCodes.ts";

/** Mail keeps its index under a folder named for its format, V10 on recent macOS. */
const mailDatabase = (root = NodePath.join(NodeOS.homedir(), "Library/Mail")) => {
  if (!NodeFS.existsSync(root)) return undefined;
  const newest = NodeFS.readdirSync(root)
    .filter((name) => /^V\d+$/u.test(name))
    .toSorted((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
  return newest === undefined ? undefined : NodePath.join(root, newest, "MailData/Envelope Index");
};

/**
 * Whether macOS lets Scient read Mail's index here (false too where there is no Mail). Finding
 * the index can itself be refused, so that is inside the same catch.
 */
export function mailReadable(root?: string) {
  try {
    const database = mailDatabase(root);
    if (database === undefined) return false;
    const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
    try {
      db.prepare("SELECT 1 FROM messages LIMIT 1").get();
    } finally {
      db.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** The registrable sites a code for these account sites may come from, such as `example.com`. */
export const codeSenderSites = (sites: ReadonlyArray<string>) => [
  ...new Set(sites.map((site) => siteOf(siteHost(site)))),
];

/**
 * Codes in mail received since `sinceMs` that name the service, from the subject and Mail's
 * preview. Certain only from the site's own domain, to the account when its username is an
 * address. Throws when macOS refuses access, like Messages.
 */
export function readMailCodes(
  sinceMs: number,
  service: ReadonlyArray<string>,
  account: { readonly sites: ReadonlyArray<string>; readonly username?: string | undefined },
  database = mailDatabase(),
  shared = false,
): ReadonlyArray<CodeCandidate> {
  if (database === undefined) return [];
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT m.ROWID AS id, m.date_received AS received, s.subject AS subject, su.summary AS summary, a.address AS sender FROM messages m LEFT JOIN subjects s ON s.ROWID = m.subject LEFT JOIN summaries su ON su.ROWID = m.summary LEFT JOIN addresses a ON a.ROWID = m.sender WHERE m.date_received > ? AND m.deleted = 0 ORDER BY m.date_received DESC LIMIT 20",
      )
      .all(Math.floor(sinceMs / 1000)) as unknown as ReadonlyArray<{
      readonly id: number;
      readonly received: number;
      readonly subject: string | null;
      readonly summary: string | null;
      readonly sender: string | null;
    }>;
    const recipients = db.prepare(
      "SELECT a.address AS address FROM recipients r JOIN addresses a ON a.ROWID = r.address WHERE r.message = ?",
    );
    const hosts = new Set(codeSenderSites(account.sites));
    const username = account.username?.includes("@") ? account.username.toLowerCase() : undefined;
    return rows.flatMap((row) => {
      // Named by its sender only: a subject naming the service only offers the code, for the
      // person to tap, never typed; a preview's mention is nothing (rounds 6d, 6e).
      const codeText = `${row.subject ?? ""}\n${row.summary ?? ""}`;
      const bySender = namedCodeInText("", service, row.sender, shared, codeText);
      const bySubject =
        bySender || shared
          ? undefined
          : namedCodeInText(row.subject ?? "", service, row.sender, false, codeText);
      const named = bySender ?? (bySubject && { code: bySubject.code, shared: true });
      if (named === undefined) return [];
      const { code } = named;
      const sender = (row.sender ?? "").toLowerCase();
      // Mail from another site is never this site's code, even one that names it.
      if (!hosts.has(siteOf(sender.split("@")[1] ?? ""))) return [];
      const toAccount =
        username === undefined
          ? undefined
          : (recipients.all(row.id) as unknown as ReadonlyArray<{ readonly address: string }>).some(
              ({ address }) => address.toLowerCase() === username,
            );
      return [
        {
          key: `mail:${row.id}`,
          code,
          source: "mail" as const,
          at: row.received * 1000,
          sender,
          toAccount,
          ...(named.shared ? { named: "shared" as const } : {}),
        },
      ];
    });
  } finally {
    db.close();
  }
}
