import { getErrorMessage } from "./utils.js";

const GITHUB_API_TIMEOUT_MS = 30_000;
const FILE_FETCH_CONCURRENCY = 10;

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "skillsmp-mcp-lite",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

interface GitHubTreeItem {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

/**
 * Fetch the file tree of a GitHub repo's default branch via the API.
 * Returns an array of blob entries (files only).
 */
export async function fetchGitHubTree(
  repo: string
): Promise<{ items: GitHubTreeItem[]; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
      { headers: githubHeaders(), signal: controller.signal }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { items: [], error: `GitHub API ${res.status}: ${body}` };
    }
    const json = (await res.json()) as {
      tree: GitHubTreeItem[];
      truncated?: boolean;
    };
    const blobs = json.tree.filter((e) => e.type === "blob");
    if (json.truncated) {
      return {
        items: blobs,
        error:
          "GitHub API tree response was truncated; results may be incomplete.",
      };
    }
    return { items: blobs };
  } catch (error) {
    return {
      items: [],
      error: `GitHub API error: ${getErrorMessage(error)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read a single file from a GitHub repo via the Contents API (base64).
 */
export async function fetchGitHubFileContent(
  repo: string,
  path: string
): Promise<{ content: string; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`,
      { headers: githubHeaders(), signal: controller.signal }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { content: "", error: `GitHub API ${res.status}: ${body}` };
    }
    const json = (await res.json()) as {
      content?: string;
      encoding?: string;
    };
    if (json.encoding === "base64" && json.content) {
      return {
        content: Buffer.from(json.content, "base64").toString("utf-8"),
      };
    }
    return { content: "", error: "Unexpected encoding or empty content" };
  } catch (error) {
    return {
      content: "",
      error: `GitHub API error: ${getErrorMessage(error)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch multiple files from a GitHub repo in parallel and return their raw
 * bytes keyed by relative path.
 */
export async function fetchGitHubFiles(
  repo: string,
  paths: string[]
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();

  for (let i = 0; i < paths.length; i += FILE_FETCH_CONCURRENCY) {
    const batch = paths.slice(i, i + FILE_FETCH_CONCURRENCY);
    await Promise.all(
      batch.map(async (p) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          GITHUB_API_TIMEOUT_MS
        );
        try {
          const res = await fetch(
            `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(p)}`,
            { headers: githubHeaders(), signal: controller.signal }
          );
          if (res.ok) {
            const json = (await res.json()) as {
              content?: string;
              encoding?: string;
            };
            if (json.encoding === "base64" && json.content) {
              result.set(p, Buffer.from(json.content, "base64"));
            }
          } else {
            console.warn(
              `GitHub contents API returned ${res.status} for "${p}"`
            );
          }
        } catch (err) {
          console.warn(`Failed to fetch "${p}": ${getErrorMessage(err)}`);
        } finally {
          clearTimeout(timeoutId);
        }
      })
    );
  }

  return result;
}
