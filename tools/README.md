# Refresh tooling

The dashboard's numbers only move when someone runs a refresh by hand, because the
GitHub Action has no Snowflake credential (see "The real fix" below). These tools make
that hand refresh fast and hard to get wrong.

## Running a refresh

```
gh repo clone BuildHero/tt2-dashboard
cd tt2-dashboard
node tools/fixture-sql.js           # writes tools/out/refresh-N.sql  (3 chunks today)
```

Run each `refresh-N.sql` through the Snowflake MCP. Each returns one row per dataset:
`ds, n, md5, rows_json`. Collect **every** row from **every** chunk into `fx/raw.json`
as `[[ds, n, md5, rows_json], …]`, then:

```
node tools/apply-fixtures.js        # verifies each blob, writes fixtures.json
node scripts/enrich.js --offline fixtures.json
node tools/check.js                 # must pass before publishing
```

Then publish `index.html` (and any changed script) to **both** repos — see "Publishing".

## Why it is shaped this way

**JSON blobs, not rows.** Results reach disk by passing through an agent's context.
That transcription is the slowest step and the only one that can silently corrupt
data. A blob is copied verbatim rather than reformatted, and `apply-fixtures.js`
verifies the MD5 of the raw string *before* parsing — so a single altered digit or a
dropped row fails loudly instead of quietly publishing a wrong number.

**Full tenant ids, never 8-char prefixes.** Compacting ids to 8 chars makes the SQL
~3x smaller, but then some datasets come back prefix-keyed and some do not, and the
expansion step has to know which. That asymmetry caused two separate bugs on
2026-09-22. Chunking by size is the safer trade.

**`ARRAY_CONSTRUCT(*)`** keeps the wrapper generic — adding a query to `enrich.js`
needs no change here. Note Snowflake renders SQL NULL inside an array as the bare
token `undefined`, which is not valid JSON; `lib.js` fixes that up on parse.

**Don't `cat` the generated SQL.** It is ~20KB per chunk. Read it only as part of
composing the query call, or it costs double.

## Publishing

Publish with the **Contents API**, never `git push` — the SOC 2 org ruleset blocks
pushes to `BuildHero/main`, though Matthew is exempt via the API.

```
base64 -i index.html -o /tmp/raw.b64
python3 -c "open('/tmp/f.b64','w').write(open('/tmp/raw.b64').read().replace('\n',''))"
gh api repos/<owner>/tt2-dashboard/contents/index.html -X PUT \
  -f message="..." -F content=@/tmp/f.b64 \
  -f sha=$(gh api repos/<owner>/tt2-dashboard/contents/index.html --jq .sha) -f branch=main
```

**Fetch the sha per repo, immediately before that repo's PUT.** The mirror runs its
own Action daily, so the two repos drift within hours. A `409 does not match` on the
mirror means it has data BuildHero lacks — re-apply your change on top of the mirror's
current file and publish that to both. Never force.

## Keeping the plan in step with Confluence

The **Confluence migration plan is the source of truth** for the schedule
(`BPD/4851826814`). The `PLAN`, `PLAN_GROUPS`, `PLAN_TOTAL` and `PLAN_AS_OF`
constants in `index.html` are a hand import of its tranche table — the enrichment
job has no way to regenerate them, so they go stale silently the moment the plan
is re-cut.

`check-plan.js` closes that loop. It fetches the page, re-parses the tranche
table, and diffs it against the imported block — week dates, cutover dates, group
labels, per-week counts, the cumulative column, and `PLAN_TOTAL` against the final
cumulative. Any mismatch exits non-zero and names the week.

```
CONFLUENCE_USERNAME=... CONFLUENCE_API_TOKEN=... node tools/check-plan.js
```

Run it after any plan revision and before publishing. It reads credentials from
the environment only, which is also why it **cannot run in the nightly Action** —
that workflow holds `LD_API_TOKEN` and nothing else. Until a Confluence token is
added as a repo secret, this is a deliberate manual gate, not an automated one.

Two conventions worth keeping. `cum` is the plan's own cumulative column, copied
as published rather than recomputed here, so a transcription error surfaces as a
mismatch instead of being smoothed over. And `PLAN` starts at the first *scheduled*
tranche — the already-live cohort is Tranche 0 in the doc and is handled by the
baseline logic in `planSummary()`, not by a row in this array.

## The real fix

`enrich.js` already has working key-pair JWT auth against the Snowflake SQL API. It
has never been switched on because the repos hold only `LD_API_TOKEN`. Add
`SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER` and `SNOWFLAKE_PRIVATE_KEY` as repo secrets and
the nightly Action does all of the above unattended — these tools become a debugging
aid rather than the main path.

## Files

| | |
| --- | --- |
| `lib.js` | Loads `enrich.js` as a module so the tools never duplicate its SQL or merge logic |
| `fixture-sql.js` | Emits the refresh queries, split into size-bounded chunks |
| `apply-fixtures.js` | Verifies each blob's MD5 and row count, writes `fixtures.json` |
| `check.js` | Charts draw, tab routing works, no private fields, ids intact, Next Up disjoint from 2.0 |
| `check-plan.js` | Diffs the imported `PLAN` block against the Confluence migration plan |
