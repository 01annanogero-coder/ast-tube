#!/usr/bin/env bash
# Builds a release APK, signs it with key rotation, checks it, backs it up and
# (with --publish) attaches it to the GitHub release v<version>.
#
#   scripts/release.sh             build + sign + verify + back up
#   scripts/release.sh --publish   ... and upload to GitHub (the in-app updater picks it up)
#
# Signing: APKs up to 1.0.0 were signed with this PC's Android debug key. Android only
# installs an update signed by the same key, so every release is signed with both:
#   - the release key (APK Signature Scheme v3, Android 9+), plus a "lineage" proof that
#     the debug key handed over to it, so Android 9+ installs accept the update;
#   - the old debug key (v1/v2 signatures), which Android 7-8 still check.
# Paths and passwords come from app/android/key.properties (git-ignored).
# Backup of keys, passwords and lineage: E:\Baackup_01Ann\<app>_keys
set -euo pipefail

APP=ASTTube                                   # APK name: ASTTube-<version>.apk (Updater.kt expects this)
REPO=01annanogero-coder/ast-tube
BACKUP="${RELEASE_BACKUP:-/e/Baackup_01Ann/ast_tube_release}"     # override for test runs

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/app"
PROPS=android/key.properties
[ -f "$PROPS" ] || { echo "Missing $PROPS (see the keys backup)"; exit 1; }
prop() { grep -E "^$1=" "$PROPS" | head -1 | cut -d= -f2-; }

SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
APKSIGNER="$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)apksigner.bat"
export JAVA_HOME="${JAVA_HOME:-/c/Program Files/Android/Android Studio/jbr}"
export PATH="$JAVA_HOME/bin:$PATH"

VERSION=$(grep -E '^version:' pubspec.yaml | sed -E 's/version: *([^+ ]+).*/\1/')
OUT="$ROOT/dist/$APP-$VERSION.apk"
echo "== $APP $VERSION"

flutter build apk --release

mkdir -p "$ROOT/dist"
# Passwords go through environment variables, never the command line.
export NEW_KS_PASS="$(prop storePassword)" OLD_KS_PASS="$(prop oldStorePassword)"
"$APKSIGNER" sign \
  --ks "$(prop oldStoreFile)" --ks-key-alias "$(prop oldKeyAlias)" --ks-pass env:OLD_KS_PASS \
  --next-signer --ks "$(prop storeFile)" --ks-key-alias "$(prop keyAlias)" --ks-pass env:NEW_KS_PASS \
  --lineage "$(prop lineageFile)" --rotation-min-sdk-version 28 \
  --out "$(cygpath -w "$OUT")" "$(cygpath -w build/app/outputs/flutter-apk/app-release.apk)" 2>&1 | grep -v WARNING || true
unset NEW_KS_PASS OLD_KS_PASS

echo "== signatures"
"$APKSIGNER" verify --verbose --print-certs "$(cygpath -w "$OUT")" 2>&1 \
  | grep -E "Verified using|Signer .*certificate DN|rotat" | grep -v WARNING
"$APKSIGNER" verify "$(cygpath -w "$OUT")" >/dev/null 2>&1 || { echo "Signature check FAILED"; exit 1; }

SUM=$(sha256sum "$OUT" | cut -d' ' -f1)
echo "== sha256 $SUM"

# Back up the APK next to the keys, like the other apps.
if [ -d "$(dirname "$BACKUP")" ]; then
  mkdir -p "$BACKUP"
  cp "$OUT" "$BACKUP/"
  grep -v "  $APP-$VERSION.apk\$" "$BACKUP/SHA256SUMS.txt" 2>/dev/null > "$BACKUP/SHA256SUMS.tmp" || true
  echo "$SUM  $APP-$VERSION.apk" >> "$BACKUP/SHA256SUMS.tmp"
  mv "$BACKUP/SHA256SUMS.tmp" "$BACKUP/SHA256SUMS.txt"
  echo "== backed up to $BACKUP"
else
  echo "== backup drive not found ($BACKUP): skipped"
fi

if [ "${1:-}" = "--publish" ]; then
  if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
    gh release upload "v$VERSION" "$(cygpath -w "$OUT")" --repo "$REPO" --clobber
  else
    gh release create "v$VERSION" "$(cygpath -w "$OUT")" --repo "$REPO" --title "${APP/ASTTube/AST Tube} $VERSION" --generate-notes
  fi
  echo "== published v$VERSION"
fi
echo "Done: $OUT"
