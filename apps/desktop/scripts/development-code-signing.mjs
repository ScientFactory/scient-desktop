import * as NodeFS from "node:fs";

/** Keep every distinct signing target, but never sign it again through a symlink. */
export function createDuplicateSigningFilter() {
  const visited = new Set();
  return (filePath) => {
    const canonicalPath = NodeFS.realpathSync(filePath);
    const duplicate = visited.has(canonicalPath);
    visited.add(canonicalPath);
    return duplicate;
  };
}
