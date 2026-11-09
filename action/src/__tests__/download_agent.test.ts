import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIB = path.join(__dirname, "..", "..", "scripts", "download_lib.sh");
const PAYLOAD = Buffer.from("verified agent tarball bytes");
const CHECKSUM = createHash("sha256").update(PAYLOAD).digest("hex");

type Responder = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hit: number,
) => void;

let server: http.Server;
let baseUrl: string;
let hits: Record<string, number>;
let acceptHeaders: Record<string, string | undefined>;
let routes: Record<string, Responder>;
let workDir: string;

beforeEach(async () => {
  hits = {};
  acceptHeaders = {};
  routes = {};
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bullfrog-download-"));
  server = http.createServer((req, res) => {
    const route = req.url ?? "";
    hits[route] = (hits[route] ?? 0) + 1;
    acceptHeaders[route] = req.headers.accept;
    const responder = routes[route];
    if (!responder) {
      res.writeHead(404).end("not found");
      return;
    }
    responder(req, res, hits[route]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(workDir, { recursive: true, force: true });
});

function runDownload(
  checksum: string,
  urls: string[],
  rounds = 3,
): Promise<{ status: number | null; output: string; file: string }> {
  const file = path.join(workDir, "agent-amd64.tar.gz");
  return new Promise((resolve) => {
    const child = spawn(
      "bash",
      [
        "-c",
        'source "$0"; download_verified "$@"',
        LIB,
        file,
        checksum,
        ...urls,
      ],
      {
        env: {
          ...process.env,
          DOWNLOAD_ROUNDS: String(rounds),
          DOWNLOAD_BACKOFF_SECONDS: "0",
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => resolve({ status, output, file }));
  });
}

const serve =
  (body: Buffer): Responder =>
  (_req, res) =>
    res.writeHead(200).end(body);
const fail =
  (code: number): Responder =>
  (_req, res) =>
    res.writeHead(code).end(`<html>${code}</html>`);

describe("download_verified", () => {
  it("retries HTTP errors on the primary route until it serves the verified tarball", async () => {
    routes["/primary"] = (req, res, hit) =>
      hit <= 3 ? fail(504)(req, res, hit) : serve(PAYLOAD)(req, res, hit);

    const { status, file } = await runDownload(CHECKSUM, [
      `${baseUrl}/primary`,
    ]);

    expect(status).toBe(0);
    expect(fs.readFileSync(file)).toEqual(PAYLOAD);
    expect(hits["/primary"]).toBe(4);
  });

  it("falls back to the API asset route, with the octet-stream Accept header, while the primary returns 504", async () => {
    routes["/primary"] = fail(504);
    routes["/api-asset"] = serve(PAYLOAD);

    const { status, file } = await runDownload(CHECKSUM, [
      `${baseUrl}/primary`,
      `api:${baseUrl}/api-asset`,
    ]);

    expect(status).toBe(0);
    expect(fs.readFileSync(file)).toEqual(PAYLOAD);
    expect(acceptHeaders["/api-asset"]).toBe("application/octet-stream");
  });

  it("discards a checksum mismatch and re-downloads instead of accepting it", async () => {
    routes["/primary"] = (req, res, hit) =>
      hit === 1
        ? serve(Buffer.from("truncated or tampered"))(req, res, hit)
        : serve(PAYLOAD)(req, res, hit);

    const { status, output, file } = await runDownload(CHECKSUM, [
      `${baseUrl}/primary`,
    ]);

    expect(status).toBe(0);
    expect(output).toContain("Checksum mismatch");
    expect(fs.readFileSync(file)).toEqual(PAYLOAD);
    expect(hits["/primary"]).toBe(2);
  });

  it("fails closed, leaving no file, when no attempt ever matches the pinned checksum", async () => {
    routes["/primary"] = serve(Buffer.from("wrong bytes, HTTP 200"));
    routes["/api-asset"] = fail(503);

    const { status, file } = await runDownload(
      CHECKSUM,
      [`${baseUrl}/primary`, `api:${baseUrl}/api-asset`],
      2,
    );

    expect(status).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(workDir)).toEqual([]);
  });

  it("refuses to run without a checksum", async () => {
    routes["/primary"] = serve(PAYLOAD);

    const { status } = await runDownload("", [`${baseUrl}/primary`]);

    expect(status).toBe(2);
    expect(hits["/primary"]).toBeUndefined();
  });
});
