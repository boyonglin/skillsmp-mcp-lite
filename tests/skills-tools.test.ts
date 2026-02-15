import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/api.js", () => ({
  makeApiRequest: vi.fn(),
  handleApiError: vi.fn(
    (error: unknown) =>
      `handled:${error instanceof Error ? error.message : String(error)}`
  ),
  validateSearchResponse: vi.fn(),
  validateAISearchResponse: vi.fn(),
}));

vi.mock("../src/github.js", () => ({
  fetchGitHubTree: vi.fn(),
  fetchGitHubFileContent: vi.fn(),
  fetchGitHubFiles: vi.fn(),
}));

vi.mock("../src/formatters.js", () => ({
  formatSkillsResponse: vi.fn(() => "FORMATTED_SKILLS"),
  formatAISearchResponse: vi.fn(() => "FORMATTED_AI"),
  formatReadSkillResponse: vi.fn(() => "FORMATTED_READ"),
}));

vi.mock("../src/scanner/client.js", () => ({
  runSkillScanner: vi.fn(),
}));

import {
  makeApiRequest,
  handleApiError,
  validateSearchResponse,
  validateAISearchResponse,
} from "../src/api.js";
import {
  fetchGitHubTree,
  fetchGitHubFileContent,
  fetchGitHubFiles,
} from "../src/github.js";
import { formatReadSkillResponse } from "../src/formatters.js";
import { runSkillScanner } from "../src/scanner/client.js";
import { registerSkillsTools } from "../src/tools/skills.js";

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
}>;

function setupHandlers() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  registerSkillsTools(server, "test-key");
  return handlers;
}

describe("registerSkillsTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(fetchGitHubTree).mockResolvedValue({
      items: [
        {
          path: "skills/my-skill/SKILL.md",
          type: "blob",
          sha: "abc",
          size: 100,
        },
      ],
    });

    vi.mocked(fetchGitHubFileContent).mockResolvedValue({
      content: "# Skill Content",
    });

    vi.mocked(fetchGitHubFiles).mockResolvedValue(
      new Map([["skills/my-skill/SKILL.md", Buffer.from("# Skill Content")]])
    );

    vi.mocked(runSkillScanner).mockResolvedValue({
      available: true,
      status: "SAFE",
      totalFindings: 0,
      findings: [],
    });
  });

  it("returns no-results message for keyword search when API has no skills", async () => {
    vi.mocked(makeApiRequest).mockResolvedValue({
      data: { skills: [], pagination: { page: 1 } },
    } as never);

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_search_skills");

    expect(handler).toBeDefined();

    const result = await handler!({ query: "none", page: 1, limit: 20 });

    expect(vi.mocked(validateSearchResponse)).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toContain(
      "No skills found matching 'none'"
    );
  });

  it("uses handleApiError when keyword search API call throws", async () => {
    vi.mocked(makeApiRequest).mockRejectedValue(new Error("boom"));

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_search_skills");

    const result = await handler!({ query: "q", page: 1, limit: 20 });

    expect(vi.mocked(handleApiError)).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toBe("handled:boom");
  });

  it("returns no-results message for AI search when API has no matches", async () => {
    vi.mocked(makeApiRequest).mockResolvedValue({
      data: { data: [] },
    } as never);

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_ai_search_skills");

    const result = await handler!({ query: "nothing" });

    expect(vi.mocked(validateAISearchResponse)).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toContain("No skills found for");
  });

  it("returns formatted AI output when skills are present", async () => {
    vi.mocked(makeApiRequest).mockResolvedValue({
      data: {
        data: [
          {
            score: 0.8,
            skill: {
              id: "1",
              name: "skill",
              description: "desc",
            },
          },
        ],
      },
    } as never);

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_ai_search_skills");

    const result = await handler!({ query: "find" });

    expect(result.content[0]?.text).toBe("FORMATTED_AI");
  });

  it("returns repository fetch failure when tree is empty", async () => {
    vi.mocked(fetchGitHubTree).mockResolvedValue({
      items: [],
      error: "repo unreachable",
    });

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_read_skill");

    const result = await handler!({
      repo: "owner/repo",
      skillName: "my-skill",
      enableScan: true,
    });

    expect(result.content[0]?.text).toContain("Repository Fetch Failed");
    expect(result.content[0]?.text).toContain("repo unreachable");
  });

  it("returns disambiguation error when multiple SKILL.md files match none", async () => {
    vi.mocked(fetchGitHubTree).mockResolvedValue({
      items: [
        { path: "skills/a/SKILL.md", type: "blob", sha: "1", size: 10 },
        { path: "skills/b/SKILL.md", type: "blob", sha: "2", size: 10 },
      ],
    });

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_read_skill");

    const result = await handler!({
      repo: "owner/repo",
      skillName: "missing",
      enableScan: true,
    });

    expect(result.content[0]?.text).toContain("Skill Not Found");
    expect(result.content[0]?.text).toContain("skills/a/SKILL.md");
    expect(result.content[0]?.text).toContain("skills/b/SKILL.md");
  });

  it("returns read failure when SKILL.md cannot be read", async () => {
    vi.mocked(fetchGitHubFileContent).mockResolvedValue({
      content: "",
      error: "404",
    });

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_read_skill");

    const result = await handler!({
      repo: "owner/repo",
      skillName: "my-skill",
      enableScan: true,
    });

    expect(result.content[0]?.text).toContain("Read Failed");
    expect(result.content[0]?.text).toContain("404");
  });

  it("falls back to the only SKILL.md when single file exists", async () => {
    vi.mocked(fetchGitHubTree).mockResolvedValue({
      items: [
        {
          path: "skills/only/SKILL.md",
          type: "blob",
          sha: "abc",
          size: 42,
        },
      ],
    });

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_read_skill");

    const result = await handler!({
      repo: "owner/repo",
      skillName: "non-matching",
      enableScan: false,
    });

    expect(result.content[0]?.text).toBe("FORMATTED_READ");
    const args = vi.mocked(formatReadSkillResponse).mock.calls[0]!;
    expect(args[3]).toBe("skills/only/SKILL.md");
  });

  it("includes scan note when oversized files are excluded", async () => {
    vi.mocked(fetchGitHubTree).mockResolvedValue({
      items: [
        {
          path: "skills/my-skill/SKILL.md",
          type: "blob",
          sha: "1",
          size: 200,
        },
        {
          path: "skills/my-skill/huge.bin",
          type: "blob",
          sha: "2",
          size: 600 * 1024,
        },
      ],
    });
    vi.mocked(fetchGitHubFiles).mockResolvedValue(
      new Map([["skills/my-skill/SKILL.md", Buffer.from("# Skill")]])
    );

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_read_skill");

    await handler!({
      repo: "owner/repo",
      skillName: "my-skill",
      enableScan: true,
    });

    const args = vi.mocked(formatReadSkillResponse).mock.calls[0]!;
    expect(args[6]).toContain("Scan scope was limited");
  });

  it("passes scan preparation errors to formatter as ERROR scanResult", async () => {
    vi.mocked(fetchGitHubFiles).mockResolvedValue(
      new Map([["skills/my-skill/README.md", Buffer.from("not skill md")]])
    );

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_read_skill");

    const result = await handler!({
      repo: "owner/repo",
      skillName: "my-skill",
      enableScan: true,
    });

    expect(vi.mocked(runSkillScanner)).not.toHaveBeenCalled();
    expect(vi.mocked(formatReadSkillResponse)).toHaveBeenCalledTimes(1);

    const args = vi.mocked(formatReadSkillResponse).mock.calls[0]!;
    expect(args[4]).toMatchObject({
      available: true,
      status: "ERROR",
    });
    expect(result.content[0]?.text).toBe("FORMATTED_READ");
  });

  it("skips scanner when enableScan is false", async () => {
    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_read_skill");

    await handler!({
      repo: "owner/repo",
      skillName: "my-skill",
      enableScan: false,
    });

    expect(vi.mocked(runSkillScanner)).not.toHaveBeenCalled();
    const args = vi.mocked(formatReadSkillResponse).mock.calls[0]!;
    expect(args[4]).toBeUndefined();
    expect(args[5]).toBe(false);
  });

  it("returns top-level error for unexpected exceptions", async () => {
    vi.mocked(fetchGitHubTree).mockRejectedValue(new Error("fatal"));

    const handlers = setupHandlers();
    const handler = handlers.get("skillsmp_read_skill");

    const result = await handler!({
      repo: "owner/repo",
      skillName: "my-skill",
      enableScan: true,
    });

    expect(result.content[0]?.text).toContain("❌ **Error**: fatal");
  });
});
