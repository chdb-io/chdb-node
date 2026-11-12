// Installed-package Arrow smoke: checks the shipped addon + libchdb pair,
// never the build tree. Run with the optional apache-arrow peer installed.
import { Session, registerArrowSource, insertArrowReader } from 'chdb'
import { queryArrow as typedQueryArrow } from 'chdb/arrow'
import { Table, Int32, vectorFromArray } from 'apache-arrow'

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const session = new Session()
try {
  const input = new Table({
    x: vectorFromArray([1, 2], new Int32()),
    s: vectorFromArray(['a', 'b']), // apache-arrow's default dictionary encoding
  })
  const source = registerArrowSource(input, { session })
  try {
    const result = await session.queryAsync(`SELECT sum(x) FROM arrowstream('${source.name}')`, { format: 'CSV' })
    assert(result.text().trim() === '3', 'A1 dictionary source')
  } finally { source.close() }

  const table = await session.queryArrow('SELECT toInt32(7) AS x')
  assert(table.schema.fields[0].type.toString() === 'Int32', 'A3 typed table')
  assert(table.toArray()[0].x === 7, 'A3 value')
  assert((await typedQueryArrow(session, 'SELECT toInt32(8) AS x')).toArray()[0].x === 8,
    'optional typed Arrow subpath')
  const bound = await session.queryArrowBind('SELECT toInt32({n:Int32}) AS n', { n: 9 })
  assert(bound.toArray()[0].n === 9, 'A3/A4 server-bound parameter')

  const reader = session.queryArrowStream('SELECT toInt32(number) AS x FROM numbers(3) SETTINGS max_block_size=1')
  const values = []
  for await (const batch of reader) values.push(...batch.getChild('x').toArray())
  assert(values.join(',') === '0,1,2', 'A4 incremental batches')

  await session.queryAsync('CREATE TABLE arrow_smoke (x Int32) ENGINE=Memory')
  async function* batches() {
    yield new Table({ x: vectorFromArray([3], new Int32()) }).batches[0]
    yield new Table({ x: vectorFromArray([4], new Int32()) }).batches[0]
  }
  const written = await insertArrowReader('arrow_smoke', batches(), { session })
  assert(written.rowsSubmitted === 2, 'A2/A5 reader insert count')
  const count = await session.queryAsync('SELECT sum(x) FROM arrow_smoke', { format: 'CSV' })
  assert(count.text().trim() === '7', 'A5 inserted values')

  const dictionary = await session.queryArrow(
    "SELECT toLowCardinality('v') AS s", { lowCardinalityAsDictionary: true },
  )
  assert(dictionary.schema.fields[0].type.toString().startsWith('Dictionary<'), 'A6 dictionary option')
} finally { session.close() }
console.log('smoke-arrow-e2e OK')
