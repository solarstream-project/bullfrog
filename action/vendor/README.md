# Vendored runtime library

The agent binary links `libnetfilter_queue.so.1`. GitHub-hosted Ubuntu images do
not ship it, and installing it with apt at job start made every job depend on
the Ubuntu package mirror being reachable. These are the unmodified Ubuntu
packages, unpacked by `action/src/packages.ts` into `/opt/bullfrog/lib` when the
library is not already on the runner.

| File                                    | sha256                                                             |
| --------------------------------------- | ------------------------------------------------------------------ |
| `libnetfilter-queue1_1.0.5-2_amd64.deb` | `17753fe32e8a31c6b7ae05dee9c31cf3ea4a6559b82373f7230725cab9945020` |
| `libnetfilter-queue1_1.0.5-2_arm64.deb` | `4c16a54412b71b5f04495735bbc0c5af8d13abc176b406ef1cbdc9be0f88181e` |

Source: Ubuntu 22.04 (jammy) `universe`, package `libnetfilter-queue1`
version `1.0.5-2`:

- `http://archive.ubuntu.com/ubuntu/pool/universe/libn/libnetfilter-queue/libnetfilter-queue1_1.0.5-2_amd64.deb`
- `http://ports.ubuntu.com/ubuntu-ports/pool/universe/libn/libnetfilter-queue/libnetfilter-queue1_1.0.5-2_arm64.deb`

The hashes are the `SHA256` fields of that package in
`dists/jammy/universe/binary-{amd64,arm64}/Packages.xz`. They are pinned in
`action/src/packages.ts`, checked before every unpack, and checked against the
committed files by `action/src/__tests__/packages.test.ts`.

jammy is the oldest Ubuntu release runners use, so the library's glibc
requirement (2.14 on amd64, 2.17 on arm64) holds on every newer image. It needs
`libmnl.so.0` and `libnfnetlink.so.0` from the image; when they are absent the
action falls back to apt.

To update: download the new `.deb` for both architectures, replace the files,
and change the names and hashes here and in `packages.ts`.

## Licence

libnetfilter_queue is licensed under the GNU GPL, version 2 or later; each
package carries its notice at `usr/share/doc/libnetfilter-queue1/copyright`. The
corresponding source is the Ubuntu source package `libnetfilter-queue`
`1.0.5-2`: <https://launchpad.net/ubuntu/+source/libnetfilter-queue/1.0.5-2>.
