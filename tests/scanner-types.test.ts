import { describe, it, expect } from "vitest";
import {
  normalizeAnalyzerName,
  uniqueAnalyzers,
  CORE_ANALYZERS,
} from "../src/scanner/types.js";

describe("normalizeAnalyzerName", () => {
  it('normalizes "static" to "static_analyzer"', () => {
    expect(normalizeAnalyzerName("static")).toBe("static_analyzer");
  });

  it('normalizes "behavioral" to "behavioral_analyzer"', () => {
    expect(normalizeAnalyzerName("behavioral")).toBe("behavioral_analyzer");
  });

  it("passes through full canonical names", () => {
    expect(normalizeAnalyzerName("static_analyzer")).toBe("static_analyzer");
    expect(normalizeAnalyzerName("behavioral_analyzer")).toBe(
      "behavioral_analyzer"
    );
  });

  it("is case-insensitive", () => {
    expect(normalizeAnalyzerName("STATIC")).toBe("static_analyzer");
    expect(normalizeAnalyzerName("Behavioral_Analyzer")).toBe(
      "behavioral_analyzer"
    );
  });

  it("trims whitespace", () => {
    expect(normalizeAnalyzerName("  static  ")).toBe("static_analyzer");
  });

  it("returns undefined for unknown names", () => {
    expect(normalizeAnalyzerName("unknown")).toBeUndefined();
    expect(normalizeAnalyzerName("")).toBeUndefined();
  });
});

describe("uniqueAnalyzers", () => {
  it("deduplicates and normalizes analyzer names", () => {
    const result = uniqueAnalyzers([
      "static",
      "static_analyzer",
      "behavioral",
      "behavioral_analyzer",
    ]);
    expect(result).toHaveLength(2);
    expect(result).toContain("static_analyzer");
    expect(result).toContain("behavioral_analyzer");
  });

  it("filters out invalid names", () => {
    const result = uniqueAnalyzers(["static", "unknown", "", "behavioral"]);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for no valid values", () => {
    expect(uniqueAnalyzers(["", "invalid"])).toEqual([]);
  });
});

describe("CORE_ANALYZERS", () => {
  it("contains both analyzer names", () => {
    expect(CORE_ANALYZERS).toContain("static_analyzer");
    expect(CORE_ANALYZERS).toContain("behavioral_analyzer");
    expect(CORE_ANALYZERS).toHaveLength(2);
  });
});
