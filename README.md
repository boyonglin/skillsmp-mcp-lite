# SkillsMP MCP Server (Lite)

A lightweight MCP server that enables AI assistants to search for skills from [SkillsMP](https://skillsmp.com) marketplace before starting any task.

## Features

- **Keyword Search**: Search skills using specific keywords like "PDF", "web scraper", "SEO"
- **AI Semantic Search**: Find skills using natural language descriptions powered by Cloudflare AI

## Quick Setup

### VS Code / GitHub Copilot

Add to your VS Code `mcp.json` (open with: `Ctrl+Shift+P` → "MCP: Open User Configuration"):

```json
{
  "servers": {
    "skillsmp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "skillsmp-mcp-lite"],
      "env": {
        "SKILLSMP_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "skillsmp": {
      "command": "npx",
      "args": ["-y", "skillsmp-mcp-lite"],
      "env": {
        "SKILLSMP_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "skillsmp": {
      "command": "npx",
      "args": ["-y", "skillsmp-mcp-lite"],
      "env": {
        "SKILLSMP_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add skillsmp -- npx -y skillsmp-mcp-lite --env SKILLSMP_API_KEY=YOUR_API_KEY
```

## Get Your API Key

Get your API key from: https://skillsmp.com/docs/api

> **Note**: The API key is required. The server will exit if `SKILLSMP_API_KEY` is not set.

### Skill Scanner

Security scanning is available when the required tooling is installed — no extra configuration is needed. When `skillsmp_read_skill` is called with `enableScan: true`, the server will:

1. **Auto-start** a local `skill-scanner-api` server via `uvx` on a configurable port (default 8000)
2. **Reuse** that server for all subsequent scans (no cold-start overhead)
3. **Shut down** the server automatically when the MCP server exits

**Prerequisite**: [uv](https://docs.astral.sh/uv/getting-started/installation/) must be installed (provides `uvx`). If `uvx` is not found, scan requests are skipped and the server continues to function normally — you may see a non-fatal warning. Scanning is enabled by default (`enableScan` defaults to `true`).

You can also manage the server manually if preferred:

```bash
# Start the scanner API server yourself
npm run scanner-api

# Or point to an external server
SKILL_SCANNER_API_URL=http://your-server:8000
```

## Available Tools

### `skillsmp_search_skills`

Search for skills using keywords.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keywords |
| `page` | number | No | Page number (default: 1) |
| `limit` | number | No | Items per page (default: 20, max: 100) |
| `sortBy` | string | No | Sort by "stars" or "recent" |

### `skillsmp_ai_search_skills`

AI semantic search for skills using natural language.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural language description |

### `skillsmp_read_skill`

Read a skill's content directly from a GitHub repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo` | string | Yes | GitHub repository in 'owner/repo' format |
| `skillName` | string | Yes | Name of the skill to read |
| `enableScan` | boolean | No | Run Cisco Skill Scanner security scan (default: true, requires uv) |

## Usage Examples

Ask your AI assistant:

- "Search for PDF manipulation skills"
- "Find skills for building a web scraper"
- "What skills can help me with SEO optimization?"
- "Read the python-code-review skill from existential-birds/beagle"

## AGENTS.md Integration

To enable automatic skill discovery, copy the content from [`AGENTS.example.md`](./AGENTS.example.md) and paste it at the top of your `AGENTS.md` file.

### How It Works

1. AI receives a complex task
2. AI searches SkillsMP for relevant skills using `skillsmp_search_skills`
3. If keyword search is insufficient, AI tries `skillsmp_ai_search_skills`
4. If a relevant skill is found, AI reads it with `skillsmp_read_skill`
5. AI follows the skill's instructions to complete the task

### Search Tips

- **Keyword search**: Keep queries short (1-3 words). Example: `"code review"`, `"typescript"`, `"pdf"`
- **Semantic search**: Use natural language. Example: `"how to build a landing page with React"`

## License

MIT
