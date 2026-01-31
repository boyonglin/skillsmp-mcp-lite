# SkillsMP MCP Server (Lite)

A lightweight MCP server that enables AI assistants to search for skills from [SkillsMP](https://skillsmp.com) marketplace before starting any task.

## Features

- **Keyword Search**: Search skills using specific keywords like "PDF", "web scraper", "SEO"
- **AI Semantic Search**: Find skills using natural language descriptions powered by Cloudflare AI

## Quick Setup

No installation required! Just add the config to your AI client.

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

> **Note**: The API key is optional. Without it, you may encounter rate limits.

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

### `skillsmp_install_and_read_skill`

Install a skill from GitHub and immediately read its content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo` | string | Yes | GitHub repository in 'owner/repo' format |
| `skillName` | string | Yes | Name of the skill to read after installation |
| `global` | boolean | No | Install globally to ~/.claude/skills/ (default: false) |
| `universal` | boolean | No | Install to .agent/skills/ for universal usage (default: false) |

## Usage Examples

Ask your AI assistant:

- "Search for PDF manipulation skills"
- "Find skills for building a web scraper"
- "What skills can help me with SEO optimization?"
- "Install and load the python-code-review skill from existential-birds/beagle"

## AGENTS.md Integration

To enable automatic skill discovery, copy the content from [`AGENTS.example.md`](./AGENTS.example.md) and paste it at the top of your `AGENTS.md` file.

### How It Works

1. AI receives a complex task
2. AI searches SkillsMP for relevant skills using `skillsmp_search_skills`
3. If keyword search is insufficient, AI tries `skillsmp_ai_search_skills`
4. If a relevant skill is found, AI installs and reads it with `skillsmp_install_and_read_skill`
5. AI follows the skill's instructions to complete the task

### Search Tips

- **Keyword search**: Keep queries short (1-3 words). Example: `"code review"`, `"typescript"`, `"pdf"`
- **Semantic search**: Use natural language. Example: `"how to build a landing page with React"`

## License

MIT
