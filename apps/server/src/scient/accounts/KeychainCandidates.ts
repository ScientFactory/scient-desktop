import { type KeychainCandidate, KeychainCandidate as CandidateSchema } from "@t3tools/contracts";
import { Schema } from "effect";

const decodeQuoted = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const isCandidate = Schema.is(CandidateSchema);

export const parseMacKeychain = (text: string): KeychainCandidate[] => {
  const candidates: KeychainCandidate[] = [];
  for (const record of text.split(/(?=^keychain:)/m)) {
    if (!/^class: "genp"$/m.test(record)) continue;
    const attribute = (name: string) => {
      const match = record.match(new RegExp(`^\\s*"${name}"<blob>="((?:\\\\.|[^"\\\\])*)"`, "m"));
      if (!match) return undefined;
      try {
        return decodeQuoted(`"${match[1]}"`);
      } catch {
        return undefined;
      }
    };
    const service = attribute("svce");
    const account = attribute("acct");
    if (service && account && isCandidate({ service, account }))
      candidates.push({ service, account });
  }
  return candidates;
};

export const parseWindowsKeychain = (text: string): KeychainCandidate[] => {
  const candidates: KeychainCandidate[] = [];
  for (const record of text.split(/(?=^\s*Target:)/m)) {
    const service = record
      .match(/^\s*Target:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^LegacyGeneric:target=/, "");
    const account = record.match(/^\s*User:\s*(.+)$/m)?.[1]?.trim();
    if (service && account && isCandidate({ service, account }))
      candidates.push({ service, account });
  }
  return candidates;
};

export const selectKeychainCandidates = (
  candidates: ReadonlyArray<KeychainCandidate>,
  query: string | undefined,
) => {
  const needle = query?.trim().toLowerCase() ?? "";
  const unique = new Map(
    candidates.map((candidate) => [
      `${candidate.service.length}:${candidate.service}${candidate.account}`,
      candidate,
    ]),
  );
  return [...unique.values()]
    .filter((candidate) =>
      `${candidate.service}\n${candidate.account}`.toLowerCase().includes(needle),
    )
    .sort((a, b) => a.service.localeCompare(b.service) || a.account.localeCompare(b.account))
    .slice(0, 200);
};
