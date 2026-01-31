import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  makeApiRequest,
  handleApiError,
  validateSearchResponse,
  validateAISearchResponse,
  type SearchResponse,
  type AISearchResponse,
  type Skill
} from "../api.js";
import { KeywordSearchSchema, AISearchSchema, InstallAndReadSchema, type KeywordSearchInput, type AISearchInput, type InstallAndReadInput } from "../schemas.js";

const execFileAsync = promisify(execFile);

// Timeout constants (in milliseconds)
const TIMEOUTS = {
  READ: 30_000,
  INSTALL: 120_000
} as const;

/**
 * Safely extract error message from unknown error type
 */
function getErrorDetails(error: unknown): { message: string; stderr?: string } {
  if (error instanceof Error) {
    const execError = error as Error & { stderr?: string; stdout?: string };
    return {
      message: execError.message,
      stderr: execError.stderr
    };
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    return {
      message: String(e.message || 'Unknown error'),
      stderr: typeof e.stderr === 'string' ? e.stderr : undefined
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
        openWorldHint: true
      }
    },
    async (params: KeywordSearchInput) => {
      try {
        const queryParams: Record<string, string | number> = {
          q: params.query
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
            content: [{
              type: "text" as const,
              text: `No skills found matching '${params.query}'. Try different keywords or use AI semantic search for natural language queries.`
            }]
          };
        }

        const output = formatSkillsResponse(skills, params.query, pagination);

        return {
          content: [{ type: "text" as const, text: output }],
          structuredContent: {
            query: params.query,
            count: skills.length,
            skills: skills,
            pagination: pagination
          }
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: handleApiError(error)
          }]
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
        openWorldHint: true
      }
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
          .filter(item => item.skill) // Only include items with skill data
          .map(item => ({
            ...item.skill!,
            score: item.score
          }));

        if (!skills.length) {
          return {
            content: [{
              type: "text" as const,
              text: `No skills found for: "${params.query}". Try rephrasing your query or use keyword search for specific terms.`
            }]
          };
        }

        const output = formatAISearchResponse(skills, params.query);

        return {
          content: [{ type: "text" as const, text: output }],
          structuredContent: {
            query: params.query,
            count: skills.length,
            skills: skills
          }
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: handleApiError(error)
          }]
        };
      }
    }
  );

  // Tool 3: Install and Read Skill
  server.registerTool(
    "skillsmp_install_and_read_skill",
    {
      title: "Install and Read Skill",
      description: `Install a skill from GitHub and immediately read its content.

This tool first checks if the skill is already installed locally. If found, it skips installation and directly reads the content (faster). If not found, it installs from GitHub first.

**IMPORTANT**: Use this to quickly load skill instructions without manual steps.

Args:
  - repo (string, required): GitHub repository in 'owner/repo' format
  - skillName (string, required): Name of the skill to read after installation
  - global (boolean, optional): Install globally to ~/.claude/skills/ (default: false)
  - universal (boolean, optional): Install to .agent/skills/ for universal usage (default: false)

Returns:
  The full content of the skill's instructions (SKILL.md).

Examples:
  - repo: "existential-birds/beagle", skillName: "python-code-review"
  - repo: "LA3D/skillhelper", skillName: "code-reviewer"`,
      inputSchema: InstallAndReadSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: InstallAndReadInput) => {
      try {
        const readArgs = ["-y", "openskills", "read", params.skillName];

        // Step 1: Check if skill already exists locally
        try {
          const { stdout } = await execFileAsync("npx", readArgs, { timeout: TIMEOUTS.READ });
          if (stdout && !stdout.includes("not found") && !stdout.includes("Error")) {
            const output = formatInstallAndReadResponse(params.repo, params.skillName, stdout, true);
            return {
              content: [{ type: "text" as const, text: output }],
              structuredContent: {
                repo: params.repo,
                skillName: params.skillName,
                skillContent: stdout,
                wasAlreadyInstalled: true
              }
            };
          }
        } catch {
          // Skill not found locally, proceed with installation
        }

        // Step 2: Install if not exists
        const installArgs = ["-y", "openskills", "install", params.repo];
        if (params.global) installArgs.push("--global");
        if (params.universal) installArgs.push("--universal");

        let installOutput: string;
        try {
          const { stdout, stderr } = await execFileAsync("npx", installArgs, { timeout: TIMEOUTS.INSTALL });
          installOutput = stdout || stderr;
        } catch (installError) {
          const errorDetails = getErrorDetails(installError);
          return {
            content: [{
              type: "text" as const,
              text: `❌ **Installation Failed**\n\nRepository: ${params.repo}\n\nError:\n${errorDetails.stderr || errorDetails.message}`
            }]
          };
        }

        // Step 3: Read the skill after installation
        let readOutput: string;
        try {
          const { stdout, stderr } = await execFileAsync("npx", readArgs, { timeout: TIMEOUTS.READ });
          readOutput = stdout || stderr;
        } catch (readError) {
          const errorDetails = getErrorDetails(readError);
          return {
            content: [{
              type: "text" as const,
              text: `✅ **Installation Succeeded** but **Read Failed**\n\nRepository: ${params.repo}\nSkill: ${params.skillName}\n\n**Install Output:**\n${installOutput}\n\n**Read Error:**\n${errorDetails.stderr || errorDetails.message}\n\n💡 **Tip**: Check if the skill name is correct. Use \`npx openskills list\` to see installed skills.`
            }]
          };
        }

        const output = formatInstallAndReadResponse(params.repo, params.skillName, readOutput, false);

        return {
          content: [{ type: "text" as const, text: output }],
          structuredContent: {
            repo: params.repo,
            skillName: params.skillName,
            skillContent: readOutput,
            wasAlreadyInstalled: false
          }
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ **Error**: ${error instanceof Error ? error.message : "An unexpected error occurred"}`
          }]
        };
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
  const header = index !== undefined ? `## ${index + 1}. ${skill.name}` : `## ${skill.name}`;
  lines.push(header);

  // Meta info
  const meta: string[] = [];
  if (skill.stars !== undefined) meta.push(`⭐ ${skill.stars} stars`);
  if (skill.score !== undefined) meta.push(`📊 Score: ${(skill.score * 100).toFixed(1)}%`);
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
  pagination?: SearchResponse['data']['pagination']
): string {
  const lines: string[] = [
    `# 🔍 Skills Search Results: "${query}"`,
    "",
    `Found ${pagination?.total || skills.length} skill(s) (showing ${skills.length})`,
    ""
  ];

  skills.forEach(skill => lines.push(...renderSkill(skill)));

  if (pagination?.hasNext) {
    lines.push(`*More results available. Call this tool again with \`page: ${pagination.page + 1}\` to see more.*`);
  }

  return lines.join("\n");
}

/**
 * Format AI search response as markdown
 */
function formatAISearchResponse(skills: SkillWithScore[], query: string): string {
  const lines: string[] = [
    `# 🤖 AI Semantic Search Results`,
    "",
    `**Query**: "${query}"`,
    "",
    `Found ${skills.length} relevant skill(s)`,
    ""
  ];

  skills.forEach((skill, i) => lines.push(...renderSkill(skill, i)));

  lines.push("💡 **Tip**: Use `skillsmp_install_and_read_skill` to install and load a skill's instructions.");

  return lines.join("\n");
}

/**
 * Format install and read response as markdown
 */
function formatInstallAndReadResponse(repo: string, skillName: string, skillContent: string, wasAlreadyInstalled: boolean): string {
  const statusIcon = wasAlreadyInstalled ? "📖" : "📦";
  const statusText = wasAlreadyInstalled ? "Skill Loaded (already installed)" : "Skill Installed & Loaded";

  const lines: string[] = [
    `# ${statusIcon} ${statusText}: ${skillName}`,
    "",
    `**Repository**: ${repo}`,
    wasAlreadyInstalled ? "**Status**: ⚡ Loaded from local cache (skipped installation)" : "**Status**: ✅ Freshly installed",
    "",
    "---",
    "",
    skillContent
  ];

  return lines.join("\n");
}
