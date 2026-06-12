// Micro-benchmarks for the serialization hot paths and end-to-end query/insert.
// Run: npm run bench  (node bench/bench.js)
// These are indicative numbers, not a gate — they document where time goes so
// the perf-sensitive paths are visible.
const { query, queryAsync, Session } = require('../index.js');
const { escapeStringLiteral, serializeValue, formatParamValue } = require('../dist/serialize.js');

function time(label, iters, fn) {
  fn(); // warm up
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label.padEnd(46)} ${ms.toFixed(1)} ms / ${iters} = ${(ms / iters).toFixed(4)} ms/op`);
}

(async () => {
  // 1) string escaping (single-pass). A 100 KB string, half of which needs escaping.
  const plain = 'x'.repeat(100_000);
  const heavy = "a'b\\c\t".repeat(16_666); // ~100 KB, every 6th char escapable
  time('escapeStringLiteral 100KB plain', 1000, () => escapeStringLiteral(plain));
  time('escapeStringLiteral 100KB heavy', 1000, () => escapeStringLiteral(heavy));

  // 2) serializeValue recursion: a 100k-element int array and a 10k-entry map.
  const bigArr = Array.from({ length: 100_000 }, (_, i) => i);
  const bigObj = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i]));
  time('serializeValue Array(100k ints)', 50, () => serializeValue(bigArr));
  time('serializeValue Map-like(10k)', 200, () => serializeValue(bigObj));
  time('formatParamValue string 100KB', 1000, () => formatParamValue(heavy));

  // 3) build a 10k-row INSERT (via a session) — measures inline VALUES building + exec.
  const s = new Session();
  s.query('CREATE TABLE b (n UInt32) ENGINE = Memory');
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ n: i }));
  const t0 = process.hrtime.bigint();
  await s.insert({ table: 'b', values: rows });
  console.log(`insert 10k rows (build+exec)`.padEnd(46) + ` ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms`);
  s.close();

  // 4) large async result materialization (1M rows, CSV).
  const t1 = process.hrtime.bigint();
  const r = await queryAsync('SELECT number FROM numbers(1000000)', { format: 'CSV' });
  console.log(`queryAsync 1M rows CSV (bytes=${r.bytes().length})`.padEnd(46) + ` ${(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(1)} ms`);
})();
