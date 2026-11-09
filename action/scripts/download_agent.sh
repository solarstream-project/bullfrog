#!/bin/bash

# Immediately exit if any command has a non-zero exit status
set -e

VERSION="v0.11.2"
CHECKSUM_AMD64="e86fee4200470d03dd81e7e1ca540e9f147f6ef62e336baea654c5734e1e2a3c"
CHECKSUM_ARM64="a041ec24caff555d0df49ab45ef5d9320602f631c12caa509bc7be48a92495b3"
# Release-asset IDs of the same ${VERSION} assets, for the API fallback route.
# Bump together with VERSION and the checksums:
#   gh api repos/bullfrogsec/agent/releases/tags/<version> --jq '.assets[] | "\(.id) \(.name) \(.digest)"'
ASSET_ID_AMD64="528487185"
ASSET_ID_ARM64="528487186"
BASE_DOWNLOAD_URL="https://github.com/bullfrogsec/agent/releases/download/"
ASSET_API_URL="https://api.github.com/repos/bullfrogsec/agent/releases/assets/"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/download_lib.sh
source "${SCRIPT_DIR}/download_lib.sh"

TMP_DIR="/tmp"
AGENT_FILE_PATH="${TMP_DIR}/agent"
FINAL_BIN_DIR="/opt/bullfrog"

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
  x86_64)
    AGENT_ARCH="amd64"
    CHECKSUM="$CHECKSUM_AMD64"
    ASSET_ID="$ASSET_ID_AMD64"
    ;;
  aarch64|arm64)
    AGENT_ARCH="arm64"
    CHECKSUM="$CHECKSUM_ARM64"
    ASSET_ID="$ASSET_ID_ARM64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

AGENT_FILE="$AGENT_FILE_PATH-$AGENT_ARCH.tar.gz"

echo "Downloading agent ${VERSION} for ${AGENT_ARCH}"
# Every attempt is checked against the pinned checksum; a mismatch is discarded
# and retried, never accepted (see download_lib.sh).
download_verified "$AGENT_FILE" "$CHECKSUM" \
  "${BASE_DOWNLOAD_URL}${VERSION}/agent-${AGENT_ARCH}.tar.gz" \
  "api:${ASSET_API_URL}${ASSET_ID}"

tar -xvf "$AGENT_FILE" -C $TMP_DIR

mkdir -p "$FINAL_BIN_DIR"
sudo mv -vf "$AGENT_FILE_PATH" "$FINAL_BIN_DIR/agent"
