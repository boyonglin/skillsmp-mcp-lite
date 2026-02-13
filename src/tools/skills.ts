import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile, spawn, spawnSync, type ChildProcess } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { rm } from "fs/promises";
import {
  makeApiRequest,
  handleApiError,
  validateSearchResponse,
  validateAISearchResponse,
  type SearchResponse,
  type Skill,
} from "../api.js";
import {
  KeywordSearchSchema,
  AISearchSchema,
  ReadSkillSchema,
  type KeywordSearchInput,
  type AISearchInput,
  type ReadSkillInput,
} from "../schemas.js";

const execFileAsync = promisify(execFile);

// Timeout constants (in milliseconds)
const TIMEOUTS = {
  GIT_CLONE: 60_000,
  GIT_SHOW: 15_000,
  SKILL_SCAN_API: 60_000,
  API_HEALTH_POLL: 500,
  API_STARTUP: 30_000,
} as const;

// Buffer size for git operations (10 MB)
const MAX_GIT_BUFFER = 10 * 1024 * 1024;

// Skill Scanner API configuration
const SKILL_SCANNER_API_URL = process.env.SKILL_SCANNER_API_URL || "";
const SCANNER_API_PORT = Number.isFinite(
  Number.parseInt(process.env.SKILL_SCANNER_API_PORT || "", 10)
)
  ? Number.parseInt(process.env.SKILL_SCANNER_API_PORT as string, 10)
  : 8000;
const MANAGED_API_URL = `http://localhost:${SCANNER_API_PORT}`;

// ── Managed scanner API server lifecycle ──────────────────────────────────────

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
    await new Promise((r) => setTimeout(r, TIMEOUTS.API_HEALTH_POLL));
  }
  return false;
}

async function ensureScannerApi(): Promise<string> {
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
    // Process is running but not healthy — kill before restarting
    managedApiProcess.kill();
    managedApiReady = false;
    managedApiProcess = null;
  }

  // 3. Deduplicate concurrent startup attempts
  if (managedApiStarting) {
    const ok = await managedApiStarting;
    return ok && managedApiReady ? MANAGED_API_URL : "";
  }

  // 4. Check if something is already listening on the port (e.g. user started it manually)
  if (await isApiHealthy(MANAGED_API_URL)) {
    managedApiReady = true;
    return MANAGED_API_URL;
  }

  // 5. Auto-start via uvx
  managedApiStarting = (async () => {
    try {
      console.error("Auto-starting Skill Scanner API server via uvx...");

      // Pre-check: is uvx available?
      try {
        await execFileAsync(
          process.platform === "win32" ? "where" : "which",
          ["uvx"],
          { timeout: 5_000 }
        );
      } catch {
        console.error(
          "uvx is not installed. Security scanning is disabled. " +
            "Install uv to enable: https://docs.astral.sh/uv/getting-started/installation/"
        );
        return false;
      }

      const child = spawn(
        "uvx",
        [
          "--from",
          "cisco-ai-skill-scanner",
          "skill-scanner-api",
          "--port",
          String(SCANNER_API_PORT),
        ],
        {
          // Ignore stdin and stdout, but pipe stderr so we can log errors.
          stdio: ["ignore", "ignore", "pipe"],
          // On Windows spawn needs shell:true for uvx (.cmd)
          shell: process.platform === "win32",
        }
      );

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
        TIMEOUTS.API_STARTUP
      );
      if (ready) {
        managedApiReady = true;
        console.error(`Skill Scanner API server ready at ${MANAGED_API_URL}`);
        return true;
      }

      // Startup timed out — kill the process
      console.error("Skill Scanner API server failed to start within timeout");
      child.kill();
      managedApiProcess = null;
      return false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to auto-start Skill Scanner API: ${msg}`);
      return false;
    } finally {
      // Clear the lock only after managedApiReady is set above, preventing a
      // window where another caller could slip through step 3 before state is
      // consistent.
      managedApiStarting = null;
    }
  })();

  const ok = await managedApiStarting;
  return ok ? MANAGED_API_URL : "";
}

function shutdownManagedApi() {
  if (managedApiProcess && !managedApiProcess.killed) {
    if (process.platform === "win32" && managedApiProcess.pid) {
      // On Windows, kill the entire process tree to avoid orphaned children
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

// Clean up on process exit — SIGINT/SIGTERM call process.exit(), which
// triggers the "exit" event where the actual cleanup runs.
process.on("exit", shutdownManagedApi);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

type ScanStatus = "SAFE" | "UNSAFE" | "ERROR";

interface ScanResult {
  available: boolean;
  status?: ScanStatus;
  maxSeverity?: string;
  totalFindings?: number;
  findings?: Array<{
    rule_id?: string;
    severity?: string;
    description?: string;
    file_path?: string;
    analyzer?: string;
  }>;
  scanDuration?: string;
  error?: string;
}

function getErrorDetails(error: unknown): { message: string; stderr?: string } {
  if (error instanceof Error) {
    const execError = error as Error & { stderr?: string; stdout?: string };
    return {
      message: execError.message,
      stderr: execError.stderr,
    };
  }
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    return {
      message: String(e.message || "Unknown error"),
      stderr: typeof e.stderr === "string" ? e.stderr : undefined,
    };
  }
  return { message: String(error) };
}

async function runSkillScannerApi(
  skillDir: string,
  apiUrl: string
): Promise<ScanResult> {
  const scanUrl = `${apiUrl.replace(/\/$/, "")}/scan`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    TIMEOUTS.SKILL_SCAN_API
  );

  try {
    const response = await fetch(scanUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_directory: skillDir }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      return {
        available: true,
        status: "ERROR",
        error: `API returned ${response.status}: ${errorBody}`,
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      return {
        available: true,
        status: "ERROR",
        error: `Skill Scanner API returned invalid JSON from ${scanUrl}`,
      };
    }

    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return {
      available: true,
      status: parsed.is_safe === true ? "SAFE" : "UNSAFE",
      maxSeverity: String(parsed.max_severity || "UNKNOWN"),
      totalFindings:
        typeof parsed.findings_count === "number"
          ? parsed.findings_count
          : findings.length,
      findings: findings.map((f: Record<string, unknown>) => ({
        rule_id: String(f.rule_id || f.ruleId || ""),
        severity: String(f.severity || ""),
        description: String(f.description || f.message || ""),
        file_path: String(f.file_path || f.filePath || ""),
        analyzer: String(f.analyzer || ""),
      })),
      scanDuration:
        typeof parsed.scan_duration_seconds === "number"
          ? `${parsed.scan_duration_seconds}s`
          : undefined,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        available: true,
        status: "ERROR",
        error: "Skill Scanner API request timed out",
      };
    }
    const details = getErrorDetails(error);
    return {
      available: false,
      error: `Skill Scanner API unreachable at ${apiUrl}: ${details.message}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runSkillScanner(skillDir: string): Promise<ScanResult> {
  const apiUrl = await ensureScannerApi();

  if (!apiUrl) {
    return {
      available: false,
      error:
        "Security scanner not available — uvx is not installed.\n" +
        "Install uv to enable automatic security scanning:\n" +
        "  macOS/Linux: curl -LsSf https://astral.sh/uv/install.sh | sh\n" +
        '  Windows: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"\n' +
        "Skill content was still read successfully.",
    };
  }

  return runSkillScannerApi(skillDir, apiUrl);
}

/**
 * Register SkillsMP tools on the MCP server
 */
export function registerSkillsTools(server: McpServer, apiKey: string) {
  // Tool 1: Keyword Search
  server.registerTool(
    "skillsmp_search_skills",
    {
      title: "Search SkillsMP Skills",
      description: `Search for AI skills using keywords from SkillsMP marketplace.

Use this tool to find skills by specific terms like 'SEO', 'web scraper', 'PDF', 'data analysis', etc.

**IMPORTANT**: Before starting any task, use this tool to check if there's an existing skill that can help complete the task more effectively.

Args:
  - query (string, required): Search keywords
  - page (number, optional): Page number (default: 1)
  - limit (number, optional): Items per page (default: 20, max: 100)
  - sortBy (string, optional): Sort by 'stars' or 'recent'

Returns:
  List of matching skills with name, description, author, and star count.

Examples:
  - "PDF manipulation" -> Find skills for working with PDFs
  - "web scraper" -> Find web scraping skills
  - "SEO optimization" -> Find SEO-related skills`,
      inputSchema: KeywordSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: KeywordSearchInput) => {
      try {
        const queryParams: Record<string, string | number> = {
          q: params.query,
          page: params.page,
          limit: params.limit,
        };

        if (params.sortBy) queryParams.sortBy = params.sortBy;

        const rawData = await makeApiRequest<unknown>(
          "skills/search",
          apiKey,
          queryParams
        );

        // Validate API response structure before processing
        validateSearchResponse(rawData);

        const skills = rawData.data?.skills || [];
        const pagination = rawData.data?.pagination;

        if (!skills.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No skills found matching '${params.query}'. Try different keywords or use AI semantic search for natural language queries.`,
              },
            ],
          };
        }

        const output = formatSkillsResponse(skills, params.query, pagination);

        return {
          content: [{ type: "text" as const, text: output }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: handleApiError(error),
            },
          ],
        };
      }
    }
  );

  // Tool 2: AI Semantic Search
  server.registerTool(
    "skillsmp_ai_search_skills",
    {
      title: "AI Search SkillsMP Skills",
      description: `AI semantic search for skills using natural language descriptions.

Use this when you need to find skills based on what you want to accomplish rather than specific keywords.

**IMPORTANT**: Before starting any complex task, use this tool to discover relevant skills that can help.

Args:
  - query (string, required): Natural language description of what you want to accomplish

Returns:
  List of semantically relevant skills that match your intent.

Examples:
  - "How to create a web scraper" -> Find skills for web scraping
  - "Build a dashboard with charts" -> Find data visualization skills
  - "Generate PDF reports from data" -> Find PDF generation skills
  - "Automate social media posting" -> Find social media automation skills`,
      inputSchema: AISearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AISearchInput) => {
      try {
        const rawData = await makeApiRequest<unknown>(
          "skills/ai-search",
          apiKey,
          { q: params.query }
        );

        // Validate API response structure before processing
        validateAISearchResponse(rawData);

        // AI search returns results in data.data array with skill objects
        const results = rawData.data?.data || [];
        const skills = results
          .filter((item) => item.skill) // Only include items with skill data
          .map((item) => ({
            ...item.skill!,
            score: item.score,
          }));

        if (!skills.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No skills found for: "${params.query}". Try rephrasing your query or use keyword search for specific terms.`,
              },
            ],
          };
        }

        const output = formatAISearchResponse(skills, params.query);

        return {
          content: [{ type: "text" as const, text: output }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: handleApiError(error),
            },
          ],
        };
      }
    }
  );

  // Tool 3: Read Skill
  server.registerTool(
    "skillsmp_read_skill",
    {
      title: "Read Skill",
      description: `Read a skill's content directly from a GitHub repository and automatically run Cisco Skill Scanner security analysis.

This tool fetches the SKILL.md content from a GitHub repo, then automatically starts a local Skill Scanner API server (via uvx) to detect prompt injection, data exfiltration, and malicious code patterns. The server is reused across scans for fast performance. The skill is NOT installed — only read and scanned.

**IMPORTANT**: Use this to quickly load skill instructions and verify safety without manual steps.

Args:
  - repo (string, required): GitHub repository in 'owner/repo' format
  - skillName (string, required): Name of the skill to read
  - enableScan (boolean, optional): Run security scan (default: true, requires uv)

Returns:
  The full content of the skill's instructions (SKILL.md) with security scan results.

Examples:
  - repo: "existential-birds/beagle", skillName: "python-code-review"
  - repo: "LA3D/skillhelper", skillName: "code-reviewer", enableScan: false`,
      inputSchema: ReadSkillSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ReadSkillInput) => {
      const repoUrl = `https://github.com/${params.repo}.git`;
      const tempDir = join(
        tmpdir(),
        `skillsmp-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      );

      try {
        // Step 1: Shallow clone without checkout (no files written to disk)
        try {
          await execFileAsync(
            "git",
            ["clone", "--no-checkout", "--depth", "1", repoUrl, tempDir],
            { timeout: TIMEOUTS.GIT_CLONE }
          );
        } catch (cloneError) {
          const errorDetails = getErrorDetails(cloneError);
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ **Clone Failed**\n\nRepository: ${params.repo}\n\nError:\n${errorDetails.stderr || errorDetails.message}\n\n💡 **Tip**: For private repos, ensure git SSH keys or credentials are configured`,
              },
            ],
          };
        }

        // Step 2: Find SKILL.md via git ls-tree (handles any directory structure)
        let skillPath: string | null = null;
        try {
          // Use grep to filter only SKILL.md paths directly in git, avoiding large output
          const { stdout } = await execFileAsync(
            "git",
            [
              "ls-tree",
              "-r",
              "--name-only",
              "HEAD",
              `**/${params.skillName}/**/SKILL.md`,
              `**/${params.skillName}/SKILL.md`,
            ],
            {
              cwd: tempDir,
              timeout: TIMEOUTS.GIT_SHOW,
              maxBuffer: MAX_GIT_BUFFER,
            }
          );
          let skillFiles = stdout
            .split("\n")
            .filter((f) => f.endsWith("SKILL.md"));

          // If pathspec matching returned nothing, fall back to full listing with filter
          if (!skillFiles.length) {
            const { stdout: fullStdout } = await execFileAsync(
              "git",
              ["ls-tree", "-r", "--name-only", "HEAD"],
              {
                cwd: tempDir,
                timeout: TIMEOUTS.GIT_SHOW,
                maxBuffer: MAX_GIT_BUFFER, // 10MB — sufficient for skill repos
              }
            );
            skillFiles = fullStdout
              .split("\n")
              .filter((f) => f.endsWith("SKILL.md"))
              .filter((f) =>
                f.toLowerCase().includes(params.skillName.toLowerCase())
              );
          }

          // Find the best match: look for skillName in the path
          skillPath =
            skillFiles.find((f) =>
              f.toLowerCase().includes(params.skillName.toLowerCase())
            ) || null;

          // If no match by skillName, try first SKILL.md
          if (!skillPath && skillFiles.length === 1) {
            skillPath = skillFiles[0]!;
          }

          if (!skillPath && skillFiles.length > 1) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `❌ **Skill Not Found**: Could not find SKILL.md matching "${params.skillName}".\n\n**Available SKILL.md files in this repo:**\n${skillFiles.map((f) => `- ${f}`).join("\n")}\n\n💡 **Tip**: Use a more specific skillName that matches part of the path.`,
                },
              ],
            };
          }
        } catch (lsError) {
          const errorDetails = getErrorDetails(lsError);
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ **List Failed**\n\nError:\n${errorDetails.stderr || errorDetails.message}`,
              },
            ],
          };
        }

        if (!skillPath) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ **Skill Not Found**: No SKILL.md found matching "${params.skillName}" in ${params.repo}.`,
              },
            ],
          };
        }

        // Step 3: Read SKILL.md content via git show (no checkout needed)
        let skillContent: string;
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["show", `HEAD:${skillPath}`],
            { cwd: tempDir, timeout: TIMEOUTS.GIT_SHOW, maxBuffer: 1024 * 1024 }
          );
          skillContent = stdout;
        } catch (readError) {
          const errorDetails = getErrorDetails(readError);
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ **Read Failed**\n\nPath: ${skillPath}\nError:\n${errorDetails.stderr || errorDetails.message}`,
              },
            ],
          };
        }

        // Step 4: Automatically scan via Cisco Skill Scanner API
        let scanResult: ScanResult | undefined;
        if (params.enableScan) {
          try {
            // Determine skill directory from the resolved SKILL.md path
            const skillDirRelative = skillPath.includes("/")
              ? skillPath.substring(0, skillPath.lastIndexOf("/"))
              : ".";

            // Checkout only the skill directory so scanner has files on disk
            await execFileAsync(
              "git",
              ["checkout", "HEAD", "--", skillDirRelative],
              { cwd: tempDir, timeout: TIMEOUTS.GIT_SHOW }
            );

            const skillDirAbsolute =
              skillDirRelative === "."
                ? tempDir
                : join(tempDir, skillDirRelative);

            scanResult = await runSkillScanner(skillDirAbsolute);
          } catch (scanSetupError) {
            const details = getErrorDetails(scanSetupError);
            scanResult = {
              available: true,
              status: "ERROR",
              error: `Failed to checkout skill files for scanning: ${details.message}`,
            };
          }
        }

        const output = formatReadSkillResponse(
          params.repo,
          params.skillName,
          skillContent,
          skillPath,
          scanResult,
          params.enableScan
        );

        return {
          content: [{ type: "text" as const, text: output }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ **Error**: ${error instanceof Error ? error.message : "An unexpected error occurred"}`,
            },
          ],
        };
      } finally {
        // Always clean up temp dir
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );
}

type SkillWithScore = Skill & { score?: number };

function renderSkill(skill: SkillWithScore, index?: number): string[] {
  const lines: string[] = [];

  // Header
  const header =
    index !== undefined ? `## ${index + 1}. ${skill.name}` : `## ${skill.name}`;
  lines.push(header);

  // Meta info
  const meta: string[] = [];
  if (skill.stars !== undefined) meta.push(`⭐ ${skill.stars} stars`);
  if (skill.score !== undefined)
    meta.push(`📊 Score: ${(skill.score * 100).toFixed(1)}%`);
  if (meta.length) lines.push(meta.join(" | "));

  lines.push("");
  lines.push(skill.description || "No description available");

  if (skill.author) {
    lines.push("");
    lines.push(`**Author**: ${skill.author}`);
  }
  if (skill.skillUrl) {
    lines.push(`**URL**: ${skill.skillUrl}`);
  }
  if (skill.tags?.length) {
    lines.push(`**Tags**: ${skill.tags.join(", ")}`);
  }

  lines.push("", "---", "");
  return lines;
}

function formatSkillsResponse(
  skills: Skill[],
  query: string,
  pagination?: SearchResponse["data"]["pagination"]
): string {
  const lines: string[] = [
    `# 🔍 Skills Search Results: "${query}"`,
    "",
    `Found ${pagination?.total || skills.length} skill(s) (showing ${skills.length})`,
    "",
  ];

  skills.forEach((skill, i) => lines.push(...renderSkill(skill, i)));

  if (pagination?.hasNext) {
    lines.push(
      `*More results available. Call this tool again with \`page: ${pagination.page + 1}\` to see more.*`
    );
  }

  return lines.join("\n");
}

function formatAISearchResponse(
  skills: SkillWithScore[],
  query: string
): string {
  const lines: string[] = [
    `# 🤖 AI Semantic Search Results`,
    "",
    `**Query**: "${query}"`,
    "",
    `Found ${skills.length} relevant skill(s)`,
    "",
  ];

  skills.forEach((skill, i) => lines.push(...renderSkill(skill, i)));

  lines.push(
    "💡 **Tip**: Use `skillsmp_read_skill` to read a skill's instructions."
  );

  return lines.join("\n");
}

function formatReadSkillResponse(
  repo: string,
  skillName: string,
  skillContent: string,
  resolvedPath: string,
  scanResult?: ScanResult,
  enableScan?: boolean
): string {
  const lines: string[] = [
    `# 📖 Skill Read: ${skillName}`,
    "",
    `**Repository**: ${repo}`,
    `**Path**: ${resolvedPath}`,
  ];

  // Append scan results if available
  if (scanResult) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## 🔒 Cisco Skill Scanner Results");
    lines.push("");

    if (!scanResult.available) {
      lines.push(`⚠️ **Scanner not available**: ${scanResult.error}`);
    } else if (scanResult.status === "ERROR") {
      lines.push(`❌ **Scan error**: ${scanResult.error}`);
    } else {
      const isSafe =
        scanResult.status === "SAFE" || scanResult.totalFindings === 0;
      lines.push(
        `**Status**: ${isSafe ? "✅ SAFE" : `⚠️ ${scanResult.maxSeverity || "UNKNOWN"}`}`
      );
      lines.push(`**Findings**: ${scanResult.totalFindings ?? 0}`);
      if (scanResult.scanDuration) {
        lines.push(`**Scan Duration**: ${scanResult.scanDuration}`);
      }

      if (scanResult.findings && scanResult.findings.length > 0) {
        lines.push("");
        lines.push("### Findings");
        lines.push("");
        for (const f of scanResult.findings) {
          const severity = f.severity ? `[${f.severity}]` : "";
          const rule = f.rule_id || "unknown-rule";
          const desc = f.description || "No description";
          const analyzer = f.analyzer ? ` (${f.analyzer})` : "";
          const filePath = f.file_path ? ` — ${f.file_path}` : "";
          lines.push(`- **${severity} ${rule}**${analyzer}${filePath}`);
          lines.push(`  ${desc}`);
        }
      }
    }
  } else if (enableScan === false) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## 🔒 Security Scan");
    lines.push("");
    lines.push(
      "⚠️ **Security scanning is disabled**. This skill content has not been verified for safety. Use `enableScan: true` to enable automatic security analysis."
    );
  }

  const contentStartsWithFrontmatter = skillContent
    .trimStart()
    .startsWith("---");

  if (!contentStartsWithFrontmatter) {
    lines.push("");
    lines.push("---");
    lines.push("");
  } else {
    lines.push("");
  }
  lines.push(skillContent);

  return lines.join("\n");
}
