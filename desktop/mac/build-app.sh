#!/bin/sh
# Builds "Anemo Desktop.app" and a zip of it, on a Mac (docs/specs/09-desktop-macos.md D10).
#
#   cd desktop && sh mac/build-app.sh [osx-arm64|osx-x64]
#
# Output: publish/<rid>/Anemo Desktop.app and publish/Anemo-Desktop-macos-<arch>.zip.
#
# Signing: with MACOS_SIGNING_IDENTITY set (e.g. "Developer ID Application: Name (TEAMID)",
# its certificate in the keychain) the app is signed with the hardened runtime, ready for
# notarization (the release workflow does that). Without it the app is signed ad hoc
# ("codesign -s -"): it runs on this Mac (right-click > Open the first time elsewhere), and
# macOS forgets its Screen Recording and Accessibility permissions at every new build.
set -eu

rid="${1:-osx-arm64}"
case "$rid" in
  osx-arm64) arch=arm64 ;;
  osx-x64) arch=x64 ;;
  *) echo "usage: sh mac/build-app.sh [osx-arm64|osx-x64]" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(cd "$here/.." && pwd)"
out="$desktop/publish/$rid"
app="$out/Anemo Desktop.app"
version="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$desktop/Directory.Build.props")"

echo "== publish $rid ($version)"
rm -rf "$out"
dotnet publish "$desktop/src/Anemo.Desktop.Mac/Anemo.Desktop.Mac.csproj" -c Release -r "$rid" --self-contained \
  -o "$out/bin"

echo "== bundle"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp -R "$out/bin/." "$app/Contents/MacOS/"
sed "s/__VERSION__/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

# The icon: the Windows client's .ico, made into an .icns (sips and iconutil come with macOS).
icons="$out/Anemo.iconset"
mkdir -p "$icons"
if sips -s format png "$desktop/src/Anemo.Desktop/Assets/Anemo.ico" --out "$icons/base.png" >/dev/null 2>&1; then
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$icons/base.png" --out "$icons/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$icons/base.png" --out "$icons/icon_${size}x${size}@2x.png" >/dev/null
  done
  rm "$icons/base.png"
  iconutil -c icns "$icons" -o "$app/Contents/Resources/Anemo.icns" || echo "(no icon: iconutil failed)"
else
  echo "(no icon: sips couldn't read the .ico)"
fi
rm -rf "$icons" "$out/bin"

echo "== sign"
entitlements="$here/Entitlements.plist"
if [ -n "${MACOS_SIGNING_IDENTITY:-}" ]; then
  # Inside out: every library and the executable, then the bundle. Hardened runtime + timestamp
  # are what notarization asks for.
  find "$app/Contents/MacOS" -type f \( -name '*.dylib' -o -name '*.so' \) -print0 |
    xargs -0 -I{} codesign --force --timestamp --options runtime --sign "$MACOS_SIGNING_IDENTITY" "{}"
  codesign --force --timestamp --options runtime --entitlements "$entitlements" \
    --sign "$MACOS_SIGNING_IDENTITY" "$app/Contents/MacOS/Anemo Desktop"
  codesign --force --timestamp --options runtime --entitlements "$entitlements" \
    --sign "$MACOS_SIGNING_IDENTITY" "$app"
  echo "signed with $MACOS_SIGNING_IDENTITY"
else
  codesign --force --deep --sign - --entitlements "$entitlements" "$app"
  echo "signed ad hoc (no MACOS_SIGNING_IDENTITY): permissions are lost at every update"
fi
codesign --verify --deep --strict --verbose=2 "$app"

echo "== zip"
zip="$desktop/publish/Anemo-Desktop-macos-$arch.zip"
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
echo "$zip"
