# Contributing to Argus

Thanks for your interest — contributions of every size are welcome, from a typo fix to a whole new detection category.

## Dev setup

```bash
git clone https://github.com/ironclawdevs27/Argus.git
cd Argus
npm install
cp .env.example .env        # fill in TARGET_DEV_URL; everything else is optional
```

## Running the tests

| Command | Needs Chrome? | What it covers |
|---|---|---|
| `npm run test:unit` | No | 495 Vitest unit tests — fast, run these constantly |
| `npm run test:harness` | **Yes** | 168-block / 978-assertion integration harness against real Chrome + 64 fixture pages |
| `npm run test:coverage` | Yes | Merged unit + harness coverage gate |

Start Chrome for the harness with one command:

```bash
npm run chrome -- --headless
```

Then `npm run doctor` verifies your environment (Chrome reachable, `.mcp.json` valid, `.env` keys present) and prints a fix for anything wrong.

## Adding a new detection category

Follow the checklist in [CLAUDE.md](CLAUDE.md) ("Adding a New Detection Phase") and the pattern reference in [SKILL.md](SKILL.md) §9. In short:

1. `src/utils/<name>-analyzer.js` — return a `findings[]` array; self-register via `registerExpensive({ name, analyze })`
2. Import it (side-effect) in `src/orchestration/orchestrator.js`
3. Add a fixture page under `test-harness/pages/` and register it in `test-harness/harness-config.js`
4. Add a harness block to `test-harness/validate.js` (next sequential number, ≥3 hard assertions)
5. Update the stats in `SKILL.md` §14

Two rules that bite newcomers: analyzers talk to the browser **only** through the `CdpBrowserAdapter` (`browser.*`, never `mcp.*` directly), and fixture pages must be served over HTTP (the harness server does this) — never `file://`.

## Good first contributions

- **Fixture pages** — a page that reproduces a real-world bug pattern we don't cover yet
- **Framework route discovery** — `route-discoverer.js` knows Next.js and React Router; Nuxt/SvelteKit/Remix discoverers are welcome
- **Finding-type docs** — clarifying detection methods or severity rationale in [REFERENCE.md](REFERENCE.md)
- **New analyzers** — check the open issues for wanted categories before starting

## Pull request expectations

- `npm run test:unit` and `npm run test:harness` both green (CI enforces the harness gate)
- New detection logic comes with a fixture + harness assertions — the assertion count only goes up
- No new runtime dependencies without discussion in an issue first (the core is deliberately lean)
- Keep findings honest: a check that can false-positive on clean pages needs a negative control

## Questions

Open a GitHub issue — including "is this a bug or expected?" questions. Those often turn into doc fixes that help the next person.

## License

By contributing you agree your work is licensed under the [MIT License](LICENSE).
