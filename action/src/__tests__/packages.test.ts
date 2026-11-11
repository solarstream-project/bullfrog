import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_LIBRARY_DIR,
  APT_ATTEMPT_DELAYS_MS,
  CommandResult,
  Host,
  VENDORED_LIBRARIES,
  ensureRuntimeDependencies,
  sha256OfFile,
} from "../packages";

const VENDOR_DIRECTORY = path.join(__dirname, "..", "..", "vendor");
const OK: CommandResult = { status: 0, stdout: "" };
const FAILED: CommandResult = { status: 1, stdout: "" };

type Call = { line: string; timeoutMs?: number };

/**
 * A fake host. `responses` maps a substring of the command line to its result;
 * the first matching entry wins, anything unmatched succeeds with no output.
 */
function fakeHost(
  responses: Array<[string, CommandResult | (() => CommandResult)]>,
  overrides: Partial<Host> = {},
): { host: Host; calls: Call[]; logs: string[]; sleeps: number[] } {
  const calls: Call[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const host: Host = {
    arch: "x64",
    vendorDirectory: VENDOR_DIRECTORY,
    log: (message) => logs.push(message),
    sleep: (ms) => sleeps.push(ms),
    run: (command, args, options) => {
      const line = [command, ...args].join(" ");
      calls.push({ line, timeoutMs: options?.timeoutMs });
      for (const [needle, response] of responses) {
        if (line.includes(needle)) {
          return typeof response === "function" ? response() : response;
        }
      }
      return OK;
    },
    ...overrides,
  };
  return { host, calls, logs, sleeps };
}

const LIBRARY_CACHED: CommandResult = {
  status: 0,
  stdout:
    "\tlibnetfilter_queue.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libnetfilter_queue.so.1\n",
};
const LIBRARY_NOT_CACHED: CommandResult = {
  status: 0,
  stdout: "\tlibmnl.so.0 (libc6,x86-64) => /lib/x86_64-linux-gnu/libmnl.so.0\n",
};
const LDD_CLEAN: CommandResult = {
  status: 0,
  stdout: "\tlibmnl.so.0 => /lib/x86_64-linux-gnu/libmnl.so.0 (0x1)\n",
};

const aptCalls = (calls: Call[]) =>
  calls.filter((call) => call.line.includes("apt-get"));

let tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories = [];
});

describe("vendored libnetfilter-queue1 packages", () => {
  it.each(Object.entries(VENDORED_LIBRARIES))(
    "%s: the committed .deb matches its pinned sha256",
    (_arch, vendored) => {
      expect(sha256OfFile(path.join(VENDOR_DIRECTORY, vendored.deb))).toBe(
        vendored.sha256,
      );
    },
  );

  it("covers both runner architectures", () => {
    expect(Object.keys(VENDORED_LIBRARIES).sort()).toEqual(["arm64", "x64"]);
  });
});

describe("ensureRuntimeDependencies", () => {
  it("installs nothing when the library and nft are already on the runner", () => {
    const { host, calls } = fakeHost([["ldconfig", LIBRARY_CACHED]]);

    expect(ensureRuntimeDependencies(host)).toEqual({
      library: "preinstalled",
      nft: "preinstalled",
      libraryPath: undefined,
    });
    expect(calls.map((call) => call.line)).toEqual([
      "/sbin/ldconfig -p",
      "sudo sh -c command -v nft",
    ]);
  });

  it("unpacks the vendored library without apt when only the library is missing", () => {
    const { host, calls, logs } = fakeHost([
      ["ldconfig", LIBRARY_NOT_CACHED],
      ["ldd", LDD_CLEAN],
    ]);

    expect(ensureRuntimeDependencies(host)).toEqual({
      library: "vendored",
      nft: "preinstalled",
      libraryPath: AGENT_LIBRARY_DIR,
    });
    expect(aptCalls(calls)).toEqual([]);
    const lines = calls.map((call) => call.line);
    expect(lines[1]).toMatch(
      /^dpkg-deb -x .*vendor\/libnetfilter-queue1_1\.0\.5-2_amd64\.deb /,
    );
    expect(lines[2]).toMatch(
      /^sudo sh -c mkdir -p \/opt\/bullfrog\/lib && cp -P .*\/usr\/lib\/x86_64-linux-gnu\/libnetfilter_queue\.so\.1\* \/opt\/bullfrog\/lib\/$/,
    );
    expect(lines[3]).toBe("ldd /opt/bullfrog/lib/libnetfilter_queue.so.1");
    expect(logs.at(-1)).toContain("(no package download)");
  });

  it("uses the arm64 package on arm64", () => {
    const { host, calls } = fakeHost(
      [
        ["ldconfig", LIBRARY_NOT_CACHED],
        ["ldd", LDD_CLEAN],
      ],
      { arch: "arm64" },
    );

    expect(ensureRuntimeDependencies(host).library).toBe("vendored");
    expect(calls[1].line).toContain("libnetfilter-queue1_1.0.5-2_arm64.deb");
    expect(calls[2].line).toContain("/usr/lib/aarch64-linux-gnu/");
  });

  it("refuses a vendored package whose bytes do not match the pin and falls back to apt", () => {
    const tampered = fs.mkdtempSync(path.join(os.tmpdir(), "bullfrog-vendor-"));
    tempDirectories.push(tampered);
    fs.writeFileSync(
      path.join(tampered, VENDORED_LIBRARIES.x64.deb),
      "not the package",
    );
    const { host, calls, logs } = fakeHost([["ldconfig", LIBRARY_NOT_CACHED]], {
      vendorDirectory: tampered,
    });

    expect(ensureRuntimeDependencies(host)).toEqual({
      library: "apt",
      nft: "preinstalled",
      libraryPath: undefined,
    });
    expect(calls.some((call) => call.line.startsWith("dpkg-deb"))).toBe(false);
    expect(logs.join("\n")).toContain("not using it");
    expect(aptCalls(calls).map((call) => call.line)).toEqual([
      expect.stringMatching(
        /^sudo timeout --kill-after=5 90 apt-get .* install -y --no-install-recommends libnetfilter-queue1$/,
      ),
    ]);
  });

  it("removes the unpacked library and falls back to apt when it does not load", () => {
    const { host, calls } = fakeHost([
      ["ldconfig", LIBRARY_NOT_CACHED],
      ["ldd", { status: 0, stdout: "\tlibnfnetlink.so.0 => not found\n" }],
    ]);

    expect(ensureRuntimeDependencies(host).library).toBe("apt");
    expect(calls.map((call) => call.line)).toContain(
      "sudo rm -rf /opt/bullfrog/lib",
    );
    expect(aptCalls(calls)).toHaveLength(1);
  });

  it("falls back to apt on an architecture with no vendored package", () => {
    const { host, calls } = fakeHost([["ldconfig", LIBRARY_NOT_CACHED]], {
      arch: "riscv64",
    });

    expect(ensureRuntimeDependencies(host).library).toBe("apt");
    expect(calls.some((call) => call.line.startsWith("dpkg-deb"))).toBe(false);
  });

  it("installs only nftables with apt when only nft is missing", () => {
    const { host, calls } = fakeHost([
      ["ldconfig", LIBRARY_CACHED],
      ["command -v nft", FAILED],
    ]);

    expect(ensureRuntimeDependencies(host)).toEqual({
      library: "preinstalled",
      nft: "apt",
      libraryPath: undefined,
    });
    expect(aptCalls(calls)).toHaveLength(1);
    expect(aptCalls(calls)[0].line).toMatch(/install -y \S+ nftables$/);
  });

  it("never installs the -dev packages", () => {
    const { host, calls } = fakeHost(
      [
        ["ldconfig", LIBRARY_NOT_CACHED],
        ["command -v nft", FAILED],
      ],
      { arch: "riscv64" },
    );

    ensureRuntimeDependencies(host);
    const install = aptCalls(calls)[0].line;
    expect(install).toMatch(/ libnetfilter-queue1 nftables$/);
    expect(install).not.toContain("-dev");
  });

  it("bounds every apt call and refreshes the lists before each retry", () => {
    let installs = 0;
    const { host, calls, sleeps } = fakeHost(
      [
        ["ldconfig", LIBRARY_NOT_CACHED],
        [" update", FAILED],
        [" install ", () => (++installs < 3 ? FAILED : OK)],
      ],
      { arch: "riscv64" },
    );

    expect(ensureRuntimeDependencies(host).library).toBe("apt");
    const apt = aptCalls(calls);
    expect(
      apt.map((call) => (call.line.includes(" update") ? "update" : "install")),
    ).toEqual(["install", "update", "install", "update", "install"]);
    for (const call of apt) {
      expect(call.line).toMatch(
        /^sudo timeout --kill-after=5 (90|120) apt-get /,
      );
      expect(call.line).toContain("Acquire::http::Timeout=15");
      expect(call.line).toContain("DPkg::Lock::Timeout=60");
      expect(call.timeoutMs).toBeGreaterThan(0);
    }
    expect(sleeps).toEqual(APT_ATTEMPT_DELAYS_MS.slice(1));
  });

  it("fails closed when apt never succeeds", () => {
    const { host, calls } = fakeHost(
      [
        ["ldconfig", LIBRARY_NOT_CACHED],
        ["apt-get", FAILED],
      ],
      { arch: "riscv64" },
    );

    expect(() => ensureRuntimeDependencies(host)).toThrow(
      "Couldn't install packages",
    );
    expect(
      aptCalls(calls).filter((call) => call.line.includes(" install ")),
    ).toHaveLength(APT_ATTEMPT_DELAYS_MS.length);
  });
});
