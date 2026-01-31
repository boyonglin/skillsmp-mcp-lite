#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "module";
import { registerSkillsTools } from "./tools/skills.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

/**
 * SkillsMP MCP Server
 *
 * This server provides tools to search for AI skills from SkillsMP marketplace
 * before starting any task. It supports both keyword search and AI semantic search.
 *
 * Environment Variables:
 *   SKILLSMP_API_KEY - Your SkillsMP API key (required)
 */

const API_KEY = process.env.SKILLSMP_API_KEY;

if (!API_KEY) {
  console.error("Error: SKILLSMP_API_KEY environment variable is required");
  console.error("Get your API key from: https://skillsmp.com/docs/api");
  process.exit(1);
}

// Initialize MCP Server
const server = new McpServer({
  name: "skillsmp-mcp-server",
  version: version as string,
});

// Register skills search tools
registerSkillsTools(server, API_KEY);

// Start server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("SkillsMP MCP Server started");
  console.error("Available tools:");
  console.error("  - skillsmp_search_skills: Keyword search for skills");
  console.error("  - skillsmp_ai_search_skills: AI semantic search for skills");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
