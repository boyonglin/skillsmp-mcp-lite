# SkillsMP MCP Server (Lite)

A lightweight MCP server that enables AI assistants to search and read skills from the [SkillsMP](https://skillsmp.com) marketplace.

## Features

- **Keyword Search** — find skills by short keywords (e.g. "PDF", "web scraper")
- **AI Semantic Search** — find skills with natural language, powered by Cloudflare AI
- **Read Skill** — fetch skill content from GitHub via REST API (no `git clone`, no local files)
- **Security Scanning** — automatic [Cisco Skill Scanner](https://github.com/cisco/ai-skill-scanner) analysis via in-memory ZIP upload (zero disk writes)

## Prerequisites

| Requirement | Purpose | Required |
|---|---|---|
| Node.js ≥ 18 | Runtime | Yes |
| [SkillsMP API Key](https://skillsmp.com/docs/api) | Authentication | Yes |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) (provides `uvx`) | Security scanning | No |

> The server will **exit** if `SKILLSMP_API_KEY` is not set.

## Quick Setup

All clients run the same command — only the config file location and JSON key differ.

**Server definition** (shared across all clients):

```json
"skillsmp": {
  "command": "npx",
  "args": ["-y", "skillsmp-mcp-lite"],
  "env": {
    "SKILLSMP_API_KEY": "YOUR_API_KEY"
  }
}
```

### VS Code / GitHub Copilot

Open `Ctrl+Shift+P` → *MCP: Open User Configuration*, then add:

```json
{
  "servers": {
    "skillsmp": { "type": "stdio", "command": "npx", "args": ["-y", "skillsmp-mcp-lite"], "env": { "SKILLSMP_API_KEY": "YOUR_API_KEY" } }
  }
}
```

> VS Code requires the extra `"type": "stdio"` field.

### Cursor / Claude Desktop

| Client | Config file |
|---|---|
| Cursor | `~/.cursor/mcp.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "skillsmp": { "command": "npx", "args": ["-y", "skillsmp-mcp-lite"], "env": { "SKILLSMP_API_KEY": "YOUR_API_KEY" } }
  }
}
```

### Claude Code

```bash
claude mcp add skillsmp -- npx -y skillsmp-mcp-lite --env SKILLSMP_API_KEY=YOUR_API_KEY
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SKILLSMP_API_KEY` | — | **Required.** API key from [skillsmp.com/docs/api](https://skillsmp.com/docs/api) |
| `GITHUB_TOKEN` | — | Optional. Raises GitHub API rate limit from 60 → 5,000 req/hour |
| `SKILL_SCANNER_API_URL` | — | Optional. URL of an external Skill Scanner API server |
| `SKILL_SCANNER_API_PORT` | `8000` | Optional. Port for the auto-managed scanner server |

## Available Tools

### `skillsmp_search_skills`

Search for skills using keywords.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search keywords (max 200 chars) |
| `page` | number | No | Page number (default: 1) |
| `limit` | number | No | Items per page (default: 20, max: 100) |
| `sortBy` | string | No | `"stars"` or `"recent"` |

### `skillsmp_ai_search_skills`

Find skills using natural language descriptions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Natural language description (max 500 chars) |

### `skillsmp_read_skill`

Fetch a skill's content from GitHub and optionally run a security scan.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `repo` | string | Yes | GitHub repository (`owner/repo`) |
| `skillName` | string | Yes | Skill name (max 100 chars, alphanumeric / hyphens / underscores) |
| `enableScan` | boolean | No | Run Cisco Skill Scanner (default: `true`, requires `uv`) |

## Security Scanning

When `skillsmp_read_skill` is called with `enableScan: true` (the default), the server:

1. Fetches skill files from GitHub via REST API
2. Applies **three-layer scan limits** using GitHub tree `size` (before downloading):
   - **Max files**: 200 files per scan
   - **Max single file size**: 500 KB per file
   - **Max total size**: 5 MB across all files
3. Builds an in-memory ZIP archive from accepted files
4. Uploads the ZIP to the Cisco Skill Scanner API (`/scan-upload`) with **URL query parameters**:
   - `use_behavioral=true` (always enabled)
   - `use_llm=true` (only if `SKILL_SCANNER_LLM_API_KEY` is set)
   - `llm_provider=<provider>` (only if `SKILL_SCANNER_LLM_PROVIDER` is set and no model override)
5. Auto-starts a local scanner server via `uvx` if none is running (reused for subsequent scans, shut down on exit)

If files are excluded due to scan limits, a **Scan Note** is included in the results showing how many files and bytes were excluded.

If `uvx` is not installed, scans are skipped with a warning — the server continues to work normally.

### Untrusted Content Notice

All skill content fetched from third-party repositories includes an **Untrusted Content Notice**. The content may be read and displayed, but it **MUST NOT** be automatically executed or followed as instructions without explicit user confirmation. Always review the content and scan results before acting on it.

To manage the scanner server manually:

```bash
# Start it yourself
npm run scanner-api

# Or point to an external instance
SKILL_SCANNER_API_URL=http://your-server:8000
```

## AGENTS.md Integration

Copy the content from [`AGENTS.example.md`](./AGENTS.example.md) into the top of your `AGENTS.md` to enable automatic skill discovery.

**Workflow**: AI receives a task → searches with `skillsmp_search_skills` (short keywords) → falls back to `skillsmp_ai_search_skills` if needed → reads the best match with `skillsmp_read_skill` → follows the skill's instructions.

### Search Tips

- **Keyword search**: 1–3 words — `"code review"`, `"typescript"`, `"pdf"`
- **Semantic search**: full sentence — `"how to build a landing page with React"`

## Usage Examples

Ask your AI assistant:

- "Search for PDF manipulation skills"
- "Find skills for building a web scraper"
- "Read the python-code-review skill from existential-birds/beagle"

## License

MIT
