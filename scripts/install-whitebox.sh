#!/usr/bin/env bash
#
# Installs the two pinned binaries the white-box DEPS probe drives: osv-scanner
# and Syft.
#
# Same reasoning as `install-testssl.sh`: pinned rather than "latest", because a
# run is only comparable to the previous one if the tool version is known, and
# `meta.json` records what this script installed. Bumping a version here is a
# deliberate act that invalidates comparisons against older runs.
#
# vendor/ is git-ignored. Both tools are single Go binaries in the 50-100 MB
# range; vendoring them would put two other projects' release cycles inside this
# repository.

set -euo pipefail

OSV_VERSION="${OSV_SCANNER_VERSION:-2.5.1}"
SYFT_VERSION="${SYFT_VERSION:-1.51.1}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="${ROOT}/vendor"

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *) echo "error: unsupported OS $(uname -s); install osv-scanner and syft manually" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) ARCH="arm64" ;;
  x86_64 | amd64) ARCH="amd64" ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

for tool in curl tar; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "error: ${tool} is required" >&2
    exit 1
  }
done

mkdir -p "${VENDOR}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

install_osv() {
  local target="${VENDOR}/osv-scanner"

  if [ -x "${target}" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "osv-scanner already installed at ${target}"
    "${target}" --version 2>/dev/null | head -1 | sed 's/^/  /'
    return 0
  fi

  local url="https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}/osv-scanner_${OS}_${ARCH}"
  echo "Downloading osv-scanner v${OSV_VERSION}..."
  curl --fail --silent --show-error --location --max-time 600 --output "${WORK}/osv-scanner" "${url}"
  chmod +x "${WORK}/osv-scanner"
  mv "${WORK}/osv-scanner" "${target}"
  echo "Installed to ${target}"
  "${target}" --version 2>/dev/null | head -1 | sed 's/^/  /'
}

install_syft() {
  local target="${VENDOR}/syft"

  if [ -x "${target}" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "syft already installed at ${target}"
    "${target}" version --output text 2>/dev/null | head -2 | sed 's/^/  /'
    return 0
  fi

  local url="https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_${OS}_${ARCH}.tar.gz"
  echo "Downloading syft v${SYFT_VERSION}..."
  curl --fail --silent --show-error --location --max-time 600 --output "${WORK}/syft.tar.gz" "${url}"
  mkdir -p "${WORK}/syft-extract"
  tar xzf "${WORK}/syft.tar.gz" -C "${WORK}/syft-extract"
  chmod +x "${WORK}/syft-extract/syft"
  mv "${WORK}/syft-extract/syft" "${target}"
  echo "Installed to ${target}"
  "${target}" version --output text 2>/dev/null | head -2 | sed 's/^/  /'
}

install_osv
install_syft

echo
echo "Both binaries are optional: the white-box probe degrades and says so in the"
echo "report when either is missing."
