import * as core from "@actions/core";
import fs from "node:fs/promises";
import util from "node:util";
import { exec as execCb, spawn, spawnSync } from "node:child_process";
import path from "node:path";
import {
  AGENT_LOG_FILENAME,
  AGENT_INSTALL_PATH,
  AGENT_READY_PATH,
} from "./constants";
import { parseInputs, EgressPolicy, DnsPolicy } from "./inputs";
import { waitForFile, getGitHubContext } from "./util";
import { ensureRuntimeDependencies, RuntimeDependencies } from "./packages";
import {
  fetchPolicyOverride,
  applyPolicyOverride,
  writeResolvedConfig,
} from "./policy";

const exec = util.promisify(execCb);

async function downloadAgent(actionDirectory: string): Promise<void> {
  const { status } = spawnSync(
    "bash",
    [path.join(actionDirectory, "scripts", "download_agent.sh")],
    {
      stdio: "inherit",
    },
  );

  if (status !== 0) {
    throw new Error("Couldn't download agent");
  }
}

function installPackages(actionDirectory: string): RuntimeDependencies {
  console.log("Installing packages");

  return ensureRuntimeDependencies({
    arch: process.arch,
    vendorDirectory: path.join(actionDirectory, "vendor"),
    log: (message) => console.log(message),
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
    run: (command, args, options) => {
      // stdout is captured for the caller and echoed, stderr goes to the log.
      const { status, stdout } = spawnSync(command, args, {
        stdio: ["ignore", "pipe", "inherit"],
        encoding: "utf8",
        timeout: options?.timeoutMs,
        killSignal: "SIGKILL",
      });
      // ldconfig -p lists every library on the image; do not echo that.
      if (stdout && !command.endsWith("ldconfig")) {
        process.stdout.write(stdout);
      }
      return { status, stdout: stdout ?? "" };
    },
  });
}

async function startAgent({
  agentLogFilepath,
  allowedDomains,
  allowedIps,
  dnsPolicy,
  egressPolicy,
  enableSudo,
  collectProcessInfo,
  libraryPath,
}: {
  allowedDomains: string[];
  allowedIps: string[];
  agentLogFilepath: string;
  dnsPolicy: DnsPolicy;
  egressPolicy: EgressPolicy;
  enableSudo: boolean;
  collectProcessInfo: boolean;
  libraryPath?: string;
}): Promise<void> {
  // fix buggy /etc/hosts entry in Github private repo runners
  // this misconfiguration causes the agent to fail to start
  await exec(`sudo sed -i 's/^-e //' /etc/hosts`);

  const agentOut = await fs.open(agentLogFilepath, "a");
  console.log(`Starting agent from ${AGENT_INSTALL_PATH}`);
  console.time("Agent startup time");

  // make agent executable
  await exec(`sudo chmod +x ${AGENT_INSTALL_PATH}`);

  const allowedDomainsFlag =
    allowedDomains.length > 0
      ? `--allowed-domains ${allowedDomains.join(",")}`
      : "";

  const allowedIpsFlag =
    allowedIps.length > 0 ? `--allowed-ips ${allowedIps.join(",")}` : "";

  const enableSudoFlag = enableSudo ? "true" : "false";
  const collectProcessInfoFlag = collectProcessInfo ? "true" : "false";

  const agentCommand = [
    // Set inside the sudo shell: sudo drops LD_LIBRARY_PATH from its caller.
    ...(libraryPath ? [`LD_LIBRARY_PATH=${libraryPath}`] : []),
    AGENT_INSTALL_PATH,
    "--dns-policy",
    dnsPolicy,
    "--egress-policy",
    egressPolicy,
    `--enable-sudo=${enableSudoFlag}`,
    `--collect-process-info=${collectProcessInfoFlag}`,
    allowedDomainsFlag,
    allowedIpsFlag,
  ].join(" ");

  spawn("sudo", ["sh", "-c", agentCommand], {
    stdio: ["ignore", agentOut.fd, agentOut.fd],
    detached: true,
  }).unref();

  await agentOut.close();

  const agentReady = await waitForFile(AGENT_READY_PATH);
  if (!agentReady) {
    throw new Error("Agent could not start");
  }
  console.timeEnd("Agent startup time");
}

async function main(): Promise<void> {
  const inputs = parseInputs();
  const { logDirectory, apiToken, controlPlaneApiBaseUrl, dryRunPrintConfig } =
    inputs;

  // The control plane's policy for this job, if one is configured, takes
  // precedence over whatever this action was invoked with.
  const githubContext = getGitHubContext();
  const override = await fetchPolicyOverride({
    apiToken,
    controlPlaneApiBaseUrl,
    repo: githubContext.repo,
    workflow: githubContext.workflowPath,
    job: githubContext.jobName,
  });
  const {
    allowedDomains,
    allowedIps,
    dnsPolicy,
    egressPolicy,
    enableSudo,
    collectProcessInfo,
  } = applyPolicyOverride(inputs, override);

  await fs.mkdir(logDirectory, { recursive: true });

  // post.ts runs as a separate process and has no access to the override
  // decision made above, so it's persisted to disk for post.ts to read back.
  await writeResolvedConfig(logDirectory, {
    allowedDomains,
    allowedIps,
    dnsPolicy,
    egressPolicy,
    enableSudo,
  });

  if (dryRunPrintConfig) {
    console.log(
      JSON.stringify({
        allowedDomains,
        allowedIps,
        dnsPolicy,
        egressPolicy,
        enableSudo,
      }),
    );
    return;
  }

  const actionDirectory = path.join(__dirname, "..");

  // Add control plane domain to allowed domains if API token is provided
  const finalAllowedDomains = [...allowedDomains];
  if (apiToken && controlPlaneApiBaseUrl) {
    try {
      const url = new URL(controlPlaneApiBaseUrl);
      const controlPlaneDomain = url.hostname;
      finalAllowedDomains.push(controlPlaneDomain);
      core.info(
        `Added control plane domain to allowed domains: ${controlPlaneDomain}`,
      );
    } catch (error) {
      core.warning(
        `Failed to parse control plane URL: ${error instanceof Error ? error.message : String(error)}. Connection results will not be published to Bullfrog's control plane.`,
      );
    }
  }

  const agentLogFilepath = path.join(logDirectory, AGENT_LOG_FILENAME);

  const { libraryPath } = installPackages(actionDirectory);

  await downloadAgent(actionDirectory);

  await startAgent({
    agentLogFilepath,
    allowedDomains: finalAllowedDomains,
    allowedIps,
    dnsPolicy,
    enableSudo,
    collectProcessInfo,
    egressPolicy,
    libraryPath,
  });
}

main().catch((error) => {
  console.error(error);
  core.setFailed(error);
  process.exit(1);
});
