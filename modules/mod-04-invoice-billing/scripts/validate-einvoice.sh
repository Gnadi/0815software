#!/usr/bin/env sh
# Validate every e-invoice case against the reference validator, outside this
# repository's own code: Mustang (EN 16931 and XRechnung 3.0 schematron for the
# XML, veraPDF for PDF/A-3 conformance of the ZUGFeRD files).
#
#   MUSTANG_JAR=/path/to/Mustang-CLI-2.26.0.jar scripts/validate-einvoice.sh
#
# Mustang-CLI is on Maven Central (org.mustangproject:Mustang-CLI). Needs Java 11+.
# Exits non-zero on the first invalid file.
set -eu
cd "$(dirname "$0")/.."
: "${MUSTANG_JAR:?set MUSTANG_JAR to the Mustang-CLI jar}"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
npx tsx scripts/einvoice-fixtures.mts "$out" pdf >/dev/null
status=0
for file in "$out"/*.xml "$out"/*.pdf; do
  result=$(java -jar "$MUSTANG_JAR" --action validate --source "$file" --no-notices --disable-file-logging 2>/dev/null || true)
  if printf '%s' "$result" | tail -3 | grep -q '<summary status="valid"/>'; then
    echo "valid    $(basename "$file")"
  else
    echo "INVALID  $(basename "$file")"
    printf '%s\n' "$result" | grep -E '<error|<warning' | head -10
    status=1
  fi
done
exit $status
