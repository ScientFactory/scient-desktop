/**
 * Windows security descriptors in SDDL, as `(Get-Acl).Sddl` prints them, read for the
 * native publication helper's permission check. Any form not listed here refuses.
 */

/** A SID in its full form, or a domain-relative account named only by its RID. */
type Principal =
  | { readonly sid: string }
  | { readonly rid: number; readonly domain: "local" | "domain" | "root" };

interface Ace {
  readonly type: string;
  readonly inheritOnly: boolean;
  readonly rights: number;
  readonly principal: Principal;
}

interface SecurityDescriptor {
  readonly owner: Principal | undefined;
  /** Undefined: no DACL; null: a NULL DACL. Either grants everyone everything. */
  readonly dacl: ReadonlyArray<Ace> | null | undefined;
}

const FIXED_ALIASES: Record<string, string> = {
  AA: "S-1-5-32-579",
  AC: "S-1-15-2-1",
  AN: "S-1-5-7",
  AO: "S-1-5-32-548",
  AS: "S-1-18-1",
  AU: "S-1-5-11",
  BA: "S-1-5-32-544",
  BG: "S-1-5-32-546",
  BO: "S-1-5-32-551",
  BU: "S-1-5-32-545",
  CD: "S-1-5-32-574",
  CG: "S-1-3-1",
  CO: "S-1-3-0",
  CY: "S-1-5-32-569",
  ED: "S-1-5-9",
  ER: "S-1-5-32-573",
  ES: "S-1-5-32-576",
  HA: "S-1-5-32-578",
  HI: "S-1-16-12288",
  IS: "S-1-5-32-568",
  IU: "S-1-5-4",
  LS: "S-1-5-19",
  LU: "S-1-5-32-559",
  LW: "S-1-16-4096",
  ME: "S-1-16-8192",
  MP: "S-1-16-8448",
  MS: "S-1-5-32-577",
  MU: "S-1-5-32-558",
  NO: "S-1-5-32-556",
  NS: "S-1-5-20",
  NU: "S-1-5-2",
  OW: "S-1-3-4",
  PO: "S-1-5-32-550",
  PS: "S-1-5-10",
  PU: "S-1-5-32-547",
  RA: "S-1-5-32-575",
  RC: "S-1-5-12",
  RD: "S-1-5-32-555",
  RE: "S-1-5-32-552",
  RM: "S-1-5-32-580",
  RU: "S-1-5-32-554",
  SI: "S-1-16-16384",
  SO: "S-1-5-32-549",
  SS: "S-1-18-2",
  SU: "S-1-5-6",
  SY: "S-1-5-18",
  UD: "S-1-5-84-0-0-0-0-0",
  WD: "S-1-1-0",
  WR: "S-1-5-33",
};
const RELATIVE_ALIASES: Record<
  string,
  { readonly rid: number; readonly domain: "local" | "domain" | "root" }
> = {
  LA: { rid: 500, domain: "local" },
  LG: { rid: 501, domain: "local" },
  AP: { rid: 525, domain: "domain" },
  CA: { rid: 517, domain: "domain" },
  CN: { rid: 522, domain: "domain" },
  DA: { rid: 512, domain: "domain" },
  DC: { rid: 515, domain: "domain" },
  DD: { rid: 516, domain: "domain" },
  DG: { rid: 514, domain: "domain" },
  DU: { rid: 513, domain: "domain" },
  KA: { rid: 526, domain: "domain" },
  PA: { rid: 520, domain: "domain" },
  RS: { rid: 553, domain: "domain" },
  EA: { rid: 519, domain: "root" },
  EK: { rid: 527, domain: "root" },
  RO: { rid: 498, domain: "root" },
  SA: { rid: 518, domain: "root" },
};

const FILE_ALL_ACCESS = 0x1f01ff;
const FILE_GENERIC_READ = 0x120089;
const FILE_GENERIC_WRITE = 0x120116;
const FILE_GENERIC_EXECUTE = 0x1200a0;
const RIGHTS: Record<string, number> = {
  GA: 0x10000000,
  GX: 0x20000000,
  GW: 0x40000000,
  GR: 0x80000000,
  RC: 0x20000,
  SD: 0x10000,
  WD: 0x40000,
  WO: 0x80000,
  CC: 0x1,
  DC: 0x2,
  LC: 0x4,
  SW: 0x8,
  RP: 0x10,
  WP: 0x20,
  DT: 0x40,
  LO: 0x80,
  CR: 0x100,
  FA: FILE_ALL_ACCESS,
  FR: FILE_GENERIC_READ,
  FW: FILE_GENERIC_WRITE,
  FX: FILE_GENERIC_EXECUTE,
  KA: 0xf003f,
  KR: 0x20019,
  KW: 0x20006,
  KX: 0x20019,
  NW: 0x1,
  NR: 0x2,
  NX: 0x4,
};
const ACE_FLAGS: Record<string, number> = {
  OI: 0x1,
  CI: 0x2,
  NP: 0x4,
  IO: 0x8,
  ID: 0x10,
  CR: 0x20,
  SA: 0x40,
  FA: 0x80,
  TP: 0x40,
};
const INHERIT_ONLY = 0x8;
const ALLOWING = new Set(["A", "OA", "XA", "ZA"]);
const DENYING = new Set(["D", "OD", "XD"]);
const SACL_ONLY = new Set(["AU", "AL", "OU", "OL", "ML", "XU", "RA", "SP", "TL"]);
const CONDITIONAL = new Set(["XA", "XD", "ZA", "XU", "RA"]);
const OBJECT = new Set(["OA", "OD", "ZA", "OU", "OL"]);

/** Generic rights as a file or folder maps them. */
export function fileRights(mask: number) {
  let rights = mask & 0x0fffffff;
  if (mask & 0x10000000) rights |= FILE_ALL_ACCESS;
  if (mask & 0x20000000) rights |= FILE_GENERIC_EXECUTE;
  if (mask & 0x40000000) rights |= FILE_GENERIC_WRITE;
  if (mask & 0x80000000) rights |= FILE_GENERIC_READ;
  return rights >>> 0;
}

const refuse = (what: string): never => {
  throw new Error(`Unreadable security descriptor: ${what}.`);
};

function tokens(text: string, table: Record<string, number>, what: string) {
  if (/^0x[0-9a-f]{1,8}$/iu.test(text)) return Number.parseInt(text.slice(2), 16);
  if (text.length % 2 !== 0) refuse(what);
  let value = 0;
  for (let index = 0; index < text.length; index += 2) {
    const bits = table[text.slice(index, index + 2)];
    if (bits === undefined) refuse(what);
    value = (value | bits!) >>> 0;
  }
  return value;
}

function principal(text: string): Principal {
  if (/^S-1-\d{1,10}(?:-\d{1,10}){0,15}$/u.test(text)) return { sid: text };
  const fixed = FIXED_ALIASES[text];
  if (fixed !== undefined) return { sid: fixed };
  const relative = RELATIVE_ALIASES[text];
  if (relative !== undefined) return relative;
  return refuse(`account ${JSON.stringify(text)}`);
}

function ace(body: string, inDacl: boolean): Ace {
  const fields = body.split(";");
  if (fields.length < 6) refuse("ACE");
  const [type = "", flags = "", rights = "", objectType = "", inheritedType = "", account = ""] =
    fields;
  const rest = fields.slice(6).join(";");
  if (!ALLOWING.has(type) && !DENYING.has(type) && !SACL_ONLY.has(type)) refuse(`ACE type ${type}`);
  if (inDacl && SACL_ONLY.has(type)) refuse(`ACE type ${type} in a DACL`);
  if (!OBJECT.has(type) && (objectType !== "" || inheritedType !== "")) refuse("object ACE fields");
  if (rest !== "" && !CONDITIONAL.has(type)) refuse("ACE condition");
  return {
    type,
    inheritOnly: (tokens(flags, ACE_FLAGS, "ACE flags") & INHERIT_ONLY) !== 0,
    rights: tokens(rights, RIGHTS, "access rights"),
    principal: principal(account),
  };
}

/** The ACEs from `start`, through the parenthesis that closes each; quotes may hold parentheses. */
function aces(sddl: string, start: number, inDacl: boolean) {
  const found: Ace[] = [];
  let index = start;
  while (sddl[index] === "(") {
    let depth = 0;
    let quoted = false;
    let end = index;
    for (; end < sddl.length; end++) {
      const char = sddl[end];
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === "(") depth++;
      else if (!quoted && char === ")" && --depth === 0) break;
    }
    if (end >= sddl.length) refuse("unclosed ACE");
    found.push(ace(sddl.slice(index + 1, end), inDacl));
    index = end + 1;
  }
  return { aces: found, end: index };
}

export function parseSecurityDescriptor(sddl: string): SecurityDescriptor {
  let owner: Principal | undefined;
  let dacl: ReadonlyArray<Ace> | null | undefined;
  const seen = new Set<string>();
  let index = 0;
  while (index < sddl.length) {
    const part = sddl.slice(index, index + 2);
    if (!/^[OGDS]:$/u.test(part) || seen.has(part)) refuse(`component at ${index}`);
    seen.add(part);
    index += 2;
    if (part === "O:" || part === "G:") {
      const account = /^(?:S-1(?:-\d+)+|[A-Z]{2})/u.exec(sddl.slice(index))?.[0] ?? refuse("SID");
      if (part === "O:") owner = principal(account);
      else principal(account);
      index += account.length;
      continue;
    }
    const flags = /^(?:NO_ACCESS_CONTROL|AI|AR|P)*/u.exec(sddl.slice(index))![0];
    index += flags.length;
    const read = aces(sddl, index, part === "D:");
    index = read.end;
    if (part === "D:") dacl = flags.includes("NO_ACCESS_CONTROL") ? null : read.aces;
  }
  return { owner, dacl };
}

const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

/** The account the server runs as. A local account's SID starts with the machine's own. */
export interface WindowsUser {
  readonly sid: string;
  readonly local: boolean;
}

/**
 * The user, SYSTEM, Administrators or TrustedInstaller. The machine's LA and LG are the user
 * only when the user is that local account; for any other user they name someone else.
 */
function trusted(who: Principal, user: WindowsUser) {
  if ("sid" in who)
    return [user.sid, "S-1-5-18", "S-1-5-32-544", TRUSTED_INSTALLER].includes(who.sid);
  return (
    who.domain === "local" &&
    user.local &&
    new RegExp(`^S-1-5-21-\\d+-\\d+-\\d+-${who.rid}$`, "u").test(user.sid)
  );
}

/**
 * Why `sddl` lets a principal other than the user, SYSTEM, Administrators or TrustedInstaller
 * own the object or hold any of `mask`'s rights on it; undefined when none can. Deny ACEs
 * only take rights away and conditions may hold, so neither ever counts in its favor.
 */
export function securityDescriptorRefusal(sddl: string, mask: number, user: WindowsUser) {
  let descriptor: SecurityDescriptor;
  try {
    descriptor = parseSecurityDescriptor(sddl);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (descriptor.owner === undefined || !trusted(descriptor.owner, user))
    return "Unexpected native resource owner.";
  if (descriptor.dacl == null) return "Native resource has no access control list.";
  for (const entry of descriptor.dacl)
    if (
      ALLOWING.has(entry.type) &&
      !entry.inheritOnly &&
      !trusted(entry.principal, user) &&
      (fileRights(entry.rights) & mask) !== 0
    )
      return "Native resource is writable by another principal.";
  return undefined;
}
