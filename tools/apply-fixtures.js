#!/usr/bin/env node
'use strict';
// Turn fx/raw.json (the pasted result of tools/fixture-sql.js) into fixtures.json,
// refusing to proceed if any blob was corrupted in transit.
//
//   node tools/apply-fixtures.js
//   node scripts/enrich.js --offline fixtures.json
//
// fx/raw.json is [[ds, n, md5, rows_json], …] exactly as Snowflake returned it. The
// MD5 is of the raw rows_json STRING, so verifying it here proves the transcription
// was byte-exact before a single value is parsed or trusted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, FX, snowflakeJsonToJson } = require('./lib');

const raw = JSON.parse(fs.readFileSync(path.join(FX, 'raw.json'), 'utf8'));
const results = {};
let failed = 0;

for (const [ds, n, md5, rowsJson] of raw) {
  const got = crypto.createHash('md5').update(rowsJson, 'utf8').digest('hex');
  if (got !== md5) {
    failed++;
    console.log(`FAIL  ${ds.padEnd(17)} md5 ${got.slice(0, 12)} != ${String(md5).slice(0, 12)} — blob was altered in transit`);
    continue;
  }
  let rows;
  try {
    rows = JSON.parse(snowflakeJsonToJson(rowsJson));
  } catch (err) {
    failed++;
    console.log(`FAIL  ${ds.padEnd(17)} not parseable after null fix-up: ${err.message}`);
    continue;
  }
  if (rows.length !== Number(n)) {
    failed++;
    console.log(`FAIL  ${ds.padEnd(17)} ${rows.length} rows parsed, Snowflake counted ${n}`);
    continue;
  }
  // enrich.js's num()/merge logic reads everything as strings-or-null, which is what
  // the live Snowflake SQL API returns too. Normalise so offline and online agree.
  results[ds] = rows.map(r => r.map(v => (v === null ? null : String(v))));
  console.log(`OK    ${ds.padEnd(17)} ${String(rows.length).padStart(4)} rows  ${md5.slice(0, 12)}`);
}

if (failed) {
  console.error(`\n${failed} dataset(s) failed verification — nothing written.`);
  process.exit(1);
}

// A dataset that silently vanishes would blank a chart, so require the full set.
// --partial skips this, for testing the verifier on a subset.
if (!process.argv.includes('--partial')) {
  const { lib, model: m } = require('./lib').model();
  const missing = Object.entries(lib.buildQueries(m))
    .filter(([k, sql]) => sql && !results[k]).map(([k]) => k);
  if (missing.length) {
    console.error(`\nMissing dataset(s): ${missing.join(', ')} — nothing written.`);
    process.exit(1);
  }
}

fs.writeFileSync(path.join(ROOT, 'fixtures.json'), JSON.stringify(results));
console.log(`\nfixtures.json written (${Object.keys(results).length} datasets). Next: node scripts/enrich.js --offline fixtures.json`);
