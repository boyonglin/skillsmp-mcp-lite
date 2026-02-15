import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitHubTree,
  fetchGitHubFileContent,
  fetchGitHubFiles,
} from "../src/github.js";

describe("github api helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.GITHUB_TOKEN;
  });

  it("fetchGitHubTree returns blobs and truncation warning", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tree: [
          { path: "a.txt", type: "blob", sha: "1", size: 12 },
          { path: "folder", type: "tree", sha: "2" },
        ],
        truncated: true,
      }),
    } as Response);

    const result = await fetchGitHubTree("owner/repo");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.path).toBe("a.txt");
    expect(result.error).toContain("truncated");
  });

  it("fetchGitHubTree returns API error body when non-ok", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    } as Response);

    const result = await fetchGitHubTree("owner/repo");

    expect(result.items).toEqual([]);
    expect(result.error).toContain("GitHub API 403");
    expect(result.error).toContain("forbidden");
  });

  it("fetchGitHubTree returns catch error message", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const result = await fetchGitHubTree("owner/repo");

    expect(result.items).toEqual([]);
    expect(result.error).toContain("GitHub API error");
    expect(result.error).toContain("network down");
  });

  it("fetchGitHubFileContent decodes base64 file content", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        encoding: "base64",
        content: Buffer.from("hello").toString("base64"),
      }),
    } as Response);

    const result = await fetchGitHubFileContent("owner/repo", "SKILL.md");

    expect(result.content).toBe("hello");
    expect(result.error).toBeUndefined();
  });

  it("fetchGitHubFileContent returns unexpected encoding error", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ encoding: "utf8", content: "plain" }),
    } as Response);

    const result = await fetchGitHubFileContent("owner/repo", "SKILL.md");

    expect(result.content).toBe("");
    expect(result.error).toContain("Unexpected encoding");
  });

  it("fetchGitHubFileContent returns API error body", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
    } as Response);

    const result = await fetchGitHubFileContent("owner/repo", "missing.md");

    expect(result.content).toBe("");
    expect(result.error).toContain("GitHub API 404");
  });

  it("fetchGitHubFiles fetches multiple files and keeps successful ones", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          encoding: "base64",
          content: Buffer.from("a").toString("base64"),
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response)
      .mockRejectedValueOnce(new Error("socket closed"));

    const files = await fetchGitHubFiles("owner/repo", [
      "a.txt",
      "b.txt",
      "c.txt",
    ]);

    expect(files.size).toBe(1);
    expect(files.get("a.txt")?.toString()).toBe("a");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("github requests include auth header when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "token123";

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tree: [] }),
    } as Response);

    await fetchGitHubTree("owner/repo");

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call).toBeDefined();
    const options = call?.[1] as { headers?: Record<string, string> };
    expect(options.headers?.Authorization).toBe("Bearer token123");
  });
});
