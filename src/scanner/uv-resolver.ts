import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { delimiter, join } from "path";

export type ScannerLauncher = {
  command: string;
  preArgs: string[];
};

function collectCandidatesFromPath(executableNames: string[]): string[] {
  const rawPath = process.env.PATH || "";
  if (!rawPath) return [];

  const candidates: string[] = [];
  for (const rawDir of rawPath.split(delimiter)) {
    const dir = rawDir.trim();
    if (!dir) continue;
    for (const executableName of executableNames) {
      const fullPath = join(dir, executableName);
      if (existsSync(fullPath)) {
        candidates.push(fullPath);
      }
    }
  }

  return candidates;
}

function collectCommandCandidatesFromSystemLookup(
  commandName: string
): string[] {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [commandName], {
    timeout: 5_000,
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
  });

  if (result.error || result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveUvxCommandCandidates(): string[] {
  const candidates: string[] = [];

  if (process.env.UVX_PATH) {
    candidates.push(process.env.UVX_PATH);
  }

  candidates.push("uvx");

  if (process.platform === "win32" && process.env.USERPROFILE) {
    const localBin = join(process.env.USERPROFILE, ".local", "bin");
    candidates.push(
      join(localBin, "uvx.exe"),
      join(localBin, "uvx.cmd"),
      join(localBin, "uvx.bat")
    );
  }

  const uvxExecutableNames =
    process.platform === "win32"
      ? ["uvx.exe", "uvx.cmd", "uvx.bat", "uvx"]
      : ["uvx"];

  candidates.push(...collectCandidatesFromPath(uvxExecutableNames));
  candidates.push(...collectCommandCandidatesFromSystemLookup("uvx"));

  return [...new Set(candidates)];
}

function resolveUvCommandCandidates(): string[] {
  const candidates: string[] = [];

  if (process.env.UV_PATH) {
    candidates.push(process.env.UV_PATH);
  }

  candidates.push("uv");

  if (process.platform === "win32" && process.env.USERPROFILE) {
    const localBin = join(process.env.USERPROFILE, ".local", "bin");
    candidates.push(
      join(localBin, "uv.exe"),
      join(localBin, "uv.cmd"),
      join(localBin, "uv.bat")
    );
  }

  const uvExecutableNames =
    process.platform === "win32"
      ? ["uv.exe", "uv.cmd", "uv.bat", "uv"]
      : ["uv"];

  candidates.push(...collectCandidatesFromPath(uvExecutableNames));
  candidates.push(...collectCommandCandidatesFromSystemLookup("uv"));

  return [...new Set(candidates)];
}

function commandAvailable(
  command: string,
  args: string[] = ["--version"]
): boolean {
  const result = spawnSync(command, args, {
    timeout: 5_000,
    stdio: "ignore",
    shell: false,
  });
  return !result.error && result.status === 0;
}

export function resolveScannerLauncher(): ScannerLauncher | null {
  for (const candidate of resolveUvxCommandCandidates()) {
    if (commandAvailable(candidate)) {
      return { command: candidate, preArgs: [] };
    }
  }

  for (const candidate of resolveUvCommandCandidates()) {
    if (commandAvailable(candidate)) {
      return { command: candidate, preArgs: ["x"] };
    }
  }

  return null;
}
