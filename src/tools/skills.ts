import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  makeApiRequest,
  handleApiError,
  validateSearchResponse,
  validateAISearchResponse,
} from "../api.js";
import {
  KeywordSearchSchema,
  AISearchSchema,
  ReadSkillSchema,
  type KeywordSearchInput,
  type AISearchInput,
  type ReadSkillInput,
} from "../schemas.js";
import type { ScanResult } from "../scanner/types.js";
import { runSkillScanner } from "../scanner/client.js";
import {
  fetchGitHubTree,
  fetchGitHubFileContent,
  fetchGitHubFiles,
} from "../github.js";
import {
  formatSkillsResponse,
  formatAISearchResponse,
  formatReadSkillResponse,
} from "../formatters.js";
import { getErrorMessage } from "../utils.js";

/** Three-layer scan limits — applied BEFORE downloading files via GitHub tree size */
const SCAN_LIMITS = {
  /** Maximum number of files to include in a scan */
  MAX_FILES: 100,
  /** Maximum size of a single file in bytes (500 KB) */
  MAX_SINGLE_FILE_BYTES: 500 * 1024,
  /** Maximum total size of all files in bytes (5 MB) */
  MAX_TOTAL_BYTES: 5 * 1024 * 1024,
} as const;

/**
 * Register SkillsMP tools on the MCP server
 */
export function registerSkillsTools(server: McpServer, apiKey: string) {
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

        validateAISearchResponse(rawData);

        const results = rawData.data?.data || [];
        const skills = results
          .filter((item) => item.skill)
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
        const enableScan = params.enableScan !== false;

        const { items: treeItems, error: treeError } = await fetchGitHubTree(
          params.repo
        );
        if (!treeItems.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ **Repository Fetch Failed**\n\nRepository: ${params.repo}\n\nError:\n${treeError || "Empty or inaccessible repository"}\n\n💡 **Tip**: Ensure the repository is public or configure a GITHUB_TOKEN.`,
              },
            ],
          };
        }
        if (treeError) {
          console.error(`[ReadSkill] ${treeError}`);
        }

        const skillFiles = treeItems
          .map((item) => item.path)
          .filter((p) => p.endsWith("SKILL.md"));

        let skillPath =
          skillFiles.find((f) =>
            f.toLowerCase().includes(params.skillName.toLowerCase())
          ) || null;

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

        let scanResult: ScanResult | undefined;
        let scanNote: string | undefined;
        if (enableScan) {
          try {
            const skillDirPrefix = skillPath.includes("/")
              ? skillPath.substring(0, skillPath.lastIndexOf("/") + 1)
              : "";

            const skillDirItems = treeItems
              .filter(
                (item) =>
                  item.type === "blob" && item.path.startsWith(skillDirPrefix)
              )
              .sort((a, b) => {
                const aIsSkill =
                  a.path.endsWith("/SKILL.md") || a.path === "SKILL.md" ? 0 : 1;
                const bIsSkill =
                  b.path.endsWith("/SKILL.md") || b.path === "SKILL.md" ? 0 : 1;
                if (aIsSkill !== bIsSkill) return aIsSkill - bIsSkill;
                return (a.size ?? 0) - (b.size ?? 0);
              });

            // Apply three-layer scan limits using GitHub tree size
            let excludedCount = 0;
            let excludedBytes = 0;
            let acceptedBytes = 0;
            const acceptedPaths: string[] = [];

            for (const item of skillDirItems) {
              const fileSize = item.size ?? 0;

              if (fileSize > SCAN_LIMITS.MAX_SINGLE_FILE_BYTES) {
                excludedCount++;
                excludedBytes += fileSize;
                continue;
              }

              if (acceptedBytes + fileSize > SCAN_LIMITS.MAX_TOTAL_BYTES) {
                excludedCount++;
                excludedBytes += fileSize;
                continue;
              }

              if (acceptedPaths.length >= SCAN_LIMITS.MAX_FILES) {
                excludedCount++;
                excludedBytes += fileSize;
                continue;
              }

              acceptedPaths.push(item.path);
              acceptedBytes += fileSize;
            }

            if (excludedCount > 0) {
              const excludedKB = (excludedBytes / 1024).toFixed(1);
              scanNote =
                `⚠️ Scan scope was limited: ${excludedCount} file(s) excluded ` +
                `(${excludedKB} KB) due to scan limits ` +
                `(max ${SCAN_LIMITS.MAX_FILES} files, ` +
                `max ${(SCAN_LIMITS.MAX_SINGLE_FILE_BYTES / 1024).toFixed(0)} KB/file, ` +
                `max ${(SCAN_LIMITS.MAX_TOTAL_BYTES / 1024 / 1024).toFixed(0)} MB total).`;
            }

            const fileBuffers = await fetchGitHubFiles(
              params.repo,
              acceptedPaths
            );

            const relativeFiles = new Map<string, Buffer>();
            for (const [fullPath, buf] of fileBuffers) {
              const relativePath = skillDirPrefix
                ? fullPath.slice(skillDirPrefix.length)
                : fullPath;
              relativeFiles.set(relativePath, buf);
            }

            const skillMdKey = skillDirPrefix
              ? skillPath.slice(skillDirPrefix.length)
              : skillPath;
            if (relativeFiles.size === 0 || !relativeFiles.has(skillMdKey)) {
              throw new Error(
                `No valid skill files were fetched for scanning (missing ${skillMdKey}).`
              );
            }

            scanResult = await runSkillScanner(relativeFiles);
          } catch (scanError) {
            scanResult = {
              available: true,
              status: "ERROR",
              error: `Failed to prepare skill files for scanning: ${getErrorMessage(scanError)}`,
            };
          }
        }

        const output = formatReadSkillResponse(
          params.repo,
          params.skillName,
          skillContent,
          skillPath,
          scanResult,
          enableScan,
          scanNote
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
