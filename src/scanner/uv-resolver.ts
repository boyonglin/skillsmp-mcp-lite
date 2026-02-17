import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { delimiter, dirname, join } from "path";

export type ScannerLauncher = {
  command: string;
  preArgs: string[];
};

/** Collect every plausible home directory from environment variables. */
function getHomeDirs(): string[] {
  const dirs: string[] = [];

  if (process.env.USERPROFILE) dirs.push(process.env.USERPROFILE);
  if (process.env.HOME) dirs.push(process.env.HOME);

  const drive = process.env.HOMEDRIVE || "";
  const homePath = process.env.HOMEPATH || "";
  if (drive && homePath) dirs.push(drive + homePath);

  if (process.platform === "win32") {
    const username = process.env.USERNAME || process.env.USER || "";
    if (username) {
      dirs.push(`C:\\Users\\${username}`);
    }
  }

  return [...new Set(dirs.filter(Boolean))];
}

/**
 * Return well-known directories where uv/uvx may be installed.
 * Covers the standard `uv` installer paths on every platform.
 */
function getWellKnownBinDirs(): string[] {
  const dirs: string[] = [];
  const homeDirs = getHomeDirs();

  for (const home of homeDirs) {
    dirs.push(join(home, ".local", "bin"));
    dirs.push(join(home, ".cargo", "bin"));
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      dirs.push(join(localAppData, "Programs", "uv"));
    }
  }

  return [...new Set(dirs.filter(Boolean))];
}

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

  if (!result.error && result.status === 0 && result.stdout) {
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  if (process.platform === "win32") {
    const shellResult = spawnSync(`${lookupCommand} ${commandName}`, {
      timeout: 5_000,
      stdio: "pipe",
      encoding: "utf8",
      shell: true,
    });

    if (!shellResult.error && shellResult.status === 0 && shellResult.stdout) {
      return shellResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
  }

  return [];
}

/**
 * Collect candidates for a given command from well-known directories.
 * Checks every combination of well-known dir × executable name and
 * returns paths that actually exist on disk.
 */
function collectCandidatesFromWellKnownDirs(
  executableNames: string[]
): string[] {
  const candidates: string[] = [];
  for (const dir of getWellKnownBinDirs()) {
    for (const name of executableNames) {
      const fullPath = join(dir, name);
      if (existsSync(fullPath)) {
        candidates.push(fullPath);
      }
    }
  }
  return candidates;
}

function resolveUvxCommandCandidates(): string[] {
  const candidates: string[] = [];

  if (process.env.UVX_PATH) {
    candidates.push(process.env.UVX_PATH);
  }

  candidates.push("uvx");

  const uvxExecutableNames =
    process.platform === "win32"
      ? ["uvx.exe", "uvx.cmd", "uvx.bat", "uvx"]
      : ["uvx"];

  candidates.push(...collectCandidatesFromWellKnownDirs(uvxExecutableNames));
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

  const uvExecutableNames =
    process.platform === "win32"
      ? ["uv.exe", "uv.cmd", "uv.bat", "uv"]
      : ["uv"];

  candidates.push(...collectCandidatesFromWellKnownDirs(uvExecutableNames));
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
  if (!result.error && result.status === 0) return true;

  if (process.platform === "win32") {
    const quoted = command.includes(" ") ? `"${command}"` : command;
    const shellCmd = [quoted, ...args].join(" ");
    const shellResult = spawnSync(shellCmd, {
      timeout: 5_000,
      stdio: "ignore",
      shell: true,
    });
    return !shellResult.error && shellResult.status === 0;
  }

  return false;
}

export function resolveScannerLauncher(): ScannerLauncher | null {
  for (const candidate of resolveUvxCommandCandidates()) {
    if (commandAvailable(candidate)) {
      console.error(`[uv-resolver] Found uvx: ${candidate}`);
      return { command: candidate, preArgs: [] };
    }
  }

  for (const candidate of resolveUvCommandCandidates()) {
    if (commandAvailable(candidate)) {
      console.error(`[uv-resolver] Found uv: ${candidate}`);
      return { command: candidate, preArgs: ["x"] };
    }
  }

  console.error(
    "[uv-resolver] Could not find uvx or uv in any known location."
  );
  return null;
}

/**
 * Return the directory containing the resolved launcher command,
 * or `undefined` if no launcher was found / command is bare name.
 * Useful for augmenting PATH when spawning child processes.
 */
export function resolvedLauncherDir(
  launcher: ScannerLauncher
): string | undefined {
  if (launcher.command.includes("/") || launcher.command.includes("\\")) {
    return dirname(launcher.command);
  }
  return undefined;
}
