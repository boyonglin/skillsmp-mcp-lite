import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { getErrorMessage } from "../utils.js";

const API_HEALTH_POLL_MS = 500;
const API_STARTUP_TIMEOUT_MS = 30_000;

const SKILL_SCANNER_API_URL = process.env.SKILL_SCANNER_API_URL || "";
const SCANNER_API_PORT = (() => {
  const parsed = Number.parseInt(process.env.SKILL_SCANNER_API_PORT || "", 10);
  return Number.isFinite(parsed) ? parsed : 8000;
})();
const MANAGED_API_URL = `http://localhost:${SCANNER_API_PORT}`;

let managedApiProcess: ChildProcess | null = null;
let managedApiReady = false;
let managedApiStarting: Promise<boolean> | null = null;

async function isApiHealthy(apiUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForApiReady(
  apiUrl: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isApiHealthy(apiUrl)) return true;
    await new Promise((r) => setTimeout(r, API_HEALTH_POLL_MS));
  }
  return false;
}

export async function ensureScannerApi(): Promise<string> {
  // 1. User-configured external URL
  if (SKILL_SCANNER_API_URL) {
    if (await isApiHealthy(SKILL_SCANNER_API_URL)) return SKILL_SCANNER_API_URL;
    console.error(
      `Skill Scanner API at ${SKILL_SCANNER_API_URL} is not healthy`
    );
    return "";
  }

  // 2. Already running managed server
  if (
    managedApiReady &&
    managedApiProcess &&
    !managedApiProcess.killed &&
    managedApiProcess.exitCode === null
  ) {
    if (await isApiHealthy(MANAGED_API_URL)) return MANAGED_API_URL;
    managedApiProcess.kill();
    managedApiReady = false;
    managedApiProcess = null;
  }

  // 3. Deduplicate concurrent startup attempts
  if (managedApiStarting) {
    const ok = await managedApiStarting;
    return ok && managedApiReady ? MANAGED_API_URL : "";
  }

  // 4. Check if something is already listening on the port
  if (await isApiHealthy(MANAGED_API_URL)) {
    managedApiReady = true;
    return MANAGED_API_URL;
  }

  // 5. Auto-start via uvx
  managedApiStarting = (async () => {
    try {
      console.error("Auto-starting Skill Scanner API server via uvx...");

      const uvxCommandCandidates: string[] = [];
      if (process.env.UVX_PATH) {
        uvxCommandCandidates.push(process.env.UVX_PATH);
      }
      uvxCommandCandidates.push("uvx");

      if (process.platform === "win32" && process.env.USERPROFILE) {
        const uvxFromLocalBin = join(
          process.env.USERPROFILE,
          ".local",
          "bin",
          "uvx.exe"
        );
        if (existsSync(uvxFromLocalBin)) {
          uvxCommandCandidates.push(uvxFromLocalBin);
        }
      }

      let uvxCommand: string | null = null;
      for (const candidate of uvxCommandCandidates) {
        const result = spawnSync(candidate, ["--version"], {
          timeout: 5_000,
          stdio: "ignore",
          shell: false,
        });
        if (!result.error && result.status === 0) {
          uvxCommand = candidate;
          break;
        }
      }

      if (!uvxCommand) {
        console.error(
          "uvx is not installed. Security scanning is disabled. " +
            "Install uv to enable: https://docs.astral.sh/uv/getting-started/installation/"
        );
        return false;
      }

      const child = spawn(
        uvxCommand,
        [
          "--from",
          "cisco-ai-skill-scanner",
          "skill-scanner-api",
          "--port",
          String(SCANNER_API_PORT),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        }
      );

      if (child.stdout) {
        child.stdout.on("data", (data: Buffer) => {
          const message = data.toString().trim();
          if (message) {
            console.error(`[Skill Scanner API stdout] ${message}`);
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          const message = data.toString().trim();
          if (message) {
            console.error(`[Skill Scanner API stderr] ${message}`);
          }
        });
      }

      child.on("exit", (code) => {
        console.error(`Skill Scanner API process exited (code ${code})`);
        managedApiReady = false;
        managedApiProcess = null;
      });

      child.on("error", (err) => {
        console.error(`Skill Scanner API process error: ${err.message}`);
        managedApiReady = false;
        managedApiProcess = null;
      });

      managedApiProcess = child;

      const ready = await waitForApiReady(
        MANAGED_API_URL,
        API_STARTUP_TIMEOUT_MS
      );
      if (ready) {
        managedApiReady = true;
        console.error(`Skill Scanner API server ready at ${MANAGED_API_URL}`);
        return true;
      }

      console.error("Skill Scanner API server failed to start within timeout");
      child.kill();
      managedApiProcess = null;
      return false;
    } catch (err) {
      console.error(
        `Failed to auto-start Skill Scanner API: ${getErrorMessage(err)}`
      );
      return false;
    } finally {
      managedApiStarting = null;
    }
  })();

  const ok = await managedApiStarting;
  return ok ? MANAGED_API_URL : "";
}

export function shutdownManagedApi() {
  if (managedApiProcess && !managedApiProcess.killed) {
    if (process.platform === "win32" && managedApiProcess.pid) {
      try {
        const result = spawnSync("taskkill", [
          "/F",
          "/T",
          "/PID",
          String(managedApiProcess.pid),
        ]);
        if (result.error || result.status !== 0) {
          console.error(
            "Failed to terminate managed API process tree via taskkill; falling back to process.kill().",
            result.error ?? `Exit code: ${result.status}`
          );
          managedApiProcess.kill();
        }
      } catch (error) {
        console.error(
          "Error while attempting to terminate managed API process tree via taskkill; falling back to process.kill().",
          error
        );
        managedApiProcess.kill();
      }
    } else {
      managedApiProcess.kill();
    }
    managedApiProcess = null;
    managedApiReady = false;
  }
}

process.on("exit", shutdownManagedApi);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
