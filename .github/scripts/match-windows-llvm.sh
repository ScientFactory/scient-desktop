#!/usr/bin/env bash
# A Windows image can ship a Visual Studio C++ library newer than its LLVM supports.
# Upgrade only when clang++ cannot build against that library (STL1000).
set -euo pipefail
probe="$RUNNER_TEMP/stl-probe"
mkdir -p "$probe"
printf '#include <concepts>\nint main() { return 0; }\n' > "$probe/a.cpp"
clang="/c/Program Files/LLVM/bin/clang++.exe"
"$clang" --version | head -n 1
if "$clang" -std=gnu++2b "$probe/a.cpp" -o "$probe/a.exe" 2> "$probe/err.txt"; then
  echo "clang++ builds against this image's C++ library."
  exit 0
fi
grep -q STL1000 "$probe/err.txt" || { cat "$probe/err.txt"; exit 1; }
echo "clang++ is older than this image's C++ library; updating LLVM."
choco upgrade llvm -y --no-progress > "$probe/choco.txt" || { tail -n 40 "$probe/choco.txt"; exit 1; }
"$clang" --version | head -n 1
"$clang" -std=gnu++2b "$probe/a.cpp" -o "$probe/a.exe"
