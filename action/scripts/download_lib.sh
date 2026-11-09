#!/bin/bash
# Verified, retried download of the agent tarball. Sourced by download_agent.sh
# (and by the vitest harness in action/src/__tests__/download_agent.test.ts).
#
# download_verified <output-file> <sha256> <url> [<url>...]
#
# Tries every URL in order, as one round, up to DOWNLOAD_ROUNDS rounds, with an
# exponential backoff between rounds (DOWNLOAD_BACKOFF_SECONDS, doubled each
# round, capped at DOWNLOAD_BACKOFF_MAX_SECONDS). Every attempt downloads into a
# fresh temp file and is checked against the pinned sha256 before it is moved to
# <output-file>; a checksum mismatch discards the file and counts as a failed
# attempt. It never returns success for unverified bytes: when every attempt
# fails, <output-file> is absent and the function returns 1.
#
# A URL prefixed with "api:" is a GitHub release-asset API URL and is fetched
# with "Accept: application/octet-stream". It is served by a different front end
# than github.com/<owner>/<repo>/releases/download, which returned 504s for
# minutes at a time on 2026-11-09 while the API asset route kept working.

: "${DOWNLOAD_ROUNDS:=5}"
: "${DOWNLOAD_BACKOFF_SECONDS:=5}"
: "${DOWNLOAD_BACKOFF_MAX_SECONDS:=60}"

download_verified() {
  local output="$1" checksum="$2"
  shift 2

  if [ "$#" -eq 0 ] || [ -z "$checksum" ]; then
    echo "download_verified: need an output file, a checksum and at least one URL" >&2
    return 2
  fi

  rm -f "$output"

  local round=1 delay="$DOWNLOAD_BACKOFF_SECONDS" source url tmp actual
  local -a headers
  while [ "$round" -le "$DOWNLOAD_ROUNDS" ]; do
    for source in "$@"; do
      headers=()
      url="$source"
      if [ "${source#api:}" != "$source" ]; then
        url="${source#api:}"
        headers=(--header "Accept: application/octet-stream")
      fi

      tmp="$(mktemp "${output}.XXXXXX")"
      echo "Download round ${round}/${DOWNLOAD_ROUNDS}: ${url}"
      # --fail keeps an HTTP error page from being saved as the tarball; the
      # short inner --retry rides out a single dropped connection, the outer
      # rounds ride out a longer outage of one front end.
      if curl --fail --location --silent --show-error \
        --retry 1 --retry-delay 2 --retry-all-errors \
        --connect-timeout 15 --max-time 60 \
        "${headers[@]}" "$url" -o "$tmp"; then
        actual="$(sha256sum "$tmp" | cut -d' ' -f1)"
        if [ -n "$actual" ] && [ "$actual" = "$checksum" ]; then
          mv -f "$tmp" "$output"
          echo "Checksum verified (${actual})"
          return 0
        fi
        echo "Checksum mismatch for ${url} (got ${actual:-nothing}, want ${checksum}); discarding"
      fi
      rm -f "$tmp"
    done

    if [ "$round" -lt "$DOWNLOAD_ROUNDS" ]; then
      echo "All sources failed in round ${round}; retrying in ${delay}s"
      sleep "$delay"
      delay=$((delay * 2))
      if [ "$delay" -gt "$DOWNLOAD_BACKOFF_MAX_SECONDS" ]; then
        delay="$DOWNLOAD_BACKOFF_MAX_SECONDS"
      fi
    fi
    round=$((round + 1))
  done

  echo "Couldn't download a verified agent after ${DOWNLOAD_ROUNDS} rounds" >&2
  return 1
}
