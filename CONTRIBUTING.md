# Contributing

Thanks for taking an interest. This is a small project and the process is
informal — open an issue or a PR.

## Getting set up

```bash
git clone https://github.com/3am-engineer/blueprint.git
cd blueprint
npm install
node bin/blueprint.js fetch-icons     # one time, ~14 MB from AWS
npm test
npm run demo                          # offline render of examples/sample-scan.json
```

`npm run demo` is the fastest feedback loop — it renders a bundled sample scan
without touching AWS, so you can hack on the graph/render code offline.

## Where things live

- `bin/blueprint.js` — CLI entry: flags → pipeline, no args → TUI
- `src/tui.js` — the interactive wizard
- `src/pipeline.js` — scan → graph → render, shared by CLI and TUI
- `src/scan.js` — AWS discovery and enrichment (the bulk of the logic)
- `src/graph.js` — containers, nodes, inferred edges
- `src/render.js` — elkjs layout → SVG → self-contained HTML portal
- `src/server.js` — the self-hosted web UI

## Adding support for a service

Most contributions boil down to one of these:

1. **A service renders with the generic tile** — add an entry to `ICON_MAP`
   in `src/icons.js`.
2. **A relationship isn't drawn** — add enrichment in `src/scan.js` and push
   an edge (`scan.edges.push({from, to, label, kind})`).
3. **A resource lands in the wrong container** — look at `isRegionalService()`
   and the container logic in `src/graph.js`.

Please keep PRs focused and include a test where it makes sense — the existing
tests in `test/` show the pattern (plain `node --test`, no framework).

## Credentials

Never commit scan output from a real account. `out/` is gitignored for this
reason; the bundled examples use the documentation account id `123456789012`.
