// Shared plumbing for the refresh tools.
//
// enrich.js is the single source of truth for what the page contains and how it is
// written. These tools never duplicate its SQL or its merge logic — they load it and
// call into it, so the two cannot drift.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const FX = path.join(ROOT, 'fx');

// enrich.js is a CLI, not a module. Strip its entry point and re-export the internals
// the tools need, rather than maintaining a second copy of any of it.
function enrichLib() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'enrich.js'), 'utf8')
    .replace(/if \(require\.main === module\)[\s\S]*$/, '')
    + '\nmodule.exports = { buildQueries, loadArrays, sanityCheck, applyResults, writeHtml };\n';
  const out = path.join(ROOT, 'scripts', '_enrich_lib.js');
  fs.writeFileSync(out, src);
  delete require.cache[require.resolve(out)];
  return require(out);
}

function model() {
  const lib = enrichLib();
  const a = lib.loadArrays(fs.readFileSync(INDEX, 'utf8'));
  return {
    lib,
    model: { customers: a.CUSTOMER_ACCOUNTS, tenants: a.SNAPSHOT_TENANTS, nextUp: a.NEXT_UP_TENANTS },
    arrays: a,
  };
}

// Snowflake's TO_JSON renders SQL NULL inside an ARRAY as the bare token `undefined`,
// which is not valid JSON. Only ever a whole array element, so it is safe to swap for
// null when it sits between a delimiter and a delimiter — a value containing the word
// would be inside quotes and is not matched.
const snowflakeJsonToJson = s => s.replace(/(?<=[\[,])undefined(?=[,\]])/g, 'null');

module.exports = { ROOT, INDEX, FX, enrichLib, model, snowflakeJsonToJson };
