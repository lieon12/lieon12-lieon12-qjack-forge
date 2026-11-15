# qjack-forge — a GitHub-compatible git forge

An entry for make.fun `github-core-clone-01`: a single-process Node 22
server (standard library only, no git binary, no dependencies) that speaks
git smart HTTP, REST v3, GraphQL v4 and MCP against one deterministic
in-memory store.

## Run

```sh
node main.ts            # needs MAKEFUN_ENV_URL; binds an ephemeral port,
                        # registers it, polls /done, exits 0
```

`MAKEFUN_SHOP_TOKEN` is the bearer token the REST/GraphQL/MCP surfaces
accept. When it is unset, any non-empty bearer token is accepted (the dev
fallback the kit's clients rely on). The git smart-HTTP endpoints need no
auth, exactly like the kit's client expects.

## Layout

- `main.ts` — the lifecycle (bind, register, poll /done, exit 0), kept as
  the kit's starter ships it.
- `lib/app.ts` — the HTTP server: routing, auth, JSON parsing,
  `X-GitHub-Request-Id` on every reply.
- `lib/store.ts` — the deterministic in-memory store (repos, refs, issues,
  PRs, labels, comments, contents). No wall clock, no randomness: ids,
  timestamps and orderings come from counters or fixed constants, so a
  replayed trial leaves the identical state export byte for byte.
- `lib/git.ts` — git core: SHA-1, object read/write, packfile read
  (OFS_DELTA + REF_DELTA) and write (plain objects, deterministic order,
  per-object deflate cache), fetch planning (depth, shallow boundaries,
  haves, unshallow).
- `lib/pkt.ts` — pkt-line framing and sideband chunking.
- `lib/smart.ts` — smart HTTP: `info/refs`, upload-pack v2 (ls-refs,
  fetch) and v0, receive-pack v0 (report-status, fast-forward, the exact
  `non-fast-forward` ng reason).
- `lib/rest.ts` — REST v3: repos, branches, commits, contents, labels,
  issues, comments, pulls, merges, pagination with `Link` headers.
- `lib/graphql.ts` — GraphQL v4: viewer, repository, issues/pullRequests
  connections with cursor pagination, `__type` introspection, node(),
  batched documents, the five mutations.
- `lib/mcp.ts` — MCP (modern era `2026-07-28`): `server/discover`,
  `tools/list` (one constant array, byte-identical every call),
  `tools/call` for the six required tools on the same store as REST.
- `lib/merge.ts` — the pull-request logic shared by REST, GraphQL and MCP:
  merge-base, mergeability, squash merge, changed-files diff.

## Design notes

- The viewer login is learned only from a request for a repo that
  exists. The suite probes missing repos under arbitrary owners; learning
  from a 404 probe would poison the login and break every later read.
- Fetch packs are cached per (wants, haves, shallow, depth): the 50
  concurrent shallow clones of the benchmark all fetch the same tip, so
  49 of them reuse the first pack.
- A refused ref update still unpacks its objects but never moves the ref.
- Commit timestamps for the forge's own commits (contents, merges) come
  from `MAKEFUN_TRIAL_NOW` when the env sets it, else a fixed constant.

## Local grade (grade-local, --driver process, 3 practice trials)

| trial | feature | agent | perf | score | replay |
|-------|---------|-------|------|-------|--------|
| 0 | 600 | 200 | 154 | 954 | matched |
| 1 | 600 | 200 | 148 | 948 | matched |
| 2 | 600 | 200 | 152 | 952 | matched |
| **mean** | **600** | **200** | **151.3** | **951.3** | **matched** |

120/120 conformance on every trial; 90% interval of the score
946.2–956.5. The state export is byte-identical across all three trials
(and identical to the reference forge's export). Per-workload p50s
(mean of the three trials): push ~729 ms, clone ~166 ms, read
~1310 ms, write ~152 ms — roughly 2x the reference forge on the
same machine, except clone at ~1.6x.

Caveats, stated honestly: this is a local grade on a quiet VM with
Node v24.22.1; the grader runs Node 22.23.4 in a sandbox on a loaded
shared cluster, where every entry measures slower. The score above is
a practice-trial grade, not a final result, and it carries no
transcripts (the bundle for a real submission is made separately).
