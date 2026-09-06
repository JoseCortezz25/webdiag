#!/usr/bin/env bash
#
# Installs a pinned testssl.sh into vendor/ for the SEC probe.
#
# Pinned rather than tracking master, for the reason spec §7 gives: a run is only
# comparable to the last one if the tool version is known, and `meta.json` records
# what this script installed. Bumping the version here is a deliberate act that
# invalidates comparisons against older runs — which is exactly what it should be.
#
# vendor/ is git-ignored. testssl.sh is GPLv2 and ~1 MB of shell plus its cipher
# mapping data; vendoring it into the repository would put a second project's
# license and release cycle inside this one.

set -euo pipefail

VERSION="${TESTSSL_VERSION:-3.2.1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${ROOT}/vendor/testssl.sh"
ARCHIVE="https://github.com/testssl/testssl.sh/archive/refs/tags/v${VERSION}.tar.gz"

# `testssl.sh --version` prints ANSI attributes regardless of --color, so they
# are stripped here rather than echoed into the operator's terminal as noise.
report_version() {
  "${TARGET}/testssl.sh" --version 2>/dev/null |
    tr -d '\033' |
    sed -e 's/\[[0-9;]*m//g' -e 's/.*version[^0-9]*\([0-9][^ ]*\).*/  version \1/p' -e d |
    head -1
}

if [ -x "${TARGET}/testssl.sh" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "testssl.sh already installed at ${TARGET}/testssl.sh"
  report_version
  echo "  re-install with FORCE=1 bun run install:testssl"
  exit 0
fi

for tool in curl tar; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "error: ${tool} is required to install testssl.sh" >&2
    exit 1
  }
done

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "Downloading testssl.sh v${VERSION}..."
curl --fail --silent --show-error --location --max-time 180 --output "${WORK}/testssl.tar.gz" "${ARCHIVE}"

mkdir -p "${ROOT}/vendor"
rm -rf "${TARGET}"
tar xzf "${WORK}/testssl.tar.gz" -C "${WORK}"
mv "${WORK}/testssl.sh-${VERSION}" "${TARGET}"
chmod +x "${TARGET}/testssl.sh"

echo "Installed to ${TARGET}/testssl.sh"
report_version
