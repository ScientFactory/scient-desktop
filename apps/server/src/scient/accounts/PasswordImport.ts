import { AccountsError, type PasswordImportFormat } from "@t3tools/contracts";
import { getDomain } from "tldts";

const invalid = () =>
  new AccountsError({
    reason: "invalid-input",
    message: "The password export is not a supported CSV file.",
  });

export const parseCsv = (content: string): string[][] => {
  const text = content.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
    } else if (char === '"') {
      if (field !== "" || closed) throw invalid();
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else {
      if (closed) throw invalid();
      field += char;
    }
  }
  if (quoted) throw invalid();
  if (field !== "" || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[ _-]/g, "");
const detectFormat = (headers: string[]): Exclude<PasswordImportFormat, "auto"> => {
  if (headers.includes("loginpassword")) return "bitwarden";
  if (headers.includes("group")) return "keepass";
  if (headers.includes("httprealm") || headers.includes("formactionorigin")) return "firefox";
  if (headers.includes("name") && headers.includes("url")) return "chrome";
  if (headers.includes("otpauth") && !headers.includes("type")) return "safari";
  if (headers.includes("title") && (headers.includes("url") || headers.includes("website")))
    return "1password";
  throw invalid();
};

export interface ImportedPassword {
  readonly name: string;
  readonly site: string;
  readonly loginUrl: string;
  readonly username: string;
  readonly password: string;
  readonly totp?: string;
}

export const parsePasswordImport = (content: string, format: PasswordImportFormat) => {
  const rows = parseCsv(content);
  const headers = rows.shift()?.map(normalizeHeader) ?? [];
  const selected = format === "auto" ? detectFormat(headers) : format;
  const aliases =
    selected === "bitwarden"
      ? {
          url: ["loginuri"],
          username: ["loginusername"],
          password: ["loginpassword"],
          totp: ["logintotp"],
          title: ["name"],
        }
      : {
          url: ["url", "website", "websiteurl"],
          username: ["username", "loginusername"],
          password: ["password"],
          totp: ["otpauth", "totp", "onetimepassword", "otp"],
          title: ["title", "name"],
        };
  const indexOf = (names: string[]) => headers.findIndex((header) => names.includes(header));
  const indices = {
    url: indexOf(aliases.url),
    username: indexOf(aliases.username),
    password: indexOf(aliases.password),
    title: indexOf(aliases.title),
    totp: indexOf(aliases.totp),
  };
  if (indices.url < 0 || indices.username < 0 || indices.password < 0) throw invalid();
  let skipped = 0;
  const entries: ImportedPassword[] = [];
  for (const row of rows) {
    if (row.every((cell) => cell === "")) continue;
    const password = row[indices.password] ?? "";
    const rawUrl = row[indices.url]?.trim() ?? "";
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      skipped++;
      continue;
    }
    const site = getDomain(url.hostname, { allowPrivateDomains: true });
    if (
      !site ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !password ||
      password.length > 65_536 ||
      (row[indices.username]?.length ?? 0) > 256 ||
      rawUrl.length > 2048 ||
      row.length !== headers.length
    ) {
      skipped++;
      continue;
    }
    const totp = row[indices.totp] || undefined;
    if (totp && totp.length > 65_536) {
      skipped++;
      continue;
    }
    entries.push({
      name: (row[indices.title]?.trim() || site).slice(0, 80),
      site,
      loginUrl: url.href,
      username: row[indices.username] ?? "",
      password,
      ...(totp ? { totp } : {}),
    });
  }
  return { entries, skipped };
};
