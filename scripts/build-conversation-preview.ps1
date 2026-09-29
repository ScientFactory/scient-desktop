param(
  [string]$Triplet = "x64-windows-static",
  [string]$BuildDirectory = (Join-Path $env:TEMP "scient-conversation-preview-windows")
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $repo "native/conversation-preview"
$build = $BuildDirectory
if (-not $env:VCPKG_ROOT) { throw "Set VCPKG_ROOT to a vcpkg checkout with libarchive and json-c installed for $Triplet." }
if ($Triplet -eq "x64-windows-static") { $architecture = "x64" }
elseif ($Triplet -eq "arm64-windows-static") { $architecture = "ARM64" }
else { throw "Unsupported triplet $Triplet; use x64-windows-static or arm64-windows-static." }
$identity = if ($env:SCIC_PREVIEW_CLSID) { $env:SCIC_PREVIEW_CLSID } else { "{E0C925A3-E41D-4969-B093-4B6B16028463}" }
if ($identity -notmatch '^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$') {
  throw "SCIC_PREVIEW_CLSID must be a braced GUID."
}
# Let CMake select the installed Visual Studio generator (runner images can
# advance beyond VS 2022); retain the explicit target architecture and triplet.
cmake -S $source -B $build -A $architecture -DCMAKE_BUILD_TYPE=Release "-DCMAKE_TOOLCHAIN_FILE=$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" "-DVCPKG_TARGET_TRIPLET=$Triplet" "-DSCIC_PREVIEW_CLSID=$identity"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cmake --build $build --config Release --parallel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($architecture -eq "x64") {
  ctest --test-dir $build --build-config Release --output-on-failure
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host "Preview handler DLL and CLI built in $build"
