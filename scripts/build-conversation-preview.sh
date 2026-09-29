#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source_root="$repo_root/native/conversation-preview"
build_root="${SCIC_PREVIEW_BUILD_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/scient-conversation-preview.XXXXXX")}"

fetch_verified() {
  local url="$1" expected="$2" destination="$3" actual=""
  if [[ -f "$destination" ]]; then
    actual="$(shasum -a 256 "$destination")"
    if [[ "${actual%% *}" == "$expected" ]]; then return; fi
  fi
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    --max-time 120 --output "$destination.part" "$url"
  actual="$(shasum -a 256 "$destination.part")"
  if [[ "${actual%% *}" != "$expected" ]]; then
    printf 'Checksum mismatch for %s\n' "$url" >&2
    return 1
  fi
  mv -f "$destination.part" "$destination"
}

if [[ "$(uname -s)" == Darwin ]]; then
  variant="${SCIC_PREVIEW_MAC_ARCH:-$(uname -m)}"
  case "$variant" in
    arm64|x86_64) cmake_archs="$variant"; xcode_archs="$variant" ;;
    universal) cmake_archs='arm64;x86_64'; xcode_archs='arm64 x86_64' ;;
    *) printf 'Unsupported SCIC_PREVIEW_MAC_ARCH: %s (use arm64, x86_64, or universal)\n' "$variant" >&2; exit 2 ;;
  esac
  minimum="${SCIC_PREVIEW_MACOS_MIN:-12.0}"
  if [[ ! "$minimum" =~ ^[0-9]+\.[0-9]+$ ]]; then
    printf 'SCIC_PREVIEW_MACOS_MIN must be a major.minor version\n' >&2
    exit 2
  fi
  if (( ${minimum%%.*} < 12 )); then
    printf 'Quick Look preview extensions require macOS 12.0 or newer\n' >&2
    exit 2
  fi
  bundle_id="${SCIC_PREVIEW_BUNDLE_ID:-com.scientfactory.scient.conversation-preview}"
  if [[ ! "$bundle_id" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]; then
    printf 'SCIC_PREVIEW_BUNDLE_ID must be a dotted bundle identifier\n' >&2
    exit 2
  fi
  sdk_root="$(xcrun --show-sdk-path)"
  mkdir -p "$build_root/downloads"
  dependency_root="$build_root/sources"
  stage="$build_root/macos-$variant"
  mkdir -p "$dependency_root" "$stage"

  json_archive="$build_root/downloads/json-c-0.19-nodoc.tar.gz"
  fetch_verified \
    'https://s3.amazonaws.com/json-c_releases/releases/json-c-0.19-nodoc.tar.gz' \
    '704927172443309a8efeb162060bb215548e1286e5568514007dd2cc35a0a164' \
    "$json_archive"
  archive_headers="$build_root/downloads/libarchive-3.8.7.tar.gz"
  fetch_verified \
    'https://libarchive.org/downloads/libarchive-3.8.7.tar.gz' \
    '4b787cca6697a95c7725e45293c973c208cbdc71ae2279f30ef09f52472b9166' \
    "$archive_headers"

  tar -xzf "$json_archive" -C "$dependency_root"
  tar -xzf "$archive_headers" -C "$dependency_root" \
    libarchive-3.8.7/libarchive/archive.h \
    libarchive-3.8.7/libarchive/archive_entry.h

  json_prefix="$stage/json-c-install"
  cmake -S "$dependency_root/json-c-0.19" -B "$stage/json-c-build" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET="$minimum" \
    -DCMAKE_OSX_ARCHITECTURES="$cmake_archs" \
    -DCMAKE_INSTALL_PREFIX="$json_prefix" \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON \
    -DBUILD_TESTING=OFF -DBUILD_APPS=OFF -DDISABLE_EXTRA_LIBS=ON
  cmake --build "$stage/json-c-build" --config Release --parallel
  cmake --install "$stage/json-c-build" --config Release

  cmake -S "$source_root" -B "$stage/native-build" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$minimum" \
    -DCMAKE_OSX_ARCHITECTURES="$cmake_archs" \
    -DSCIC_JSON_C_ROOT="$json_prefix" \
    -DLibArchive_LIBRARY="$sdk_root/usr/lib/libarchive.tbd" \
    -DLibArchive_INCLUDE_DIR="$dependency_root/libarchive-3.8.7/libarchive"
  cmake --build "$stage/native-build" --config Release --parallel
  xcodebuild -quiet -project "$source_root/macos/ScientConversationQuickLook.xcodeproj" \
    -target ScientConversationQuickLook -configuration Release \
    SYMROOT="$stage/xcode" OBJROOT="$stage/xcode-objects" \
    ARCHS="$xcode_archs" ONLY_ACTIVE_ARCH=NO \
    MACOSX_DEPLOYMENT_TARGET="$minimum" CODE_SIGNING_ALLOWED=NO \
    PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" \
    OTHER_LDFLAGS="-L$stage/native-build -lscic_preview -larchive $json_prefix/lib/libjson-c.a -lc++" \
    build

  preview_bundle="$stage/xcode/Release/ScientConversationQuickLook.appex"
  built_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$preview_bundle/Contents/Info.plist")"
  if [[ "$built_bundle_id" != "$bundle_id" ]]; then
    printf 'Quick Look bundle identifier mismatch: %s\n' "$built_bundle_id" >&2
    exit 1
  fi
  preview_binary="$preview_bundle/Contents/MacOS/ScientConversationQuickLook"
  for candidate in "$preview_binary" "$stage/native-build/scic-preview" "$json_prefix/lib/libjson-c.a"; do
    actual_archs="$(lipo -archs "$candidate")"
    read -r -a actual_parts <<< "$actual_archs"
    read -r -a expected_parts <<< "$xcode_archs"
    if [[ ${#actual_parts[@]} -ne ${#expected_parts[@]} ]]; then
      printf 'Architecture mismatch in %s: %s\n' "$candidate" "$actual_archs" >&2
      exit 1
    fi
    for expected_arch in "${expected_parts[@]}"; do
      if [[ " $actual_archs " != *" $expected_arch "* ]]; then
        printf 'Missing %s in %s\n' "$expected_arch" "$candidate" >&2
        exit 1
      fi
    done
  done
  runtime_links="$(otool -L "$preview_binary")"
  if [[ "$runtime_links" == *'/opt/homebrew/'* || "$runtime_links" == *'/usr/local/'* ]]; then
    printf 'Quick Look extension links to a host-local library\n' >&2
    exit 1
  fi
  printf 'Quick Look extension: %s\n' "$preview_bundle"
  printf 'Diagnostic viewer: %s\n' "$stage/native-build/scic-preview"
  printf 'Architectures: %s; macOS minimum: %s\n' "$xcode_archs" "$minimum"
else
  cmake -S "$source_root" -B "$build_root" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$build_root" --config Release --parallel
  printf 'Diagnostic viewer: %s\n' "$build_root/scic-preview"
fi
