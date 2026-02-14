import { describe, it, expect } from "vitest";
import {
  formatSkillsResponse,
  formatAISearchResponse,
  formatReadSkillResponse,
} from "../src/formatters.js";
import type { ScanResult } from "../src/scanner/types.js";

const MOCK_SKILL = {
  id: "1",
  name: "test-skill",
  description: "A test skill",
  author: "testauthor",
  stars: 5,
  tags: ["test", "demo"],
  skillUrl: "https://example.com/skill",
};

describe("formatSkillsResponse", () => {
  it("includes query and skill name in output", () => {
    const output = formatSkillsResponse([MOCK_SKILL], "test query");
    expect(output).toContain("test query");
    expect(output).toContain("test-skill");
    expect(output).toContain("A test skill");
    expect(output).toContain("testauthor");
  });

  it("shows pagination hint when hasNext is true", () => {
    const pagination = {
      page: 1,
      limit: 20,
      total: 50,
      totalPages: 3,
      hasNext: true,
      hasPrev: false,
    };
    const output = formatSkillsResponse([MOCK_SKILL], "q", pagination);
    expect(output).toContain("page: 2");
  });

  it("handles empty skills array", () => {
    const output = formatSkillsResponse([], "empty");
    expect(output).toContain("0 skill(s)");
  });
});

describe("formatAISearchResponse", () => {
  it("includes query and skill details", () => {
    const skill = { ...MOCK_SKILL, score: 0.95 };
    const output = formatAISearchResponse([skill], "find something");
    expect(output).toContain("find something");
    expect(output).toContain("test-skill");
    expect(output).toContain("95.0%");
  });
});

describe("formatReadSkillResponse", () => {
  it("includes repo and skill content", () => {
    const output = formatReadSkillResponse(
      "owner/repo",
      "my-skill",
      "# Skill Content",
      "skills/my-skill/SKILL.md"
    );
    expect(output).toContain("owner/repo");
    expect(output).toContain("my-skill");
    expect(output).toContain("# Skill Content");
  });

  it("shows SAFE status for safe scan results", () => {
    const scanResult: ScanResult = {
      available: true,
      status: "SAFE",
      totalFindings: 0,
      findings: [],
      analyzersUsed: ["static_analyzer", "behavioral_analyzer"],
    };
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      "content",
      "SKILL.md",
      scanResult,
      true
    );
    expect(output).toContain("✅ SAFE");
    expect(output).not.toContain("Untrusted Content Notice");
  });

  it("shows untrusted notice when scan is disabled", () => {
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      "content",
      "SKILL.md",
      undefined,
      false
    );
    expect(output).toContain("Untrusted Content Notice");
    expect(output).toContain("Security scanning is disabled");
  });

  it("shows untrusted notice for UNSAFE results", () => {
    const scanResult: ScanResult = {
      available: true,
      status: "UNSAFE",
      maxSeverity: "HIGH",
      totalFindings: 1,
      findings: [
        {
          rule_id: "TEST-001",
          severity: "HIGH",
          description: "Bad pattern",
          analyzer: "static_analyzer",
        },
      ],
      analyzersUsed: ["static_analyzer"],
    };
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      "content",
      "SKILL.md",
      scanResult,
      true
    );
    expect(output).toContain("Untrusted Content Notice");
    expect(output).toContain("TEST-001");
    expect(output).toContain("Bad pattern");
  });

  it("includes scan note when provided", () => {
    const scanResult: ScanResult = {
      available: true,
      status: "SAFE",
      totalFindings: 0,
      findings: [],
    };
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      "content",
      "SKILL.md",
      scanResult,
      true,
      "⚠️ Some files excluded"
    );
    expect(output).toContain("Some files excluded");
  });

  it("shows scanner-unavailable message and untrusted notice", () => {
    const scanResult: ScanResult = {
      available: false,
      error: "uvx is not installed",
    };
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      "content",
      "SKILL.md",
      scanResult,
      true
    );
    expect(output).toContain("Scanner not available");
    expect(output).toContain("uvx is not installed");
    expect(output).toContain("Untrusted Content Notice");
  });

  it("shows scan error message and untrusted notice", () => {
    const scanResult: ScanResult = {
      available: true,
      status: "ERROR",
      error: "API timed out",
    };
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      "content",
      "SKILL.md",
      scanResult,
      true
    );
    expect(output).toContain("Scan error");
    expect(output).toContain("API timed out");
    expect(output).toContain("Untrusted Content Notice");
  });

  it("shows scan duration when present", () => {
    const scanResult: ScanResult = {
      available: true,
      status: "SAFE",
      totalFindings: 0,
      findings: [],
      analyzersUsed: ["static_analyzer", "behavioral_analyzer"],
      scanDuration: "2.5s",
    };
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      "content",
      "SKILL.md",
      scanResult,
      true
    );
    expect(output).toContain("Scan Duration");
    expect(output).toContain("2.5s");
  });

  it("falls back to CORE_ANALYZERS when analyzersUsed is empty", () => {
    const scanResult: ScanResult = {
      available: true,
      status: "SAFE",
      totalFindings: 0,
      findings: [],
      analyzersUsed: [],
    };
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      "content",
      "SKILL.md",
      scanResult,
      true
    );
    expect(output).toContain("static_analyzer");
    expect(output).toContain("behavioral_analyzer");
  });

  it("handles content starting with frontmatter (no extra ---)", () => {
    const content = "---\nname: test\n---\n# Hello";
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      content,
      "SKILL.md"
    );
    // Should contain the frontmatter directly without doubling separators
    expect(output).toContain("---\nname: test");
    // Should NOT have "---\n\n---" (double separator)
    expect(output).not.toMatch(/---\n\n---\n\n---/);
  });

  it("adds separator before content without frontmatter", () => {
    const content = "# Just a heading";
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      content,
      "SKILL.md"
    );
    expect(output).toContain("---");
    expect(output).toContain("# Just a heading");
  });

  it("renders findings with missing optional fields", () => {
    const scanResult: ScanResult = {
      available: true,
      status: "UNSAFE",
      maxSeverity: "MEDIUM",
      totalFindings: 1,
      findings: [
        {
          // All optional fields missing except description
          description: "Suspicious pattern found",
        },
      ],
    };
    const output = formatReadSkillResponse(
      "owner/repo",
      "skill",
      "content",
      "SKILL.md",
      scanResult,
      true
    );
    expect(output).toContain("unknown-rule");
    expect(output).toContain("Suspicious pattern found");
  });
});

/* ------------------------------------------------------------------ */
/*  formatSkillsResponse — additional edge cases                       */
/* ------------------------------------------------------------------ */
describe("formatSkillsResponse (edge cases)", () => {
  it("shows total from skills.length when pagination is undefined", () => {
    const skills = [
      { id: "1", name: "a", description: "d1" },
      { id: "2", name: "b", description: "d2" },
    ];
    const output = formatSkillsResponse(skills, "q");
    expect(output).toContain("2 skill(s)");
  });

  it("does not show pagination hint when hasNext is false", () => {
    const pagination = {
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    };
    const output = formatSkillsResponse(
      [{ id: "1", name: "a", description: "d" }],
      "q",
      pagination
    );
    expect(output).not.toContain("page:");
  });

  it("renders skill with no optional fields", () => {
    const output = formatSkillsResponse(
      [{ id: "1", name: "bare", description: "" }],
      "q"
    );
    expect(output).toContain("bare");
    expect(output).toContain("No description available");
  });
});

/* ------------------------------------------------------------------ */
/*  formatAISearchResponse — additional edge cases                     */
/* ------------------------------------------------------------------ */
describe("formatAISearchResponse (edge cases)", () => {
  it("handles empty results", () => {
    const output = formatAISearchResponse([], "nope");
    expect(output).toContain("0 relevant skill(s)");
  });

  it("renders skill without score", () => {
    const output = formatAISearchResponse(
      [{ id: "1", name: "no-score", description: "d" }],
      "q"
    );
    expect(output).toContain("no-score");
    expect(output).not.toContain("Score:");
  });
});
