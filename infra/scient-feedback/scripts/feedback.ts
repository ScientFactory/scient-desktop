// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - a small operator CLI.
/**
 * Reads and triages feedback reports: list, show <id>, pull <dir>, resolve <id>, delete <id>.
 * Needs SCIENT_FEEDBACK_ADMIN_TOKEN; SCIENT_FEEDBACK_URL defaults to production.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const base = (process.env.SCIENT_FEEDBACK_URL ?? "https://feedback.scientfactory.com").replace(
  /\/$/,
  "",
);
const token = process.env.SCIENT_FEEDBACK_ADMIN_TOKEN;

interface AdminReport {
  readonly id: string;
  readonly receivedAt: string;
  readonly status: string;
  readonly fixedIn: string | null;
  readonly note: string | null;
  readonly report: {
    readonly message: string;
    readonly source: string;
    readonly screen: string;
    readonly contactEmail?: string;
    readonly app: Record<string, unknown> & {
      readonly version: string;
      readonly platform: string;
      readonly recentFailures: ReadonlyArray<{
        readonly name: string;
        readonly at: string;
        readonly traceId: string;
      }>;
    };
    readonly error?: { readonly message: string; readonly class?: string; readonly code?: string };
    readonly attachments: ReadonlyArray<{ readonly kind: string; readonly bytes: number }>;
  };
}

const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  }
  return response;
};

const firstLine = (text: string) => (text.split("\n")[0] ?? "").slice(0, 80);

const summary = (entry: AdminReport) => {
  const { report } = entry;
  const files = report.attachments.map((attachment) => attachment.kind).join("+") || "-";
  const text = report.message.trim() || `[error] ${report.error?.message ?? ""}`;
  return [
    entry.id.slice(0, 8),
    entry.receivedAt.slice(0, 16).replace("T", " "),
    entry.status.padEnd(6),
    report.source.padEnd(15),
    `${report.app.version} ${report.app.platform}`.padEnd(18),
    files.padEnd(24),
    firstLine(text),
  ].join("  ");
};

const markdown = (entry: AdminReport) => {
  const { report } = entry;
  const lines = [
    `# Feedback ${entry.id}`,
    "",
    `- Received: ${entry.receivedAt}`,
    `- Status: ${entry.status}${entry.fixedIn ? ` (fixed in ${entry.fixedIn})` : ""}`,
    `- From: ${report.source}, screen ${report.screen}`,
    `- App: ${Object.entries(report.app)
      .filter(([key]) => key !== "recentFailures")
      .map(([key, value]) => `${key} ${value}`)
      .join(", ")}`,
    `- Recent failures: ${
      report.app.recentFailures.length === 0
        ? "none"
        : report.app.recentFailures
            .map((failure) => `${failure.name} at ${failure.at} (trace ${failure.traceId})`)
            .join("; ")
    }`,
    `- Reply to: ${report.contactEmail ?? "no email given"}`,
    `- Attachments: ${report.attachments.map((a) => `${a.kind} (${a.bytes} bytes)`).join(", ") || "none"}`,
    "",
    "## Message",
    "",
    report.message.trim() || "_No message._",
  ];
  if (report.error) {
    lines.push("", "## Error", "", "```text", report.error.message, "```");
    if (report.error.class || report.error.code) {
      lines.push("", `Class ${report.error.class ?? "-"}, code ${report.error.code ?? "-"}`);
    }
  }
  if (entry.note) lines.push("", "## Team note", "", entry.note);
  return `${lines.join("\n")}\n`;
};

const EXTENSIONS: Record<string, string> = {
  screenshot: "jpg",
  logs: "log.txt",
  conversation: "md",
};

const download = async (entry: AdminReport, dir: string) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "report.md"), markdown(entry), { mode: 0o600 });
  for (const attachment of entry.report.attachments) {
    const response = await call(`/v1/admin/reports/${entry.id}/files/${attachment.kind}`);
    NodeFS.writeFileSync(
      NodePath.join(dir, `${attachment.kind}.${EXTENSIONS[attachment.kind] ?? "bin"}`),
      new Uint8Array(await response.arrayBuffer()),
      { mode: 0o600 },
    );
  }
};

const resolveId = async (prefix: string) => {
  if (prefix.length === 36) return prefix;
  const { reports } = (await (await call("/v1/admin/reports?limit=200")).json()) as {
    reports: ReadonlyArray<AdminReport>;
  };
  const matches = reports.filter((entry) => entry.id.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`${matches.length} reports start with ${prefix}.`);
  return matches[0]!.id;
};

const main = async () => {
  if (!token) throw new Error("Set SCIENT_FEEDBACK_ADMIN_TOKEN.");
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      status: { type: "string" },
      limit: { type: "string" },
      "fixed-in": { type: "string" },
      note: { type: "string" },
    },
  });
  const [command, argument] = positionals;
  const query = new URLSearchParams();
  if (values.status) query.set("status", values.status);
  query.set("limit", values.limit ?? "50");

  switch (command) {
    case "list": {
      const { reports } = (await (await call(`/v1/admin/reports?${query}`)).json()) as {
        reports: ReadonlyArray<AdminReport>;
      };
      if (reports.length === 0) console.log("No reports.");
      for (const entry of reports) console.log(summary(entry));
      return;
    }
    case "show": {
      const id = await resolveId(argument ?? "");
      const entry = (await (await call(`/v1/admin/reports/${id}`)).json()) as AdminReport;
      const dir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), `scient-feedback-${id.slice(0, 8)}-`),
      );
      await download(entry, dir);
      console.log(markdown(entry));
      console.log(`Files: ${dir}`);
      return;
    }
    case "pull": {
      if (!argument) throw new Error("Name a folder: pull <dir>.");
      const { reports } = (await (await call(`/v1/admin/reports?${query}`)).json()) as {
        reports: ReadonlyArray<AdminReport>;
      };
      for (const entry of reports) {
        await download(
          entry,
          NodePath.join(argument, `${entry.receivedAt.slice(0, 10)}-${entry.id.slice(0, 8)}`),
        );
      }
      console.log(`${reports.length} reports in ${NodePath.resolve(argument)}`);
      return;
    }
    case "resolve": {
      const id = await resolveId(argument ?? "");
      const patch: Record<string, string | null> = {};
      if (values.status) patch.status = values.status;
      if (values["fixed-in"] !== undefined) patch.fixedIn = values["fixed-in"] || null;
      if (values.note !== undefined) patch.note = values.note || null;
      const entry = (await (
        await call(`/v1/admin/reports/${id}`, { method: "PATCH", body: JSON.stringify(patch) })
      ).json()) as AdminReport;
      console.log(summary(entry));
      return;
    }
    case "delete": {
      const id = await resolveId(argument ?? "");
      await call(`/v1/admin/reports/${id}`, { method: "DELETE" });
      console.log(`Deleted ${id}.`);
      return;
    }
    default:
      throw new Error("Commands: list, show <id>, pull <dir>, resolve <id>, delete <id>.");
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
