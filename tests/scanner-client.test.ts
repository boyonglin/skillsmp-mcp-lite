import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/scanner/lifecycle.js", () => ({
  ensureScannerApi: vi.fn(),
}));

vi.mock("../src/zip.js", () => ({
  buildZipBuffer: vi.fn(() => Buffer.from("zip-bytes")),
}));

import { ensureScannerApi } from "../src/scanner/lifecycle.js";
import { runSkillScanner } from "../src/scanner/client.js";

describe("runSkillScanner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(ensureScannerApi).mockResolvedValue("http://localhost:8000");
  });

  it("returns scanner unavailable message when ensureScannerApi fails", async () => {
    vi.mocked(ensureScannerApi).mockResolvedValue("");

    const result = await runSkillScanner(
      new Map([["SKILL.md", Buffer.from("x")]])
    );

    expect(result.available).toBe(false);
    expect(result.error).toContain("Security scanner not available");
  });

  it("returns API error when /scan-upload responds non-ok", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
    } as Response);

    const result = await runSkillScanner(
      new Map([["SKILL.md", Buffer.from("x")]])
    );

    expect(result.available).toBe(true);
    expect(result.status).toBe("ERROR");
    expect(result.error).toContain("500");
  });

  it("returns API error when /scan-upload returns invalid json", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Response);

    const result = await runSkillScanner(
      new Map([["SKILL.md", Buffer.from("x")]])
    );

    expect(result.available).toBe(true);
    expect(result.status).toBe("ERROR");
    expect(result.error).toContain("invalid JSON");
  });

  it("parses safe scan response and normalizes analyzers", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        is_safe: true,
        max_severity: "LOW",
        findings_count: 1,
        analyzers_used: ["static", "behavioral_analyzer"],
        findings: [
          {
            rule_id: "R-1",
            severity: "LOW",
            description: "desc",
            file_path: "SKILL.md",
            analyzer: "STATIC_ANALYZER",
          },
        ],
        scan_duration_seconds: 2.5,
      }),
    } as Response);

    const result = await runSkillScanner(
      new Map([["SKILL.md", Buffer.from("x")]])
    );

    expect(result.available).toBe(true);
    expect(result.status).toBe("SAFE");
    expect(result.totalFindings).toBe(1);
    expect(result.analyzersUsed).toEqual([
      "static_analyzer",
      "behavioral_analyzer",
    ]);
    expect(result.scanDuration).toBe("2.5s");
  });

  it("returns timeout error when fetch aborts", async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException("timeout", "AbortError")
    );

    const result = await runSkillScanner(
      new Map([["SKILL.md", Buffer.from("x")]])
    );

    expect(result.available).toBe(true);
    expect(result.status).toBe("ERROR");
    expect(result.error).toContain("timed out");
  });

  it("returns unreachable error for non-abort exceptions", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("connection reset"));

    const result = await runSkillScanner(
      new Map([["SKILL.md", Buffer.from("x")]])
    );

    expect(result.available).toBe(false);
    expect(result.error).toContain("unreachable");
    expect(result.error).toContain("connection reset");
  });
});
