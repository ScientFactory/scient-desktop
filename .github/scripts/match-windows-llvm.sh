#!/usr/bin/env bash
# A Windows image can ship a Visual Studio C++ library newer than its LLVM supports.
# Upgrade only when clang++ cannot build against that library (STL1000).
set -euo pipefail
probe="$RUNNER_TEMP/stl-probe"
mkdir -p "$probe"
printf '#include <concepts>\nint main() { return 0; }\n' > "$probe/a.cpp"
clang="/c/Program Files/LLVM/bin/clang++.exe"
builds() { "$clang" -std=gnu++2b "$probe/a.cpp" -o "$probe/a.exe" 2> "$probe/err.txt"; }
"$clang" --version | head -n 1
if builds; then
  echo "clang++ builds against this image's C++ library."
  exit 0
fi
grep -q STL1000 "$probe/err.txt" || { cat "$probe/err.txt"; exit 1; }
echo "clang++ is older than this image's C++ library; updating LLVM."
# Chocolatey can exit 0 without upgrading, so the compiler decides and a no-op upgrade is retried.
for attempt in 1 2 3; do
  choco upgrade llvm -y --no-progress > "$probe/choco.txt" 2>&1 || { tail -n 40 "$probe/choco.txt"; exit 1; }
  "$clang" --version | head -n 1
  if builds; then exit 0; fi
  echo "Attempt $attempt left clang++ unable to build against this library; Chocolatey said:"
  tail -n 20 "$probe/choco.txt"
  [ "$attempt" -lt 3 ] && sleep 30
done
cat "$probe/err.txt"
exit 1
