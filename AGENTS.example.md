<workflow priority="0">
## Pre-Task Skill Discovery

Always search SkillsMP for relevant skills before starting any task.

### Step 1: Search for relevant skills
```
skillsmp_search_skills({ query: "<1-3 keywords>" })
```
Keep queries short: "code review", "web scraper", "PDF", etc.

If no good match, try semantic search:
```
skillsmp_ai_search_skills({ query: "<natural language description>" })
```

### Step 2: Load the best matching skill
If search returns relevant skills (score > 0.7 or stars > 5), read without asking:
```
skillsmp_read_skill({ repo: "<author>/<repo>", skillName: "<skill-name>" })
```

Load 1-3 complementary skills maximum. Skip near-duplicates.

### Step 3: Apply skill instructions
Follow the loaded skill's SKILL.md instructions for the current task.

### Trigger Keywords
- "review" / "audit" → search "code review"
- "build" / "create" / "implement" → search the domain (e.g., "landing page", "API")
- "optimize" / "improve" → search "performance" or the specific tech
- "test" / "debug" → search "testing" or "debugging"
- "security" / "vulnerability" → search "security"
- Framework or library names → search that name

### Example
User: "Review my Python code"
1. `skillsmp_search_skills({ query: "python code review" })`
2. Found: `existential-birds/beagle` → `python-code-review`
3. `skillsmp_read_skill({ repo: "existential-birds/beagle", skillName: "python-code-review" })`
4. Apply the skill's review checklist
</workflow>
