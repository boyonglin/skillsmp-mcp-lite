import { describe, it, expect, vi } from "vitest";
import {
  makeApiRequest,
  handleApiError,
  validateSearchResponse,
  validateAISearchResponse,
} from "../src/api.js";

describe("makeApiRequest", () => {
  it("builds URL with query params and returns parsed json", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const data = await makeApiRequest<{ success: boolean }>(
      "skills/search",
      "api-key",
      { q: "pdf", page: 2 }
    );

    expect(data.success).toBe(true);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("skills/search");
    expect(String(url)).toContain("q=pdf");
    expect(String(url)).toContain("page=2");
    expect(options.headers.Authorization).toBe("Bearer api-key");
  });

  it("throws ApiRequestError with API message when non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: "bad key" } }),
      })
    );

    await expect(makeApiRequest("skills/search", "bad")).rejects.toThrow(
      "bad key"
    );
  });

  it("throws status fallback when error body is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("invalid json");
        },
      })
    );

    await expect(makeApiRequest("skills/search", "x")).rejects.toThrow(
      "API request failed with status 500"
    );
  });
});

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

  it("formats 401 ApiRequestError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: "unauthorized" } }),
      })
    );

    let caught: unknown;
    try {
      await makeApiRequest("skills/search", "bad");
    } catch (error) {
      caught = error;
    }

    const msg = handleApiError(caught);
    expect(msg).toContain("Invalid or missing API key");
  });

  it("formats 429 ApiRequestError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "too many requests" } }),
      })
    );

    let caught: unknown;
    try {
      await makeApiRequest("skills/search", "bad");
    } catch (error) {
      caught = error;
    }

    const msg = handleApiError(caught);
    expect(msg).toContain("Rate limit exceeded");
  });

  it("formats generic ApiRequestError status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: "server fail" } }),
      })
    );

    let caught: unknown;
    try {
      await makeApiRequest("skills/search", "bad");
    } catch (error) {
      caught = error;
    }

    const msg = handleApiError(caught);
    expect(msg).toContain("HTTP 500");
  });

  it("formats generic Error", () => {
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
