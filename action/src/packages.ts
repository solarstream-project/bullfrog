import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * What the agent needs from the host at run time, and how it gets there
 * without the Ubuntu package mirror.
 *
 * The agent binary links two shared objects, libc and libnetfilter_queue.so.1,
 * and executes `nft`. Upstream ran `apt-get install libnetfilter-queue-dev
 * nftables` on every job; the -dev packages are build-time headers the agent
 * never touches. When the runner could not resolve the Ubuntu mirrors
 * (GitHub-hosted ubuntu-latest, 2026-11-11 from 13:23 UTC) the action failed
 * with "Couldn't install packages" although nftables was already on the image
 * and only one 15 kB library was missing.
 *
 * ensureRuntimeDependencies therefore resolves each requirement locally first:
 *   1. preinstalled: the library is in the linker cache and `nft` is on root's
 *      PATH. Nothing is installed.
 *   2. vendored: the library is unpacked from the unmodified Ubuntu
 *      libnetfilter-queue1 .deb committed under action/vendor, after its
 *      sha256 is checked against the value pinned here, into AGENT_LIBRARY_DIR.
 *      The agent is started with LD_LIBRARY_PATH pointing there. No network,
 *      no dpkg database change.
 *   3. apt: only for what is still missing (an unknown architecture, a failed
 *      unpack, an image without nftables), runtime packages only, with bounded
 *      timeouts and retries.
 */

export const AGENT_LIBRARY_DIR = "/opt/bullfrog/lib";
export const NETFILTER_QUEUE_SONAME = "libnetfilter_queue.so.1";

export interface VendoredLibrary {
  /** File name under action/vendor. */
  deb: string;
  /** sha256 of that file, as listed in Ubuntu's signed Packages index. */
  sha256: string;
  /** Debian multiarch directory the package installs the library into. */
  multiarch: string;
}

/**
 * libnetfilter-queue1 1.0.5-2 from Ubuntu 22.04 (jammy), the oldest release in
 * use on runners, so its glibc floor (2.14 / 2.17) is met everywhere newer.
 * Keyed by Node's process.arch. Provenance: action/vendor/README.md.
 */
export const VENDORED_LIBRARIES: Record<string, VendoredLibrary> = {
  x64: {
    deb: "libnetfilter-queue1_1.0.5-2_amd64.deb",
    sha256: "17753fe32e8a31c6b7ae05dee9c31cf3ea4a6559b82373f7230725cab9945020",
    multiarch: "x86_64-linux-gnu",
  },
  arm64: {
    deb: "libnetfilter-queue1_1.0.5-2_arm64.deb",
    sha256: "4c16a54412b71b5f04495735bbc0c5af8d13abc176b406ef1cbdc9be0f88181e",
    multiarch: "aarch64-linux-gnu",
  },
};

export type DependencySource = "preinstalled" | "vendored" | "apt";

export interface RuntimeDependencies {
  /** Where libnetfilter_queue.so.1 came from. */
  library: DependencySource;
  /** Where nft came from. */
  nft: Exclude<DependencySource, "vendored">;
  /** Set when the agent must be started with this LD_LIBRARY_PATH. */
  libraryPath?: string;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
}

export type RunCommand = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => CommandResult;

export interface Host {
  run: RunCommand;
  log: (message: string) => void;
  sleep: (ms: number) => void;
  arch: string;
  /** Directory holding the vendored .deb files (action/vendor). */
  vendorDirectory: string;
}

const APT_OPTIONS = [
  "-o",
  "Acquire::Retries=2",
  "-o",
  "Acquire::http::Timeout=15",
  "-o",
  "Acquire::https::Timeout=15",
  "-o",
  "DPkg::Lock::Timeout=60",
];
const APT_INSTALL_TIMEOUT_SECONDS = 90;
const APT_UPDATE_TIMEOUT_SECONDS = 120;
/** Pause before each apt attempt; attempts after the first refresh the lists. */
export const APT_ATTEMPT_DELAYS_MS = [0, 5_000, 20_000];

function libraryInLinkerCache(host: Host): boolean {
  const { status, stdout } = host.run("/sbin/ldconfig", ["-p"]);
  return status === 0 && stdout.includes(NETFILTER_QUEUE_SONAME);
}

function nftOnRootPath(host: Host): boolean {
  // The agent runs under sudo, so nft must be on root's PATH (/usr/sbin).
  return host.run("sudo", ["sh", "-c", "command -v nft"]).status === 0;
}

export function sha256OfFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Unpacks the vendored library into AGENT_LIBRARY_DIR. Returns false, leaving
 * no directory behind, on anything unexpected, so the caller can fall back.
 */
export function installVendoredLibrary(host: Host): boolean {
  const vendored = VENDORED_LIBRARIES[host.arch];
  if (!vendored) {
    host.log(`No vendored ${NETFILTER_QUEUE_SONAME} for ${host.arch}`);
    return false;
  }

  const deb = path.join(host.vendorDirectory, vendored.deb);
  let actual: string;
  try {
    actual = sha256OfFile(deb);
  } catch (error) {
    host.log(`Vendored ${vendored.deb} is not readable: ${String(error)}`);
    return false;
  }
  if (actual !== vendored.sha256) {
    host.log(
      `Vendored ${vendored.deb} has sha256 ${actual}, want ${vendored.sha256}; not using it`,
    );
    return false;
  }

  const unpackDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bullfrog-nfqueue-"),
  );
  try {
    if (host.run("dpkg-deb", ["-x", deb, unpackDirectory]).status !== 0) {
      host.log(`Couldn't unpack ${vendored.deb}`);
      return false;
    }
    const source = path.join(unpackDirectory, "usr", "lib", vendored.multiarch);
    // cp -P keeps the libnetfilter_queue.so.1 -> .so.1.x.y symlink.
    const copied = host.run("sudo", [
      "sh",
      "-c",
      `mkdir -p ${AGENT_LIBRARY_DIR} && cp -P ${source}/libnetfilter_queue.so.1* ${AGENT_LIBRARY_DIR}/`,
    ]);
    const library = path.join(AGENT_LIBRARY_DIR, NETFILTER_QUEUE_SONAME);
    // The library itself needs libmnl and libnfnetlink from the image.
    const linked = host.run("ldd", [library]);
    if (
      copied.status !== 0 ||
      linked.status !== 0 ||
      linked.stdout.includes("not found")
    ) {
      host.log(
        `Vendored ${NETFILTER_QUEUE_SONAME} does not load on this image:\n${linked.stdout}`,
      );
      host.run("sudo", ["rm", "-rf", AGENT_LIBRARY_DIR]);
      return false;
    }
    return true;
  } finally {
    fs.rmSync(unpackDirectory, { recursive: true, force: true });
  }
}

/**
 * Runs apt-get under timeout(1), which signals apt-get itself; killing only the
 * sudo parent would leave apt running and holding the dpkg lock. The spawn
 * timeout is a backstop for a timeout(1) that never returns.
 */
function aptGet(host: Host, timeoutSeconds: number, args: string[]): boolean {
  const { status } = host.run(
    "sudo",
    [
      "timeout",
      "--kill-after=5",
      String(timeoutSeconds),
      "apt-get",
      ...APT_OPTIONS,
      ...args,
    ],
    { timeoutMs: (timeoutSeconds + 15) * 1000 },
  );
  return status === 0;
}

function aptInstall(host: Host, packages: string[]): boolean {
  for (const [attempt, delayMs] of APT_ATTEMPT_DELAYS_MS.entries()) {
    if (attempt > 0) {
      host.log(`apt attempt ${attempt} failed; retrying in ${delayMs / 1000}s`);
      host.sleep(delayMs);
      // A stale or absent package list is a common reason for the first
      // failure. Its result is not checked: one unreachable source must not
      // stop an install the remaining sources can serve.
      aptGet(host, APT_UPDATE_TIMEOUT_SECONDS, ["update"]);
    }
    if (
      aptGet(host, APT_INSTALL_TIMEOUT_SECONDS, [
        "install",
        "-y",
        "--no-install-recommends",
        ...packages,
      ])
    ) {
      return true;
    }
  }
  return false;
}

export function ensureRuntimeDependencies(host: Host): RuntimeDependencies {
  let library: DependencySource | undefined;
  let libraryPath: string | undefined;

  if (libraryInLinkerCache(host)) {
    library = "preinstalled";
  } else if (installVendoredLibrary(host)) {
    library = "vendored";
    libraryPath = AGENT_LIBRARY_DIR;
  }
  const nftPresent = nftOnRootPath(host);

  const missing = [
    ...(library ? [] : ["libnetfilter-queue1"]),
    ...(nftPresent ? [] : ["nftables"]),
  ];
  if (missing.length > 0) {
    host.log(`Installing with apt: ${missing.join(" ")}`);
    if (!aptInstall(host, missing)) {
      throw new Error("Couldn't install packages");
    }
  }

  const result: RuntimeDependencies = {
    library: library ?? "apt",
    nft: nftPresent ? "preinstalled" : "apt",
    libraryPath,
  };
  host.log(
    `Runtime dependencies: ${NETFILTER_QUEUE_SONAME} ${result.library}, nft ${result.nft}` +
      (missing.length === 0 ? " (no package download)" : ""),
  );
  return result;
}
