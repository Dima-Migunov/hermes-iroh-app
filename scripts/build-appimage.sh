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

cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/hermes-iroh-app"
tool="${APPIMAGETOOL:-$cache_dir/appimagetool-$image_arch.AppImage}"

if [ ! -x "$tool" ]; then
  mkdir -p "$cache_dir"
  url="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$image_arch.AppImage"
  echo "Downloading $url"
  curl -fsSL "$url" -o "$tool"
  chmod +x "$tool"
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

APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$image_arch" "$tool" "$appdir" "$output"

size="$(stat -c '%s' "$output")"
echo "Built $output ($size bytes)"
