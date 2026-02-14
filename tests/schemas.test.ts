import { describe, it, expect } from "vitest";
import {
  KeywordSearchSchema,
  AISearchSchema,
  ReadSkillSchema,
} from "../src/schemas.js";

/* ------------------------------------------------------------------ */
/*  KeywordSearchSchema                                                */
/* ------------------------------------------------------------------ */
describe("KeywordSearchSchema", () => {
  it("accepts minimal valid input and applies defaults", () => {
    const result = KeywordSearchSchema.parse({ query: "hello" });
    expect(result.query).toBe("hello");
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.sortBy).toBeUndefined();
  });

  it("accepts full valid input", () => {
    const result = KeywordSearchSchema.parse({
      query: "web",
      page: 2,
      limit: 50,
      sortBy: "stars",
    });
    expect(result.page).toBe(2);
    expect(result.limit).toBe(50);
    expect(result.sortBy).toBe("stars");
  });

  it("rejects empty query", () => {
    expect(() => KeywordSearchSchema.parse({ query: "" })).toThrow();
  });

  it("rejects query exceeding 200 chars", () => {
    expect(() =>
      KeywordSearchSchema.parse({ query: "x".repeat(201) })
    ).toThrow();
  });

  it("rejects page < 1", () => {
    expect(() => KeywordSearchSchema.parse({ query: "q", page: 0 })).toThrow();
  });

  it("rejects limit > 100", () => {
    expect(() =>
      KeywordSearchSchema.parse({ query: "q", limit: 101 })
    ).toThrow();
  });

  it("rejects invalid sortBy value", () => {
    expect(() =>
      KeywordSearchSchema.parse({ query: "q", sortBy: "invalid" })
    ).toThrow();
  });

  it("rejects extra properties (strict mode)", () => {
    expect(() =>
      KeywordSearchSchema.parse({ query: "q", extra: true })
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/*  AISearchSchema                                                     */
/* ------------------------------------------------------------------ */
describe("AISearchSchema", () => {
  it("accepts valid input", () => {
    const result = AISearchSchema.parse({ query: "build a dashboard" });
    expect(result.query).toBe("build a dashboard");
  });

  it("rejects empty query", () => {
    expect(() => AISearchSchema.parse({ query: "" })).toThrow();
  });

  it("rejects query exceeding 500 chars", () => {
    expect(() => AISearchSchema.parse({ query: "x".repeat(501) })).toThrow();
  });

  it("rejects extra properties (strict mode)", () => {
    expect(() => AISearchSchema.parse({ query: "q", page: 1 })).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/*  ReadSkillSchema                                                    */
/* ------------------------------------------------------------------ */
describe("ReadSkillSchema", () => {
  it("accepts valid input and defaults enableScan to true", () => {
    const result = ReadSkillSchema.parse({
      repo: "owner/repo",
      skillName: "my-skill",
    });
    expect(result.enableScan).toBe(true);
  });

  it("accepts dots, hyphens, underscores in repo name", () => {
    const result = ReadSkillSchema.parse({
      repo: "my_org.name/my-repo.v2",
      skillName: "skill_1",
    });
    expect(result.repo).toBe("my_org.name/my-repo.v2");
  });

  it("rejects repo without slash", () => {
    expect(() =>
      ReadSkillSchema.parse({ repo: "noslash", skillName: "s" })
    ).toThrow();
  });

  it("rejects repo with spaces", () => {
    expect(() =>
      ReadSkillSchema.parse({ repo: "owner/my repo", skillName: "s" })
    ).toThrow();
  });

  it("rejects repo with multiple slashes", () => {
    expect(() =>
      ReadSkillSchema.parse({ repo: "a/b/c", skillName: "s" })
    ).toThrow();
  });

  it("rejects skillName with spaces", () => {
    expect(() =>
      ReadSkillSchema.parse({ repo: "a/b", skillName: "bad name" })
    ).toThrow();
  });

  it("rejects skillName with dots", () => {
    expect(() =>
      ReadSkillSchema.parse({ repo: "a/b", skillName: "bad.name" })
    ).toThrow();
  });

  it("accepts skillName with hyphens and underscores", () => {
    const result = ReadSkillSchema.parse({
      repo: "a/b",
      skillName: "my-skill_v2",
    });
    expect(result.skillName).toBe("my-skill_v2");
  });

  it("rejects skillName exceeding 100 chars", () => {
    expect(() =>
      ReadSkillSchema.parse({ repo: "a/b", skillName: "x".repeat(101) })
    ).toThrow();
  });

  it("honours explicit enableScan: false", () => {
    const result = ReadSkillSchema.parse({
      repo: "a/b",
      skillName: "s",
      enableScan: false,
    });
    expect(result.enableScan).toBe(false);
  });

  it("rejects extra properties (strict mode)", () => {
    expect(() =>
      ReadSkillSchema.parse({
        repo: "a/b",
        skillName: "s",
        extra: true,
      })
    ).toThrow();
  });
});
