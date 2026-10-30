#!/usr/bin/env sh
# Validate every e-invoice this module would serve against the reference
# validator, outside this repository's own code: Mustang (EN 16931 and
# XRechnung 3.0 schematron for the XML, veraPDF for PDF/A-3 conformance of the
# ZUGFeRD files). That is the golden cases and every case of the matrix in
# test/einvoice-matrix.ts that eInvoiceProblems does not refuse — a refused
# case is never served, an accepted one must be valid.
#
#   MUSTANG_JAR=/path/to/Mustang-CLI-2.26.0.jar scripts/validate-einvoice.sh
#
# Mustang-CLI is on Maven Central (org.mustangproject:Mustang-CLI). Needs Java 11+
# (scripts/MustangBatch.java runs as a single-file program, nothing to build).
# Exits non-zero if any file is invalid. CI runs this in
# .github/workflows/einvoice-validation.yml.
set -eu
cd "$(dirname "$0")/.."
: "${MUSTANG_JAR:?set MUSTANG_JAR to the Mustang-CLI jar}"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
npx tsx scripts/einvoice-fixtures.mts "$out" matrix
# All files through one JVM (MustangBatch.java): the same validator class as
# `java -jar "$MUSTANG_JAR" --action validate`, the schematron compiled once
# instead of once per file. Mustang logs every step at INFO; its errors stay.
find "$out" \( -name '*.xml' -o -name '*.pdf' \) | sort |
  xargs java -Dorg.slf4j.simpleLogger.defaultLogLevel=error -cp "$MUSTANG_JAR" scripts/MustangBatch.java
