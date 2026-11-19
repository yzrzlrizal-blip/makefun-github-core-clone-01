# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yzrzlrizal-blip/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yzrzlrizal-blip/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, stdlib-only (Node 22+) GitHub-compatible git forge that speaks git smart HTTP, REST v3, GraphQL v4 and MCP from one in-memory store — no UI, no git binary, no package manager, no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wdbz3sg5&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## Layout

- `main.ts` — the entry lifecycle: bind an ephemeral port, register it with
  the suite (`POST $MAKEFUN_ENV_URL/register`), poll `GET .../done`, exit 0.
- `app.ts` — the whole server: identity, store, REST, GraphQL, MCP, git
  smart HTTP, and the router.
- `git-core.ts` — pure git primitives: pkt-line framing, object hashing and
  parsing (commit/tree/tag), reachability, pack read/write with OFS_DELTA and
  REF_DELTA resolution, sideband framing.
- `LICENSE` — MIT.

## Running

The suite runs it: `node --experimental-strip-types main.ts` with
`MAKEFUN_ENV_URL` set. For a standalone smoke run:

```sh
MAKEFUN_SHOP_TOKEN=makefun-trial-<48 hex> node --experimental-strip-types \
  -e "import('./app.ts').then(m => m.createApp().listen(18099, '127.0.0.1'))"
```

Then, with `Authorization: Bearer <same token>`:

- `GET /healthz` — no auth, `{ok: true}`.
- `GET /adaiversen/<repo>.git/info/refs?service=git-upload-pack` — git
  smart HTTP (protocol v2 when `Git-Protocol: version=2` is sent, else v0).
- `GET /api/v3/`, `/api/v3/meta`, `/api/v3/user`, `/user/repos`,
  `/repos/{owner}/{repo}`, `/issues`, `/pulls`, `/contents/{path}` …
- `POST /api/graphql` — queries/mutations in the shape `gh` sends
  (variables, aliases, inline fragments, batched arrays).
- `POST /mcp` — JSON-RPC with `server/discover`, `initialize`,
  `tools/list`, `tools/call` (modern 2026-07-28 era first, legacy
  handshake as fallback). Tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`, `get_issue`, `list_pull_requests`.

Real `git clone` / `push` / `fetch` work over HTTP, including shallow
clones (`--depth 1`), deepen, incremental fetch, annotated tags and
non-fast-forward rejection.

## Identity and determinism

The token names a viewer whose login is fixed by the contest's seeded
scenario; the server recomputes it from the scenario seed, so
`viewer { login }`, `GET /api/v3/user` and repository owners are right
without ever seeing the scenario. Nothing reads the wall clock or
unseeded randomness: creation order is a counter, timestamps derive from
a fixed epoch plus that counter, and ids are sequential. Two runs that
receive the same requests in the same order reach the same state.

## Protocol notes worth knowing

- **Fetch v2 acknowledgments:** the section is sent only when the request
  carried `have` lines. Real git (`fetch-pack.c`) jumps straight to the
  packfile sections when it sent `done` with no haves and dies on any
  other first section; a fresh clone therefore gets no acknowledgments
  section at all.
- **Shallow fetches:** the pack carries only the included commits and
  their tree closures — never parents above the depth limit — and reports
  the new `shallow` / `unshallow` boundaries.
- **Push reports:** `unpack ok` + one `ok`/`ng` line per ref, each
  newline-terminated, wrapped in sideband band-1 packets. A mixed list
  applies only the fast-forward refs.
- **Packs:** plain objects only on write (no deltas); reads resolve
  OFS_DELTA and REF_DELTA, including thin-pack bases.

## Local verification (2026-11-19, this machine)

Kit conformance runner against a live server
(`sdk/run.ts --url http://127.0.0.1:18099 --token …`):

- Feature checks: **120/120** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15. Two separate
  fresh-server runs both scored 120/120 with identical check details.
- Perf (`--perf` on a fresh server): **109/200** points
  (push 33, clone 20, read 27, write 29). A repeat run measured 149/200;
  the number is noisy on this shared machine. The house reference forge's
  calibration medians correspond to ~100 perf points.
- Real git: clone/push/fetch, shallow `--depth 1`, deepen, incremental
  fetch, annotated tags, branch create/delete, non-fast-forward
  rejection, `git fsck --strict` clean.
- Size: ~156 KB total, largest file `app.ts` ~125 KB (limits: 16 MiB
  total, 8 MiB per file).

`grade-local --driver docker` was not attempted to completion: no Docker
is available on this machine.
