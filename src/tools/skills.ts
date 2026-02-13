import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { execFile } from "child_process";
import { promisify } from "util";
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
  GITHUB_API: 30_000,
  SKILL_SCAN_API: 60_000,
  API_HEALTH_POLL: 500,
  API_STARTUP: 30_000,
} as const;

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

// ── GitHub API helpers ─────────────────────────────────────────────────────────

interface GitHubTreeItem {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

/**
 * Fetch the file tree of a GitHub repo's default branch via the API.
 * Returns an array of blob entries (files only).
 */
async function fetchGitHubTree(
  repo: string
): Promise<{ items: GitHubTreeItem[]; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.GITHUB_API);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "skillsmp-mcp-lite",
        },
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { items: [], error: `GitHub API ${res.status}: ${body}` };
    }
    const json = (await res.json()) as { tree: GitHubTreeItem[] };
    return { items: json.tree.filter((e) => e.type === "blob") };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { items: [], error: `GitHub API error: ${msg}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read a single file from a GitHub repo via the Contents API (base64).
 */
async function fetchGitHubFileContent(
  repo: string,
  path: string
): Promise<{ content: string; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.GITHUB_API);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "skillsmp-mcp-lite",
        },
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { content: "", error: `GitHub API ${res.status}: ${body}` };
    }
    const json = (await res.json()) as { content?: string; encoding?: string };
    if (json.encoding === "base64" && json.content) {
      return { content: Buffer.from(json.content, "base64").toString("utf-8") };
    }
    return { content: "", error: "Unexpected encoding or empty content" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: "", error: `GitHub API error: ${msg}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch multiple files from a GitHub repo in parallel and return their raw
 * bytes keyed by relative path.
 */
async function fetchGitHubFiles(
  repo: string,
  paths: string[]
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  await Promise.all(
    paths.map(async (p) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        TIMEOUTS.GITHUB_API
      );
      try {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(p)}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "skillsmp-mcp-lite",
            },
            signal: controller.signal,
          }
        );
        if (res.ok) {
          const json = (await res.json()) as {
            content?: string;
            encoding?: string;
          };
          if (json.encoding === "base64" && json.content) {
            result.set(p, Buffer.from(json.content, "base64"));
          }
        }
      } catch {
        // skip files that fail
      } finally {
        clearTimeout(timeoutId);
      }
    })
  );
  return result;
}

// ── Minimal in-memory ZIP builder (no dependencies) ───────────────────────────
// Builds an uncompressed (STORE) ZIP archive that the scanner API can accept.

function buildZipBuffer(files: Map<string, Buffer>): Buffer {
  const entries: { name: Buffer; data: Buffer; offset: number }[] = [];
  const parts: Buffer[] = [];
  let offset = 0;

  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, "utf-8");

    // Local file header (30 + nameLen + dataLen)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression: STORE
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc32(data), 14); // crc-32
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26); // name length
    localHeader.writeUInt16LE(0, 28); // extra field length

    entries.push({ name: nameBytes, data, offset });
    parts.push(localHeader, nameBytes, data);
    offset += 30 + nameBytes.length + data.length;
  }

  // Central directory
  const cdStart = offset;
  for (const entry of entries) {
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // signature
    cdHeader.writeUInt16LE(20, 4); // version made by
    cdHeader.writeUInt16LE(20, 6); // version needed
    cdHeader.writeUInt16LE(0, 8); // flags
    cdHeader.writeUInt16LE(0, 10); // compression
    cdHeader.writeUInt16LE(0, 12); // mod time
    cdHeader.writeUInt16LE(0, 14); // mod date
    cdHeader.writeUInt32LE(crc32(entry.data), 16); // crc-32
    cdHeader.writeUInt32LE(entry.data.length, 20); // compressed size
    cdHeader.writeUInt32LE(entry.data.length, 24); // uncompressed size
    cdHeader.writeUInt16LE(entry.name.length, 28); // name length
    cdHeader.writeUInt16LE(0, 30); // extra field length
    cdHeader.writeUInt16LE(0, 32); // comment length
    cdHeader.writeUInt16LE(0, 34); // disk number start
    cdHeader.writeUInt16LE(0, 36); // internal file attributes
    cdHeader.writeUInt32LE(0, 38); // external file attributes
    cdHeader.writeUInt32LE(entry.offset, 42); // relative offset
    parts.push(cdHeader, entry.name);
    offset += 46 + entry.name.length;
  }

  // End of central directory
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // size of CD
  eocd.writeUInt32LE(cdStart, 16); // offset of CD
  eocd.writeUInt16LE(0, 20); // comment length
  parts.push(eocd);

  return Buffer.concat(parts);
}

/** CRC-32 (IEEE 802.3) – tiny table-based implementation */
const crc32Table: number[] = (() => {
  const table: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Scan via /scan-upload (ZIP upload, no local files) ────────────────────────

async function runSkillScannerApi(
  files: Map<string, Buffer>,
  apiUrl: string
): Promise<ScanResult> {
  const scanUrl = `${apiUrl.replace(/\/$/, "")}/scan-upload`;
  const zipBuffer = buildZipBuffer(files);

  // Build multipart/form-data manually to avoid external dependencies
  const boundary = `----SkillSMPBoundary${Date.now()}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, zipBuffer, footer]);

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    TIMEOUTS.SKILL_SCAN_API
  );

  try {
    const response = await fetch(scanUrl, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
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

async function runSkillScanner(
  files: Map<string, Buffer>
): Promise<ScanResult> {
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

  return runSkillScannerApi(files, apiUrl);
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
      description: `Read a skill's content directly from a GitHub repository (via GitHub API, fully online — no local clone) and optionally run Cisco Skill Scanner security analysis.

This tool fetches the SKILL.md content using the GitHub REST API, then optionally starts a local Skill Scanner API server (via uvx) and uploads the skill files as a ZIP for scanning. No files are written to disk. The skill is NOT installed — only read and scanned.

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
      try {
        // Step 1: Fetch the repo file tree via GitHub API
        const { items: treeItems, error: treeError } = await fetchGitHubTree(
          params.repo
        );
        if (treeError || !treeItems.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ **Repository Fetch Failed**\n\nRepository: ${params.repo}\n\nError:\n${treeError || "Empty or inaccessible repository"}\n\n💡 **Tip**: Ensure the repository is public or configure a GITHUB_TOKEN.`,
              },
            ],
          };
        }

        // Step 2: Find SKILL.md matching the skillName
        const skillFiles = treeItems
          .map((item) => item.path)
          .filter((p) => p.endsWith("SKILL.md"));

        let skillPath =
          skillFiles.find((f) =>
            f.toLowerCase().includes(params.skillName.toLowerCase())
          ) || null;

        // If no match by skillName, try the only SKILL.md
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

        // Step 3: Read SKILL.md content via GitHub Contents API
        const { content: skillContent, error: readError } =
          await fetchGitHubFileContent(params.repo, skillPath);
        if (readError || !skillContent) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ **Read Failed**\n\nPath: ${skillPath}\nError:\n${readError || "Empty file"}`,
              },
            ],
          };
        }

        // Step 4: Optionally scan via Cisco Skill Scanner API (/scan-upload)
        let scanResult: ScanResult | undefined;
        if (params.enableScan) {
          try {
            // Determine skill directory from the resolved SKILL.md path
            const skillDirPrefix = skillPath.includes("/")
              ? skillPath.substring(0, skillPath.lastIndexOf("/") + 1)
              : "";

            // Collect all files under the skill directory
            const skillFilePaths = treeItems
              .map((item) => item.path)
              .filter((p) => p.startsWith(skillDirPrefix));

            // Fetch file contents in parallel via GitHub API
            const fileBuffers = await fetchGitHubFiles(
              params.repo,
              skillFilePaths
            );

            // Re-key paths relative to skill directory for the ZIP
            const relativeFiles = new Map<string, Buffer>();
            for (const [fullPath, buf] of fileBuffers) {
              const relativePath = skillDirPrefix
                ? fullPath.slice(skillDirPrefix.length)
                : fullPath;
              relativeFiles.set(relativePath, buf);
            }

            scanResult = await runSkillScanner(relativeFiles);
          } catch (scanError) {
            const details = getErrorDetails(scanError);
            scanResult = {
              available: true,
              status: "ERROR",
              error: `Failed to prepare skill files for scanning: ${details.message}`,
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
