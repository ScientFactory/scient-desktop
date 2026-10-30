import type { DiscoveryContext, RuntimeDiscoveryHost } from "./RuntimeDiscovery.ts";

/**
 * An in-memory host. Paths ending in "/" or "\\" are directories; `links` map a path to its target,
 * and a link to a missing target dangles. Every listed file is executable unless in `plain`.
 */
export function fakeDiscoveryHost(input: {
  readonly separator?: "/" | "\\";
  readonly files?: ReadonlyArray<string>;
  readonly plain?: ReadonlyArray<string>;
  readonly text?: Readonly<Record<string, string>>;
  readonly links?: Readonly<Record<string, string>>;
  readonly registrations?: ReadonlyArray<string>;
}): RuntimeDiscoveryHost {
  const separator = input.separator ?? "/";
  const fold = (path: string) => (separator === "\\" ? path.toLowerCase() : path);
  const files = new Set(
    [...(input.files ?? []), ...(input.plain ?? []), ...Object.keys(input.text ?? {})].map(fold),
  );
  const plain = new Set((input.plain ?? []).map(fold));
  const text = new Map(
    Object.entries(input.text ?? {}).map(([path, value]) => [fold(path), value]),
  );
  const links = new Map(
    Object.entries(input.links ?? {}).map(([path, target]) => [fold(path), target]),
  );
  const resolve = (path: string, depth = 0): string | null => {
    const target = links.get(fold(path));
    if (target === undefined) return path;
    return depth > 8 ? null : resolve(target, depth + 1);
  };
  const originals = [
    ...(input.files ?? []),
    ...(input.plain ?? []),
    ...Object.keys(input.text ?? {}),
    ...Object.keys(input.links ?? {}),
  ];
  const directories = new Set<string>();
  const listed: string[] = [];
  for (const path of originals) {
    const parts = path.split(separator);
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join(separator);
      if (index < parts.length) directories.add(fold(prefix));
      listed.push(prefix);
    }
  }
  const kind = (path: string): "file" | "directory" | null => {
    const resolved = resolve(path);
    if (resolved === null) return null;
    const key = fold(resolved).replace(/[\\/]$/u, "");
    if (files.has(key)) return "file";
    if (directories.has(key)) return "directory";
    return null;
  };
  return {
    kind,
    isDanglingLink: (path) => links.has(fold(path)) && kind(path) === null,
    isExecutable: (path) => kind(path) === "file" && !plain.has(fold(resolve(path) ?? "")),
    readDirectory: (path) => {
      const prefix = `${fold(path).replace(/[\\/]$/u, "")}${separator}`;
      const names = new Set<string>();
      for (const candidate of listed) {
        if (!fold(candidate).startsWith(prefix)) continue;
        const name = candidate.slice(prefix.length).split(separator)[0];
        if (name) names.add(name);
      }
      return [...names];
    },
    readText: (path) => text.get(fold(path)) ?? null,
    realPath: (path) => {
      const resolved = resolve(path);
      return resolved === null || kind(resolved) === null ? null : resolved;
    },
    windowsPythonRegistrations: () => Promise.resolve(input.registrations ?? []),
  };
}

export function fakeDiscoveryContext(
  platform: NodeJS.Platform,
  host: RuntimeDiscoveryHost,
  environment: Readonly<Record<string, string | undefined>> = {},
): DiscoveryContext {
  return {
    platform,
    environment,
    homeDirectory: platform === "win32" ? "C:\\Users\\ada" : "/home/ada",
    host,
  };
}
