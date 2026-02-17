#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";
import { getErrorMessage } from "./utils.js";

interface ClientTarget {
  id: "vscode" | "cursor" | "claude-desktop" | "claude-code";
  name: string;
  path: string;
  serversKey: "servers" | "mcpServers";
  supportsInputs: boolean;
}

function getAppDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case "win32":
      return process.env.APPDATA || join(home, "AppData", "Roaming");
    case "darwin":
      return join(home, "Library", "Application Support");
    default:
      return join(home, ".config");
  }
}

function getClientTargets(): ClientTarget[] {
  const home = homedir();
  const appData = getAppDataDir();
  const targets: ClientTarget[] = [];

  targets.push({
    id: "vscode",
    name: "VS Code",
    path: join(appData, "Code", "User", "mcp.json"),
    serversKey: "servers",
    supportsInputs: true,
  });

  targets.push({
    id: "cursor",
    name: "Cursor",
    path: join(home, ".cursor", "mcp.json"),
    serversKey: "mcpServers",
    supportsInputs: false,
  });

  targets.push({
    id: "claude-desktop",
    name: "Claude Desktop",
    path: join(appData, "Claude", "claude_desktop_config.json"),
    serversKey: "mcpServers",
    supportsInputs: false,
  });

  targets.push({
    id: "claude-code",
    name: "Claude Code",
    path: join(home, ".claude.json"),
    serversKey: "mcpServers",
    supportsInputs: false,
  });

  return targets;
}

function configureClient(target: ClientTarget): void {
  let config: Record<string, unknown> = {};

  if (existsSync(target.path)) {
    try {
      const content = readFileSync(target.path, "utf-8");
      config = JSON.parse(content);
    } catch {
      console.error(`  Could not parse ${target.path}, skipping`);
      return;
    }
  } else {
    const configDir = dirname(target.path);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
  }

  if (!config[target.serversKey]) {
    config[target.serversKey] = {};
  }

  const servers = config[target.serversKey] as Record<string, unknown>;

  if (servers.skillsmp) {
    console.error(`  ${target.name}: already configured, skipped`);
    return;
  }

  if (target.supportsInputs) {
    servers.skillsmp = {
      type: "stdio",
      command: "npx",
      args: ["-y", "skillsmp-mcp-lite"],
      env: {
        SKILLSMP_API_KEY: "${input:skillsmp_api_key}",
      },
    };

    if (!Array.isArray(config.inputs)) {
      config.inputs = [];
    }
    const inputs = config.inputs as Array<Record<string, unknown>>;
    const alreadyHasInput = inputs.some((i) => i.id === "skillsmp_api_key");
    if (!alreadyHasInput) {
      inputs.push({
        id: "skillsmp_api_key",
        type: "promptString",
        description:
          "SkillsMP API Key (get one at https://skillsmp.com/docs/api)",
        password: true,
      });
    }
  } else {
    servers.skillsmp = {
      command: "npx",
      args: ["-y", "skillsmp-mcp-lite"],
      env: {
        SKILLSMP_API_KEY: "YOUR_API_KEY_HERE",
      },
    };
  }

  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, JSON.stringify(config, null, "\t"), "utf-8");

  console.error(`  ${target.name}: configured (${target.path})`);
}

function detectCurrentClient(): ClientTarget["id"] | "all" | null {
  const forced = process.env.SKILLSMP_MCP_CLIENT?.toLowerCase();
  if (
    forced === "vscode" ||
    forced === "cursor" ||
    forced === "claude-desktop" ||
    forced === "claude-code" ||
    forced === "all"
  ) {
    return forced;
  }

  const envKeys = Object.keys(process.env);
  const termProgram = (process.env.TERM_PROGRAM || "").toLowerCase();

  if (
    process.env.CURSOR_TRACE_ID ||
    process.env.CURSOR_SESSION_ID ||
    envKeys.some((key) => key.startsWith("CURSOR_"))
  ) {
    return "cursor";
  }

  if (
    process.env.VSCODE_PID ||
    process.env.VSCODE_IPC_HOOK ||
    process.env.VSCODE_IPC_HOOK_CLI ||
    termProgram === "vscode"
  ) {
    return "vscode";
  }

  if (
    process.env.CLAUDECODE ||
    process.env.CLAUDE_CODE ||
    process.env.CLAUDECODE_ENTRYPOINT
  ) {
    return "claude-code";
  }

  return null;
}

export function setup(): void {
  try {
    const targets = getClientTargets();
    const currentClient = detectCurrentClient();

    let targetsToConfigure = targets;
    if (currentClient && currentClient !== "all") {
      targetsToConfigure = targets.filter(
        (target) => target.id === currentClient
      );
      console.error(
        `SkillsMP MCP: detected ${targetsToConfigure[0]?.name || currentClient}, configuring only that client...`
      );
    } else if (currentClient === "all") {
      console.error("SkillsMP MCP: auto-configuring all supported clients...");
    } else {
      console.error(
        "SkillsMP MCP: no specific client detected, attempting to configure all supported clients..."
      );
    }

    for (const target of targetsToConfigure) {
      configureClient(target);
    }

    console.error("  Get your API key at https://skillsmp.com/docs/api");
  } catch (error) {
    console.error(
      "Could not auto-configure MCP clients. You can add the config manually."
    );
    console.error(`  Error: ${getErrorMessage(error)}`);
  }
}

// Run only when executed directly (e.g., `node dist/setup.js`)
try {
  const thisFile = fileURLToPath(import.meta.url);
  const entryFile = resolve(process.argv[1] || "");
  if (thisFile === entryFile) {
    setup();
  }
} catch {
  // Silently skip — not executed directly
}
