#!/usr/bin/env node
'use strict';
// Emit the refresh queries, split into as few chunks as will fit one call each.
//
//   node tools/fixture-sql.js          # writes tools/out/refresh-N.sql
//
// Each chunk returns, per dataset: the name, a row count, the rows as ONE JSON blob,
// and an MD5 of that exact blob. Run each chunk, collect all the rows into
// fx/raw.json, then `node tools/apply-fixtures.js`.
//
// Why JSON blobs rather than rows: the results have to pass through an agent's
// context to reach disk, and that transcription is both the slowest step and the only
// one that can silently corrupt data. An opaque blob gets copied verbatim instead of
// reformatted, and hashing the raw string proves the copy was exact before anything
// parses it.
//
// Why NOT prefix-compacted: shortening tenant ids to 8 chars makes the SQL ~3x
// smaller, but then some datasets come back prefix-keyed and some do not, and the
// expansion step has to know which. That asymmetry produced two separate bugs on
// 2026-09-22. Splitting by size instead keeps every id full-length end to end.
//
// ARRAY_CONSTRUCT(*) keeps this generic: no per-dataset column lists, so a new query
// in enrich.js needs no change here.
const fs = require('fs');
const path = require('path');
const { ROOT, model } = require('./lib');

// Comfortably inside one tool call, with room for the response.
const MAX_CHARS = 24000;

const { lib, model: m } = model();
const queries = lib.buildQueries(m);

const branch = (name, sql) => {
  const q = sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  const agg = "TO_JSON(ARRAY_AGG(ARRAY_CONSTRUCT(*)) WITHIN GROUP (ORDER BY TO_JSON(ARRAY_CONSTRUCT(*))))";
  return `SELECT '${name}' AS ds, COUNT(*) AS n, MD5(NVL(${agg},'[]')) AS md5, NVL(${agg},'[]') AS rows_json FROM (${q})`;
};

const branches = Object.entries(queries)
  .filter(([, sql]) => sql)
  .map(([name, sql]) => ({ name, sql: branch(name, sql) }));

// Greedy pack: keep adding branches to a chunk until the next one would overflow.
const chunks = [];
let cur = [];
let len = 0;
for (const b of branches) {
  const add = b.sql.length + 12; // + "\nUNION ALL\n"
  if (cur.length && len + add > MAX_CHARS) { chunks.push(cur); cur = []; len = 0; }
  cur.push(b); len += add;
}
if (cur.length) chunks.push(cur);

const outDir = path.join(ROOT, 'tools', 'out');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

chunks.forEach((c, i) => {
  const sql = c.map(b => b.sql).join('\nUNION ALL\n') + '\nORDER BY 1';
  const f = path.join(outDir, `refresh-${i + 1}.sql`);
  fs.writeFileSync(f, sql + '\n');
  console.log(`refresh-${i + 1}.sql  ${String(sql.length).padStart(6)} chars  ${c.map(b => b.name).join(', ')}`);
});
console.log(`\n${branches.length} datasets in ${chunks.length} chunk(s). Run each, then put all rows in fx/raw.json.`);
