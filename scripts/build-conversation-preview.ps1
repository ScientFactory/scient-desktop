param(
  [string]$Triplet = "x64-windows-static",
  [string]$BuildDirectory = (Join-Path $env:TEMP "scient-conversation-preview-windows")
)
$ErrorActionPreference = "Stop"
$pinnedRevision = "9e593bb18ea69cc5095e012465dcd675a822ed0d"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $repo "native/conversation-preview"
if (-not $env:VCPKG_ROOT) { throw "Set VCPKG_ROOT to the pinned vcpkg checkout." }
$toolchain = (Resolve-Path -LiteralPath $env:VCPKG_ROOT).Path
$actualRoot = [IO.Path]::GetFullPath((& git -C $toolchain rev-parse --show-toplevel).Trim())
$revision = (& git -C $toolchain rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or
    -not [string]::Equals($actualRoot, $toolchain, [StringComparison]::OrdinalIgnoreCase) -or
    $revision -ne $pinnedRevision) {
  throw "VCPKG_ROOT must be the checkout at pinned revision $pinnedRevision."
}
$trackedChanges = & git -C $toolchain status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0 -or $trackedChanges) { throw "The pinned vcpkg checkout has tracked changes." }
$untrackedInputs = & git -C $toolchain ls-files --others -- ports triplets scripts versions vcpkg-configuration.json
if ($LASTEXITCODE -ne 0 -or $untrackedInputs) { throw "The pinned vcpkg checkout has untracked toolchain inputs." }
if ($Triplet -eq "x64-windows-static") { $architecture = "x64" }
elseif ($Triplet -eq "arm64-windows-static") { $architecture = "ARM64" }
else { throw "Unsupported triplet $Triplet; use x64-windows-static or arm64-windows-static." }
$identity = if ($env:SCIC_PREVIEW_CLSID) { $env:SCIC_PREVIEW_CLSID } else { "{E0C925A3-E41D-4969-B093-4B6B16028463}" }
if ($identity -notmatch '^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$') {
  throw "SCIC_PREVIEW_CLSID must be a braced GUID."
}

$build = [IO.Path]::GetFullPath($BuildDirectory)
if ($build.StartsWith(($toolchain.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or
    [string]::Equals($build, $toolchain, [StringComparison]::OrdinalIgnoreCase)) {
  throw "BuildDirectory must be outside the pinned vcpkg checkout."
}
if (Test-Path -LiteralPath $build) {
  $buildItem = Get-Item -LiteralPath $build
  if (-not $buildItem.PSIsContainer -or ($buildItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      (Get-ChildItem -LiteralPath $build -Force | Select-Object -First 1)) {
    throw "BuildDirectory must be a fresh empty directory."
  }
} else {
  New-Item -ItemType Directory -Path $build | Out-Null
}
$installed = Join-Path $build "vcpkg-installed"

# Clear inherited vcpkg, CMake, and package-discovery inputs before both install and configure.
Get-ChildItem Env: | Where-Object {
  $_.Name -match '^(VCPKG_|X_VCPKG_|CMAKE_|PKG_CONFIG_)' -or
  $_.Name -match '^(LibArchive|libarchive|json-c)_(ROOT|DIR|LIBRARY|INCLUDE_DIR)$' -or
  $_.Name -match '^(CL|_CL_|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|LIBRARY_PATH)$'
} | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$env:VCPKG_ROOT = $toolchain
$env:VCPKG_BINARY_SOURCES = "clear"
$env:VCPKG_DISABLE_METRICS = "1"

& (Join-Path $toolchain "bootstrap-vcpkg.bat") -disableMetrics
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$vcpkg = Join-Path $toolchain "vcpkg.exe"
Push-Location $build
try {
  & $vcpkg install "zlib:$Triplet" "json-c:$Triplet" `
    "--x-install-root=$installed" "--x-buildtrees-root=$(Join-Path $build 'vcpkg-buildtrees')" `
    "--x-packages-root=$(Join-Path $build 'vcpkg-packages')" "--downloads-root=$(Join-Path $build 'vcpkg-downloads')" `
    --disable-metrics --binarysource=clear
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
if (-not (Test-Path -LiteralPath (Join-Path $installed "$Triplet/share/zlib/copyright")) -or
    -not (Test-Path -LiteralPath (Join-Path $installed "$Triplet/share/json-c/copyright"))) {
  throw "The isolated vcpkg install is missing required dependency notices."
}

# Let CMake select the installed Visual Studio generator; pin its dependency search to this install.
cmake -S $source -B $build -A $architecture -DCMAKE_BUILD_TYPE=Release `
  "-DCMAKE_TOOLCHAIN_FILE=$(Join-Path $toolchain 'scripts/buildsystems/vcpkg.cmake')" `
  "-DVCPKG_TARGET_TRIPLET=$Triplet" "-DVCPKG_INSTALLED_DIR=$installed" `
  -DVCPKG_MANIFEST_MODE=OFF -DCMAKE_DISABLE_FIND_PACKAGE_LibArchive=TRUE `
  -DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF `
  -DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF "-DSCIC_PREVIEW_CLSID=$identity"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$cache = Get-Content -LiteralPath (Join-Path $build "CMakeCache.txt")
$installedPrefix = $installed.Replace('\', '/').TrimEnd('/') + '/'
foreach ($name in @("json-c_DIR", "ZLIB_INCLUDE_DIR")) {
  $entry = $cache | Where-Object { $_ -match "^$([regex]::Escape($name)):[^=]*=" } | Select-Object -First 1
  $resolved = if ($entry) { ($entry -replace '^[^=]*=', '').Replace('\', '/') } else { "" }
  if (-not $resolved.StartsWith($installedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "CMake did not resolve $name from the isolated vcpkg install."
  }
}
$hasReleaseZlib = $false
foreach ($name in @("ZLIB_LIBRARY_RELEASE", "ZLIB_LIBRARY_DEBUG", "ZLIB_LIBRARY")) {
  $entry = $cache | Where-Object { $_ -match "^$([regex]::Escape($name)):[^=]*=" } | Select-Object -First 1
  if (-not $entry) { continue }
  $value = $entry -replace '^[^=]*=', ''
  if (-not $value -or $value.EndsWith('-NOTFOUND')) { continue }
  $paths = @($value.Split(';') | Where-Object { $_ -and $_ -notin @('optimized', 'debug', 'general') })
  if (-not $paths) { continue }
  foreach ($libraryPath in $paths) {
    if (-not $libraryPath.Replace('\', '/').StartsWith($installedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "CMake resolved $name outside the isolated vcpkg install."
    }
  }
  if ($name -ne "ZLIB_LIBRARY_DEBUG") { $hasReleaseZlib = $true }
}
if (-not $hasReleaseZlib) { throw "CMake did not resolve a release zlib library from the isolated vcpkg install." }
$archiveCopying = Join-Path $build "_deps/scic_libarchive-src/COPYING"
if (-not (Test-Path -LiteralPath $archiveCopying -PathType Leaf)) {
  throw "CMake did not fetch the pinned libarchive source COPYING."
}
$archiveEntry = $cache | Where-Object { $_ -match '^LibArchive_LIBRARY:[^=]*=' } | Select-Object -First 1
if ($archiveEntry) {
  $archiveLibrary = ($archiveEntry -replace '^[^=]*=', '').Replace('\', '/')
  $buildPrefix = $build.Replace('\', '/').TrimEnd('/') + '/'
  if ($archiveLibrary -ne 'LibArchive_LIBRARY-NOTFOUND' -and
      -not $archiveLibrary.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "CMake resolved libarchive outside the pinned source build."
  }
}
cmake --build $build --config Release --parallel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($architecture -eq "x64") {
  ctest --test-dir $build --build-config Release --output-on-failure
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host "Preview handler DLL and CLI built in $build with dependencies from $installed"
