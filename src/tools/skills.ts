import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
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
} as const;

/**
 * Safely extract error message from unknown error type
 */
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
        };

        if (params.page) queryParams.page = params.page;
        if (params.limit) queryParams.limit = params.limit;
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
          structuredContent: {
            query: params.query,
            count: skills.length,
            skills: skills,
            pagination: pagination,
          },
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
          structuredContent: {
            query: params.query,
            count: skills.length,
            skills: skills,
          },
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
      description: `Read a skill's content directly from a GitHub repository.

This tool fetches the SKILL.md content from a GitHub repo without checking out files to disk, avoiding antivirus and Windows path issues.

**IMPORTANT**: Use this to quickly load skill instructions without manual steps.

Args:
  - repo (string, required): GitHub repository in 'owner/repo' format
  - skillName (string, required): Name of the skill to read

Returns:
  The full content of the skill's instructions (SKILL.md).

Examples:
  - repo: "existential-birds/beagle", skillName: "python-code-review"
  - repo: "LA3D/skillhelper", skillName: "code-reviewer"`,
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
              maxBuffer: 10 * 1024 * 1024,
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
                maxBuffer: 50 * 1024 * 1024,
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
            skillPath = skillFiles[0];
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

        const output = formatReadSkillResponse(
          params.repo,
          params.skillName,
          skillContent,
          skillPath
        );

        return {
          content: [{ type: "text" as const, text: output }],
          structuredContent: {
            repo: params.repo,
            skillName: params.skillName,
            skillContent: skillContent,
            resolvedPath: skillPath,
          },
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

/**
 * Render a single skill as markdown lines
 */
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

/**
 * Format skills search response as markdown
 */
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

  skills.forEach((skill) => lines.push(...renderSkill(skill)));

  if (pagination?.hasNext) {
    lines.push(
      `*More results available. Call this tool again with \`page: ${pagination.page + 1}\` to see more.*`
    );
  }

  return lines.join("\n");
}

/**
 * Format AI search response as markdown
 */
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

/**
 * Format read skill response as markdown
 */
function formatReadSkillResponse(
  repo: string,
  skillName: string,
  skillContent: string,
  resolvedPath: string
): string {
  const lines: string[] = [
    `# 📖 Skill Read: ${skillName}`,
    "",
    `**Repository**: ${repo}`,
    `**Path**: ${resolvedPath}`,
    "",
    "---",
    "",
    skillContent,
  ];

  return lines.join("\n");
}
