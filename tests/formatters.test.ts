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
});
