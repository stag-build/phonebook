# Discovery submissions (SB-195)

Tracking sheet for getting Phonebook listed outside social feeds.
Update the Status column as each one lands, then mirror the URLs onto SB-188.

| # | Channel | Status | Listing URL | Blocked on |
|---|---------|--------|-------------|------------|
| 1 | MCP official registry | **Live** | https://registry.modelcontextprotocol.io/v0/servers?search=io.github.stag-build/phonebook | — |
| 2 | Glama | **Listed, claimed, checks green** | https://glama.ai/mcp/servers/stag-build/phonebook | — |
| 3 | Smithery | **Ruled out** | — | requires a hosted HTTPS endpoint |
| 4 | punkpeye/awesome-mcp-servers | PR open, badge added | https://github.com/punkpeye/awesome-mcp-servers/pull/13229 | maintainer review |
| 5 | Changelog News | **Sent** 2026-08-30 | — | their call, no reply expected |
| 6 | Console.dev | Drafted in Gmail | — | you to hit send |
| 7 | iOS Dev Weekly / Android Weekly | **Both submitted** 2026-08-31 | — | curators' call |

---

## 1. MCP official registry

Prep already committed in this repo:

- `package.json` has `"mcpName": "io.github.stag-build/phonebook"` and version `0.1.2`.
- `server.json` at repo root describes the stdio server (`npx @stag-build/phonebook mcp`).
- `mcp-publisher validate` against registry.modelcontextprotocol.io passes (description must stay ≤100 chars).

The registry validates ownership by fetching the **published** npm tarball and checking
`mcpName` inside it — so npm must be republished *before* publishing to the registry.

Published 2026-08-30 as `io.github.stag-build/phonebook`, version 0.1.2, status `active`.

Publishing runs from CI: `.github/workflows/publish.yml` authenticates with
`mcp-publisher login github-oidc`, so the registry validates namespace ownership from the
workflow's OIDC token — issued to the repo itself. Every `v*.*.*` tag now pushes npm and the
registry together; the job can also be dispatched manually to sync the registry alone.

Interactive `mcp-publisher login github` was tried first and is **not** the path to use here:
it grants only `io.github.<your-username>/*` unless your `stag-build` membership is public,
and even after publicising it the cached token keeps the old grant. OIDC sidesteps all of it.

## 2. Glama

Already listed — Glama auto-crawled the repo, which is why a manual submission came back as
"MCP server already exists for this repository". That mail is a duplicate notice, not a
rejection: https://glama.ai/mcp/servers/stag-build/phonebook

Claimed 2026-08-31. Claiming a server under an org namespace needs `glama.json` at the repo
root naming the maintainer's *personal* GitHub username — GitHub OAuth has no "sign in as an
org", so that file is the bridge between the personal identity and the org-owned repo. After
committing it the claim took a while to go through; Glama appears to cache the crawl.

**Checks — passing as of 2026-08-31**, release `v0.1.2`. Glama does *not* take an uploaded
Dockerfile: the Admin → Dockerfile tab is a form that **generates** one, and two of its
defaults are wrong for this repo. Both must be corrected or the build test fails (as it did on
2026-08-26):

| Field | Glama default | Correct value |
|---|---|---|
| Build steps | `["pnpm install", "pnpm run build"]` | `["npm ci", "npm run build"]` |
| CMD arguments | `["mcp-proxy", "--", "node", "dist/cli.js"]` | `["mcp-proxy", "--", "node", "dist/cli.js", "mcp"]` |

The CMD is the one that actually breaks it — without the `mcp` subcommand the container runs
the CLI's top-level help and exits, so introspection can never succeed. Glama takes the
release version from `package.json`, so it tracks npm automatically.

Resulting scores: Server Coherence A (5/5 on all four criteria), Maintenance A, Tool Definition
Quality A (3.7/5 average), 83% profile completion. The weakest signal is per-tool *Behavior*
(`run_generate` 2/5) — tool descriptions don't disclose side effects, and no MCP tool
annotations are set. Worth a pass if the score ever matters.

`Dockerfile` at the repo root is kept independently: multi-stage, builds from source rather
than installing the published npm package. Verified locally:

```bash
docker build -t phonebook-mcp-check .
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | docker run -i --rm phonebook-mcp-check
```

Returns the handshake plus all five tools. Note Glama wants the Dockerfile uploaded through
their Admin tab, not just present in the repo.

## 3. Smithery — ruled out

Smithery's "Publish an MCP Server" flow requires an **MCP Server URL**: a live HTTPS endpoint
it can reach. Phonebook has no such endpoint and cannot have one. It is stdio-only
(`StdioServerTransport`, `src/mcp/server.ts`), and its tools shell out to Gradle and
`xcodebuild` against the checkout on the developer's own disk, writing screenshots back into
it. A process running on Smithery's infrastructure would have no repository to operate on.

The same reasoning rules out Glama's connectors directory (https://glama.ai/mcp/connectors),
which is also for hosted endpoints. Glama's main server listing is unaffected — that one
indexes local servers fine.

Revisit only if Phonebook ever grows a remote transport, which would be a different product.

## 4. punkpeye/awesome-mcp-servers

Format check done against their CONTRIBUTING.md and README:

- Category: **💻 Developer Tools** (new entries go at the top of the section).
- Legend symbols: `📇` TypeScript · `🏠` local service · `🍎` macOS · `🪟` Windows · `🐧` Linux.
- Automated-agent PRs opt into fast-track review by appending `🤖🤖🤖` to the PR title.

Maintainers now also require a Glama score badge on each entry (added 2026-08-30), placed
right after the repo link — which is where the surrounding entries put it, despite their
message saying "after the description".

Line to add:

```markdown
- [stag-build/phonebook](https://github.com/stag-build/phonebook) 📇 🏠 🍎 🪟 🐧 - Turns the `#Preview` / `@Preview` code already in a SwiftUI or Jetpack Compose app into a browsable Storybook-style gallery, entirely self-hosted. Five tools (`check_setup`, `analyze_coverage`, `get_preview_guidance`, `run_generate`, `run_build`) let an agent verify the toolchain, find screens missing previews, write the missing ones, render screenshots and build the static site. No SaaS account or API key. `npx -y @stag-build/phonebook mcp`
```

## 5. Changelog News — editors@changelog.com

> **Subject:** Self-hosted, open-source alternative to preview-snapshot SaaS tools
>
> Hi Changelog team — wanted to flag an open-source project that might fit Changelog News:
> Phonebook (https://github.com/stag-build/phonebook), a self-hosted Storybook-style preview
> gallery for SwiftUI and Jetpack Compose.
>
> The pitch: mobile teams already write `#Preview`/`@Preview` code, but there's no free way to
> turn that into a shareable gallery a designer or PM can browse without installing anything —
> most tools in this space are paid SaaS. Phonebook runs entirely in CI or locally (MIT), and
> it's MCP-first, so a coding agent can wire it up end to end.
>
> Live demo: https://stag-build.github.io/phonebook/
>
> Happy to answer questions if useful.

## 6. Console.dev

**There is no submission form.** The site has exactly one relevant link — a `mailto:` to
hello@console.dev labelled "Contact". The `/about/#submit-a-tool` URL in the original plan is a
404, and console.dev 403s curl (a real browser gets through). Email is the only route. Blurb:

> **Phonebook** — Self-hosted, open-source Storybook for native mobile apps. Turns existing
> SwiftUI `#Preview` and Jetpack Compose `@Preview` code into a browsable static gallery.
> No SaaS account, MCP-first (drive it with Claude Code, Codex, or Cursor). MIT licensed.

## 7. Newsletters

- iOS Dev Weekly: https://suggest.iosdevweekly.com (submission form, not email)
- Android Weekly: form on https://androidweekly.net under "Submit stuff" (`#submit-stuff`)

Both submitted 2026-08-31. **Submit the Medium article, not the repo** — iOS Dev Weekly's form
asks "Is this a link to a blog post?" and Dave notes he already reads every site in the iOS Dev
Directory via RSS, so a bare repo link is the weakest thing to send. The canonical write-up:

https://medium.com/@orelzion/phonebook-a-storybook-style-preview-gallery-for-swiftui-and-compose-built-for-agents-e3e3f7c0a59a

Note the Swift-library question counts a blog post *about* a Swift library as a yes.

Blurb used:

> Hi — submitting Phonebook (https://github.com/stag-build/phonebook) for consideration. It's
> an open-source, self-hosted tool that turns your app's existing `#Preview`/`@Preview` code
> into a Storybook-style component gallery — a free alternative to paid snapshot-SaaS tools,
> and MCP-first so it plugs into Claude Code / Cursor directly. MIT licensed, live demo:
> https://stag-build.github.io/phonebook/
