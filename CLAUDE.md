# @stag/phonebook

Static Storybook-style gallery generated from Compose `@Preview` / SwiftUI `#Preview` screenshots. See PLAN.md for the full plan.

## Model/agent delegation (token budget)

Keep the main (expensive) model for: architecture, manifest schema, tricky parsing (preview scanning, xcresult harvesting), and reviewing subagent output. Delegate the rest:

- `implementer` (sonnet): any module with a clear spec — CLI command boilerplate, site HTML/CSS/JS, MCP tool wiring, sample apps. Write the spec in the prompt (inputs, outputs, file paths, acceptance check), then hand off.
- `build-triage` (haiku): every gradle/xcodebuild/npm/test run whose output might be long. Never read raw build logs in the main context.
- `docs-writer` (sonnet): README, setup guides, CI recipes.
- Built-in `Explore` agent with `model: haiku` for any multi-file search/reconnaissance.

Batch independent delegations in parallel. Do not delegate tasks whose spec would be longer than the implementation.
