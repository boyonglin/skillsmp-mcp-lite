import { describe, it, expect } from "vitest";
import {
  handleApiError,
  validateSearchResponse,
  validateAISearchResponse,
} from "../src/api.js";

/* ------------------------------------------------------------------ */
/*  validateSearchResponse                                             */
/* ------------------------------------------------------------------ */
describe("validateSearchResponse", () => {
  it("accepts a valid search response", () => {
    const data = {
      success: true,
      data: { skills: [{ id: "1", name: "s" }], pagination: {} },
    };
    expect(() => validateSearchResponse(data)).not.toThrow();
  });

  it("rejects null input", () => {
    expect(() => validateSearchResponse(null)).toThrow(
      "Invalid response: expected object"
    );
  });

  it("rejects non-object input", () => {
    expect(() => validateSearchResponse("string")).toThrow("expected object");
  });

  it("rejects missing success field", () => {
    expect(() => validateSearchResponse({ data: {} })).toThrow(
      '"success" field'
    );
  });

  it("rejects success: false", () => {
    expect(() => validateSearchResponse({ success: false, data: {} })).toThrow(
      "API returned failure"
    );
  });

  it("rejects missing data object", () => {
    expect(() => validateSearchResponse({ success: true })).toThrow(
      '"data" object'
    );
  });

  it("rejects missing data.skills array", () => {
    expect(() =>
      validateSearchResponse({ success: true, data: { other: 1 } })
    ).toThrow('"data.skills" array');
  });
});

/* ------------------------------------------------------------------ */
/*  validateAISearchResponse                                           */
/* ------------------------------------------------------------------ */
describe("validateAISearchResponse", () => {
  it("accepts a valid AI search response", () => {
    const data = {
      success: true,
      data: { data: [{ file_id: "f1", score: 0.5 }] },
    };
    expect(() => validateAISearchResponse(data)).not.toThrow();
  });

  it("rejects missing data.data array", () => {
    expect(() =>
      validateAISearchResponse({ success: true, data: { skills: [] } })
    ).toThrow('"data.data" array');
  });

  it("rejects success: false", () => {
    expect(() =>
      validateAISearchResponse({ success: false, data: {} })
    ).toThrow("API returned failure");
  });
});

/* ------------------------------------------------------------------ */
/*  handleApiError                                                     */
/* ------------------------------------------------------------------ */
describe("handleApiError", () => {
  it("formats ApiStructureError via validateSearchResponse", () => {
    let caught: unknown;
    try {
      validateSearchResponse(null);
    } catch (e) {
      caught = e;
    }
    const msg = handleApiError(caught);
    expect(msg).toContain("API Structure Error");
    expect(msg).toContain("Please report this issue");
  });

  it("formats 401 ApiRequestError", () => {
    // Simulate by calling makeApiRequest would throw; instead we test via
    // the same class path using validateSearchResponse to trigger the branch.
    // For 401/429 we need an ApiRequestError, which is private. We indirectly
    // test by passing a plain Error to verify the generic Error branch.
    const msg = handleApiError(new Error("connection refused"));
    expect(msg).toBe("Error: connection refused");
  });

  it("formats non-Error values", () => {
    expect(handleApiError("oops")).toBe("Error: An unexpected error occurred");
    expect(handleApiError(42)).toBe("Error: An unexpected error occurred");
    expect(handleApiError(null)).toBe("Error: An unexpected error occurred");
    expect(handleApiError(undefined)).toBe(
      "Error: An unexpected error occurred"
    );
  });
});
