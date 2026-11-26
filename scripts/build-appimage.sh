#!/usr/bin/env bash
# Builds a small AppImage that uses the system WebKitGTK 4.1 runtime.
# Tauri's bundled AppImage deploys WebKitGTK itself, which exceeds the 25 MB budget.
set -euo pipefail

binary="${1:-src-tauri/target/release/hermes-iroh-app}"
version="${2:-$(node -p "require('./package.json').version")}"
arch="${3:-$(uname -m)}"
output_dir="${4:-release}"

case "$arch" in
  x86_64 | x64 | amd64) image_arch="x86_64" ;;
  aarch64 | arm64) image_arch="aarch64" ;;
  *)
    echo "Unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

case "$image_arch" in
  x86_64) published_arch="x86_64" ;;
  aarch64) published_arch="arm64" ;;
esac

if [ ! -f "$binary" ]; then
  echo "Binary not found: $binary" >&2
  exit 1
fi

desktop_file="src-tauri/icons/128x128@2x.png"
if [ ! -f "$desktop_file" ]; then
  echo "Icon not found: $desktop_file" >&2
  exit 1
fi

# Pinned appimagetool release instead of the movable `continuous` tag.
APPIMAGETOOL_VERSION="${APPIMAGETOOL_VERSION:-1.9.1}"
# SHA-256 digests published with the 1.9.1 release; override only to bump the pin.
case "$image_arch" in
  x86_64)
    appimagetool_sha256="${APPIMAGETOOL_SHA256_X86_64:-ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0}"
    ;;
  aarch64)
    appimagetool_sha256="${APPIMAGETOOL_SHA256_AARCH64:-f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158}"
    ;;
esac

cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/hermes-iroh-app"
tool="${APPIMAGETOOL:-$cache_dir/appimagetool-$APPIMAGETOOL_VERSION-$image_arch.AppImage}"

verify_tool() {
  local path="$1"
  if [ -z "$appimagetool_sha256" ]; then
    echo "APPIMAGETOOL_SHA256_${image_arch} must be set so the tool can be verified." >&2
    return 1
  fi
  local actual
  actual="$(sha256sum "$path" | cut -d ' ' -f 1)"
  if [ "$actual" != "$appimagetool_sha256" ]; then
    echo "appimagetool checksum mismatch: expected $appimagetool_sha256, got $actual" >&2
    return 1
  fi
}

if [ ! -x "$tool" ]; then
  mkdir -p "$cache_dir"
  url="https://github.com/AppImage/appimagetool/releases/download/$APPIMAGETOOL_VERSION/appimagetool-$image_arch.AppImage"
  echo "Downloading $url"
  temporary="$(mktemp "$cache_dir/appimagetool.XXXXXX")"
  curl -fsSL "$url" -o "$temporary"
  verify_tool "$temporary"
  chmod +x "$temporary"
  mv "$temporary" "$tool"
else
  verify_tool "$tool"
fi

appdir="$(mktemp -d)"
chmod 755 "$appdir"
trap 'rm -rf "$appdir"' EXIT

mkdir -p "$appdir/usr/bin"
install -m 755 "$binary" "$appdir/usr/bin/hermes-iroh-app"
install -m 644 "$desktop_file" "$appdir/hermes-iroh-app.png"

cat >"$appdir/hermes-iroh-app.desktop" <<'EOF'
[Desktop Entry]
Categories=Utility;
Comment=Desktop client for the Hermes Agent Iroh-channel plugin
Exec=hermes-iroh-app
StartupWMClass=hermes-iroh-app
Icon=hermes-iroh-app
Name=Hermes Iroh App
Terminal=false
Type=Application
EOF

cat >"$appdir/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/hermes-iroh-app" "$@"
EOF
chmod +x "$appdir/AppRun"

mkdir -p "$output_dir"
output="$output_dir/hermes-iroh-app-$version-linux-$published_arch.AppImage"

# Write next to the destination, then rename, so a failed run never leaves a partial asset.
temporary_output="$output.tmp"
trap 'rm -rf "$appdir" "$temporary_output"' EXIT
APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$image_arch" "$tool" "$appdir" "$temporary_output"
mv "$temporary_output" "$output"

size="$(stat -c '%s' "$output")"
echo "Built $output ($size bytes)"
