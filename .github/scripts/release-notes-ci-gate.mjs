import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export const catalogPath = "apps/web/src/scient/releaseNotes/catalog.ts";
const allowed = new Set([
  catalogPath,
  "apps/web/src/scient/releaseNotes/model.test.ts",
  "apps/web/src/scient/releaseNotes/ScientReleaseNotes.browser.test.tsx",
]);

/** Accept only literal catalog data, never evaluate the TypeScript module. */
export function isLiteralCatalog(source) {
  try {
    const text = source.replace(
      /("(?:\\[\s\S]|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
      (match, string) => string ?? " ",
    );
    const body = text.match(
      /^\s*import type \{ ScientReleaseNote \} from "\.\/model";\s*export const SCIENT_RELEASE_NOTES = (\[[\s\S]*\]) as const satisfies readonly ScientReleaseNote\[\];\s*$/,
    )?.[1];
    if (!body) return false;
    const json = body
      .replace(
        /("(?:\\[\s\S]|[^"\\])*")|\b([A-Za-z_]\w*)\s*:/g,
        (match, string, key) => string ?? `"${key}":`,
      )
      .replace(/("(?:\\[\s\S]|[^"\\])*")|,\s*(?=[}\]])/g, (match, string) => string ?? "");
    return Array.isArray(JSON.parse(json));
  } catch {
    return false;
  }
}

export function detectReleaseNotesOnly({ event, head, cwd = process.cwd() }) {
  try {
    const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha ?? event.before;
    if (![base, head].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)))
      return false;
    const git = (...args) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    // Include both paths of a rename and reject additions, deletions and mode changes.
    const raw = git("diff", "--raw", "--no-renames", "-z", base, head, "--").split("\0");
    if (raw.pop() !== "" || raw.length === 0 || raw.length % 2 !== 0) return false;
    const paths = [];
    for (let i = 0; i < raw.length; i += 2) {
      if (!/^:100644 100644 [a-f0-9]+ [a-f0-9]+ M$/.test(raw[i]) || !allowed.has(raw[i + 1]))
        return false;
      paths.push(raw[i + 1]);
    }
    return (
      paths.includes(catalogPath) &&
      [base, head].every((sha) => isLiteralCatalog(git("show", `${sha}:${catalogPath}`)))
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  let only = false;
  try {
    only = detectReleaseNotesOnly({
      event: JSON.parse(NodeFS.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      head: process.env.GITHUB_SHA,
    });
  } catch {
    // Missing or malformed event data must keep full CI enabled.
  }
  NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `only=${only}\n`);
  console.log(only ? "Literal release-note content and focused tests only." : "Full CI required.");
}
