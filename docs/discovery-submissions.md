# Discovery submissions (SB-195)

Tracking sheet for getting Phonebook listed outside social feeds.
Update the Status column as each one lands, then mirror the URLs onto SB-188.

| # | Channel | Status | Listing URL | Blocked on |
|---|---------|--------|-------------|------------|
| 1 | MCP official registry | **Live** | https://registry.modelcontextprotocol.io/v0/servers?search=io.github.stag-build/phonebook | — |
| 2 | Glama | Submitted | — | Glama indexing |
| 3 | Smithery | Not submitted | — | smithery.ai account |
| 4 | punkpeye/awesome-mcp-servers | PR open | https://github.com/punkpeye/awesome-mcp-servers/pull/13229 | maintainer review |
| 5 | Changelog News | Drafted in Gmail | — | you to hit send |
| 6 | Console.dev | Not submitted | — | submit link (site blocks bots) |
| 7 | iOS Dev Weekly / Android Weekly | Not submitted | — | web forms, manual |

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

Submit at https://glama.ai/mcp/servers — repo URL only, no copy needed:

```
https://github.com/stag-build/phonebook
```

Glama auto-indexes the tool list and schemas from the MCP server. It also mints a score
badge; once listed, consider adding it to the README.

## 3. Smithery

Dashboard: https://smithery.ai → Deploy Server → connect the GitHub repo. Description:

> Self-hosted Storybook-style preview gallery for SwiftUI and Jetpack Compose. Harvests your
> existing `#Preview`/`@Preview` code into a browsable static site — no SaaS account, no new
> test code. MCP-first: point a coding agent at it and it checks setup, fills preview gaps,
> and builds the gallery for you.

## 4. punkpeye/awesome-mcp-servers

Format check done against their CONTRIBUTING.md and README:

- Category: **💻 Developer Tools** (new entries go at the top of the section).
- Legend symbols: `📇` TypeScript · `🏠` local service · `🍎` macOS · `🪟` Windows · `🐧` Linux.
- Automated-agent PRs opt into fast-track review by appending `🤖🤖🤖` to the PR title.

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

Console.dev blocks automated access (403 to curl and to a headless browser), so the submission
link has to be found by hand from the site footer. Blurb is ready:

> **Phonebook** — Self-hosted, open-source Storybook for native mobile apps. Turns existing
> SwiftUI `#Preview` and Jetpack Compose `@Preview` code into a browsable static gallery.
> No SaaS account, MCP-first (drive it with Claude Code, Codex, or Cursor). MIT licensed.

## 7. Newsletters

- iOS Dev Weekly: https://suggest.iosdevweekly.com (submission form, not email)
- Android Weekly: form on https://androidweekly.net under "Submit stuff" (`#submit-stuff`)

Both are forms rather than cold email, so paste this as the note:

> Hi — submitting Phonebook (https://github.com/stag-build/phonebook) for consideration. It's
> an open-source, self-hosted tool that turns your app's existing `#Preview`/`@Preview` code
> into a Storybook-style component gallery — a free alternative to paid snapshot-SaaS tools,
> and MCP-first so it plugs into Claude Code / Cursor directly. MIT licensed, live demo:
> https://stag-build.github.io/phonebook/
