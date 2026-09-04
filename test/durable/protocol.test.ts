/**
 * Format and negotiation conformance (contract §4, §7.2, §7.3).
 *
 * These are the checks that decide whether another binding can read what this
 * one writes, and — more importantly — whether this one correctly refuses what
 * it must not read. The refusal cases matter more than the happy path: quietly
 * ignoring a feature name or a checksum mismatch means opening a broken object
 * and not knowing it.
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { coldHead, parseHead, serializeHead } from '../../src/durable/head'
import { assertEngineCompatible, assertReadable, assertWritable } from '../../src/durable/negotiate'
import { compareEngineVersions, maxEngineVersion, parseEngineVersion } from '../../src/durable/version'
import { decodeWalSegment, encodeWalSegment, walLineBytes } from '../../src/durable/wal'
import { checkpointKey, isValidObjectKey, walKey } from '../../src/durable/keys'
import { LIMITS } from '../../src/durable/types'
import { LocalDurableBackend } from '../../src/durable/backends/local'
import {
  QueryClass,
  assertExecuteAllowed,
  assertQueryAllowed,
  type QueryAnalysis,
} from '../../src/durable/engine-adapter'
import { isDurableErrorOf } from '../../src/durable/errors'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function bytes(o: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(o), 'utf8')
}

function goodHead(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: { version: 1, reader_features: [], writer_features: [] },
    engine: { name: 'chdb', version: '26.7.2', backup_format: 1, min_reader: '26.7.2' },
    lease: { generation: 3, owner: 'w', instance: 'i', expires_at: 1788230400.0 },
    manifest: {
      db: 'mem',
      base: { key: 'checkpoints/3-8-acde1234.tar.gz', size: 1048576, sha256: SHA_A },
      wal: [{ key: 'wal/3-9-acde5678.jsonl', size: 127, sha256: SHA_B }],
      seq: 9,
    },
    ...patch,
  }
}

/** Assert an error carries a specific frozen category. */
function expectCategory(fn: () => unknown, category: string): void {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught, `expected a ${category} error`).toBeDefined()
  expect(isDurableErrorOf(caught, category as never), `got ${String(caught)}`).toBe(true)
}

describe('head.json schema', () => {
  it('parses the frozen shape', () => {
    const { head } = parseHead(bytes(goodHead()))
    expect(head.manifest.db).toBe('mem')
    expect(head.manifest.base?.size).toBe(1048576)
    expect(head.manifest.wal).toHaveLength(1)
    expect(head.lease.generation).toBe(3)
  })

  it('reads a head whose keys are in a different order and whitespace', () => {
    const source = goodHead()
    const flipped: Record<string, unknown> = {}
    for (const k of Object.keys(source).reverse()) flipped[k] = source[k]
    const { head } = parseHead(Buffer.from(JSON.stringify(flipped, null, 4), 'utf8'))
    expect(head.manifest.seq).toBe(9)
    expect(head.engine.version).toBe('26.7.2')
  })

  it('treats a released lease as fully null', () => {
    const { head } = parseHead(
      bytes(goodHead({ lease: { generation: 3, owner: null, instance: null, expires_at: null } })),
    )
    expect(head.lease).toEqual({ generation: 3, owner: null, instance: null, expires_at: null })
  })

  it('refuses a half-released lease rather than guessing', () => {
    expectCategory(
      () => parseHead(bytes(goodHead({ lease: { generation: 3, owner: 'w', instance: null, expires_at: null } }))),
      'corrupt',
    )
  })

  it('refuses a malformed digest', () => {
    const h = goodHead()
    ;(h['manifest'] as Record<string, unknown>)['base'] = {
      key: 'checkpoints/1-1-aaaaaaaa.tar.gz',
      size: 1,
      sha256: 'NOTHEX',
    }
    expectCategory(() => parseHead(bytes(h)), 'corrupt')
  })

  it('refuses a reference whose key escapes the object prefix', () => {
    const h = goodHead()
    ;(h['manifest'] as Record<string, unknown>)['base'] = {
      key: '../../etc/passwd',
      size: 1,
      sha256: SHA_A,
    }
    expectCategory(() => parseHead(bytes(h)), 'corrupt')
  })

  it('refuses a head with no engine block, because it cannot prove a version match', () => {
    const h = goodHead()
    delete h['engine']
    expectCategory(() => parseHead(bytes(h)), 'corrupt')
  })

  it('refuses a head over the frozen 1 MiB limit', () => {
    const h = goodHead({ padding: 'x'.repeat(LIMITS.MAX_HEAD_BYTES) })
    expectCategory(() => parseHead(bytes(h)), 'limit_exceeded')
  })

  it('defaults the compatibility fields conservatively when they are absent', () => {
    // An object written before these existed must not be retroactively widened:
    // backup_format is the V1 baseline it necessarily used, and min_reader
    // falls back to the producer, reproducing the old lower bound.
    const h = goodHead()
    ;(h['engine'] as Record<string, unknown>) = { name: 'chdb', version: '26.7.2' }
    const { head } = parseHead(bytes(h))
    expect(head.engine.backup_format).toBe(1)
    expect(head.engine.min_reader).toBe('26.7.2')
  })

  it('validates the compatibility fields strictly when present', () => {
    const bad = goodHead()
    ;(bad['engine'] as Record<string, unknown>)['backup_format'] = 'one'
    expectCategory(() => parseHead(bytes(bad)), 'corrupt')
    const bad2 = goodHead()
    ;(bad2['engine'] as Record<string, unknown>)['min_reader'] = 42
    expectCategory(() => parseHead(bytes(bad2)), 'corrupt')
  })

  it('defaults a missing protocol block to the V1 baseline', () => {
    const h = goodHead()
    delete h['protocol']
    const { head } = parseHead(bytes(h))
    expect(head.protocol).toEqual({ version: 1, reader_features: [], writer_features: [] })
  })
})

describe('head.json round-trip', () => {
  it('preserves unknown fields at the top level and inside every known block', () => {
    const original = goodHead({
      unknown_top: { anything: [1, 2, 3] },
      protocol: { version: 1, reader_features: [], writer_features: [], future_knob: 'keep me' },
      engine: { name: 'chdb', version: '26.7.0', build: 'keep me too' },
      lease: { generation: 3, owner: 'w', instance: 'i', expires_at: 1.5, note: 'and me' },
      manifest: {
        db: 'mem',
        base: null,
        wal: [],
        seq: 0,
        vendor_extension: { deep: true },
      },
    })
    const { head, raw } = parseHead(bytes(original))

    // Change something this build owns, then write back.
    head.manifest.seq = 1
    const out = JSON.parse(Buffer.from(serializeHead(head, raw)).toString('utf8'))

    expect(out.unknown_top).toEqual({ anything: [1, 2, 3] })
    expect(out.protocol.future_knob).toBe('keep me')
    expect(out.engine.build).toBe('keep me too')
    expect(out.lease.note).toBe('and me')
    expect(out.manifest.vendor_extension).toEqual({ deep: true })
    expect(out.manifest.seq).toBe(1)
  })

  it('round-trips a cold head through parse and serialize unchanged', () => {
    const head = coldHead('mem', '26.7.0')
    const { head: reparsed } = parseHead(serializeHead(head))
    expect(reparsed).toEqual(head)
  })

  it('refuses to write a head that would exceed the limit', () => {
    const head = coldHead('mem', '26.7.0')
    head.manifest.wal = Array.from({ length: 20_000 }, (_, i) => ({
      key: `wal/1-${i}-abcdefab.jsonl`,
      size: 10,
      sha256: SHA_A,
    }))
    expectCategory(() => serializeHead(head), 'limit_exceeded')
  })
})

describe('protocol negotiation', () => {
  it('refuses a future protocol version', () => {
    const head = coldHead('mem', '26.7.0')
    head.protocol.version = 2
    expectCategory(() => assertReadable(head), 'protocol_unsupported')
  })

  it('refuses an unknown reader feature and names it', () => {
    const head = coldHead('mem', '26.7.0')
    head.protocol.reader_features = ['preamble']
    let caught: unknown
    try {
      assertReadable(head)
    } catch (e) {
      caught = e
    }
    expect(isDurableErrorOf(caught, 'protocol_unsupported')).toBe(true)
    expect((caught as Error).message).toContain('preamble')
  })

  it('allows reading but refuses writing on an unknown writer feature', () => {
    const head = coldHead('mem', '26.7.0')
    head.protocol.writer_features = ['data-wal']
    expect(() => assertReadable(head)).not.toThrow()
    expectCategory(() => assertWritable(head), 'protocol_unsupported')
  })

  it('opens for the producing engine and every later one', () => {
    // The behaviour an exact-match gate got wrong. A newer chdb-core restores
    // full backups made by an earlier one, so refusing them was refusing the
    // normal upgrade path.
    const head = coldHead('mem', '26.7.2-rc.2')
    for (const v of ['26.7.2-rc.2', '26.7.2-rc.3', '26.7.2', '26.7.3', '26.8.1', '27.0.0']) {
      expect(() => assertEngineCompatible(head, { version: v, backupFormat: 1 }), v).not.toThrow()
    }
  })

  it('refuses a reader older than min_reader', () => {
    const head = coldHead('mem', '26.7.2')
    for (const v of ['26.7.1', '26.6.9', '26.7.2-rc.2', '25.1.0']) {
      expectCategory(() => assertEngineCompatible(head, { version: v, backupFormat: 1 }), 'engine_incompatible')
    }
  })

  it('refuses an archive format generation above this engine', () => {
    // The escape hatch: version numbers keep rising whether or not the format
    // still restores, so a withdrawn promise needs its own signal.
    const head = coldHead('mem', '26.7.2')
    head.engine.backup_format = 2
    expectCategory(
      () => assertEngineCompatible(head, { version: '27.0.0', backupFormat: 1 }),
      'engine_incompatible',
    )
    expect(() => assertEngineCompatible(head, { version: '27.0.0', backupFormat: 2 })).not.toThrow()
  })

  it('does not gate on engine.version, which only records the producer', () => {
    const head = coldHead('mem', '26.7.2')
    head.engine.version = '26.7.2'
    head.engine.min_reader = '26.7.2'
    // Producer differs from the running engine, min_reader is satisfied: open.
    expect(() => assertEngineCompatible(head, { version: '26.9.0', backupFormat: 1 })).not.toThrow()
  })

  it('refuses a different engine outright', () => {
    const head = coldHead('mem', '26.7.2')
    head.engine.name = 'not-chdb'
    expectCategory(() => assertEngineCompatible(head, { version: '26.7.2', backupFormat: 1 }), 'engine_incompatible')
  })

  it('refuses rather than guesses when a version cannot be ordered', () => {
    const head = coldHead('mem', '26.7.2')
    head.engine.min_reader = 'nightly-build'
    expectCategory(() => assertEngineCompatible(head, { version: '26.7.2', backupFormat: 1 }), 'engine_incompatible')
  })
})

describe('release precedence', () => {
  it('orders releases and pre-releases the way chDB ships them', () => {
    const ascending = [
      '25.9.0',
      '26.7.1',
      '26.7.2-rc.1',
      '26.7.2-rc.2',
      '26.7.2-rc.10',
      '26.7.2',
      '26.7.3',
      '26.8.1',
      '26.10.0',
      '27.0.0',
    ]
    for (let i = 0; i < ascending.length - 1; i++) {
      const a = ascending[i] as string
      const b = ascending[i + 1] as string
      expect(compareEngineVersions(a, b), `${a} < ${b}`).toBeLessThan(0)
      expect(compareEngineVersions(b, a), `${b} > ${a}`).toBeGreaterThan(0)
    }
  })

  it('does not order them as strings', () => {
    // Both of these are backwards lexicographically, and both would let a
    // reader open an object it cannot restore.
    expect('26.10.0' < '26.7.0').toBe(true)
    expect(compareEngineVersions('26.10.0', '26.7.0')).toBeGreaterThan(0)
    expect('26.7.2-rc.2' > '26.7.2').toBe(true)
    expect(compareEngineVersions('26.7.2-rc.2', '26.7.2')).toBeLessThan(0)
  })

  it('treats a missing component as zero', () => {
    expect(compareEngineVersions('26.7', '26.7.0')).toBe(0)
    expect(compareEngineVersions('26.7', '26.7.1')).toBeLessThan(0)
  })

  it('ignores build metadata, as precedence requires', () => {
    expect(compareEngineVersions('26.7.2+build.5', '26.7.2')).toBe(0)
  })

  it('returns the later of two versions', () => {
    expect(maxEngineVersion('26.7.2-rc.2', '26.7.2')).toBe('26.7.2')
    expect(maxEngineVersion('26.8.0', '26.7.9')).toBe('26.8.0')
  })

  it("orders chDB's actual release shapes", () => {
    // chDB ships only X.Y.Z and X.Y.Z-rc.N, and a patch that had an RC never
    // gets a stable of the same number: after 26.7.2-rc.2 the next stable is
    // 26.7.3. This is the sequence a real upgrade walks.
    const shipped = ['26.7.1', '26.7.2-rc.1', '26.7.2-rc.2', '26.7.3', '26.7.4-rc.1', '26.8.0']
    for (let i = 0; i < shipped.length - 1; i++) {
      const a = shipped[i] as string
      const b = shipped[i + 1] as string
      expect(compareEngineVersions(a, b), `${a} < ${b}`).toBeLessThan(0)
    }
    // An object written by an RC therefore opens on every later stable.
    expect(compareEngineVersions('26.7.3', '26.7.2-rc.2')).toBeGreaterThan(0)
    expect(compareEngineVersions('26.8.0', '26.7.2-rc.2')).toBeGreaterThan(0)
  })

  it('still orders a same-numbered stable above its RC, though chDB does not ship one', () => {
    // Being more permissive than the convention costs nothing; assuming the
    // convention would be wrong the day it changes.
    expect(compareEngineVersions('26.7.2-rc.2', '26.7.2')).toBeLessThan(0)
  })

  it('refuses to order something it cannot parse', () => {
    expect(parseEngineVersion('nightly')).toBeUndefined()
    expect(parseEngineVersion('')).toBeUndefined()
    expectCategory(() => compareEngineVersions('26.7.2', 'nightly'), 'engine_incompatible')
  })
})

describe('object keys', () => {
  it('mints unique keys with the frozen shape', () => {
    expect(checkpointKey(3, 8)).toMatch(/^checkpoints\/3-8-[0-9a-f]{8}\.tar\.gz$/)
    expect(walKey(3, 9)).toMatch(/^wal\/3-9-[0-9a-f]{8}\.jsonl$/)
    expect(walKey(1, 1)).not.toBe(walKey(1, 1))
  })

  it('rejects the key shapes a reference must never take', () => {
    for (const bad of ['/abs', 'a//b', './a', '../a', 'a/../b', '', 'a\\b', 'a\0b']) {
      expect(isValidObjectKey(bad), bad).toBe(false)
    }
    expect(isValidObjectKey('wal/1-1-abcdefab.jsonl')).toBe(true)
  })
})

describe('WAL segments', () => {
  it('round-trips statements in order', () => {
    const statements = ['INSERT INTO t VALUES (1)', "ALTER TABLE t UPDATE x = 2 WHERE id = 1"]
    const encoded = encodeWalSegment(statements)
    expect(Buffer.from(encoded).toString('utf8').endsWith('\n')).toBe(true)
    expect(decodeWalSegment(encoded, 'wal/x')).toEqual(statements)
  })

  it('round-trips statements containing newlines and quotes', () => {
    const statements = ['INSERT INTO t VALUES (\'a\nb\')', 'INSERT INTO t VALUES ("c\\"d")']
    expect(decodeWalSegment(encodeWalSegment(statements), 'wal/x')).toEqual(statements)
  })

  it('encodes an empty buffer as an empty segment', () => {
    expect(decodeWalSegment(encodeWalSegment([]), 'wal/x')).toEqual([])
  })

  it('refuses a truncated segment rather than replaying a prefix', () => {
    const encoded = Buffer.from(encodeWalSegment(['INSERT INTO t VALUES (1)']))
    expectCategory(() => decodeWalSegment(encoded.subarray(0, encoded.length - 5), 'wal/x'), 'corrupt')
  })

  it('refuses a line that is not an object with a string sql', () => {
    expectCategory(() => decodeWalSegment(Buffer.from('["INSERT"]\n'), 'wal/x'), 'corrupt')
    expectCategory(() => decodeWalSegment(Buffer.from('{"sql":1}\n'), 'wal/x'), 'corrupt')
    expectCategory(() => decodeWalSegment(Buffer.from('{"nope":"x"}\n'), 'wal/x'), 'corrupt')
    expectCategory(() => decodeWalSegment(Buffer.from('not json\n'), 'wal/x'), 'corrupt')
  })

  it('budgets exactly what the encoder produces', () => {
    // The object layer decides whether a statement fits by summing
    // walLineBytes. If that disagrees with the encoder by even one byte per
    // line, the boundary it enforces is the wrong boundary — so the two are
    // pinned together here rather than left to stay in step by inspection.
    const cases: string[][] = [
      [],
      ['INSERT INTO t VALUES (1)'],
      ['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)'],
      ['a\nb', 'quote " and \\ backslash', '中文字符', '\u0000 nul'],
      Array.from({ length: 200 }, (_, i) => `INSERT INTO t VALUES (${i})`),
    ]
    for (const statements of cases) {
      const budget = statements.reduce((n, s) => n + walLineBytes(s), 0)
      expect(budget, JSON.stringify(statements).slice(0, 60)).toBe(
        encodeWalSegment(statements).byteLength,
      )
    }
  })

  it('refuses a statement over the frozen per-statement limit', () => {
    const huge = 'x'.repeat(LIMITS.MAX_SQL_BYTES + 1)
    expectCategory(() => encodeWalSegment([huge]), 'limit_exceeded')
  })
})

describe('entry-point gates', () => {
  const ok: QueryAnalysis = {
    statementCount: 1,
    queryClass: QueryClass.Mutating,
    hasSecrets: false,
    writesOnlyTargetDatabase: true,
    changesDatabaseLifecycle: false,
  }

  it('accepts exactly one READ_ONLY statement on query', () => {
    expect(() => assertQueryAllowed({ ...ok, queryClass: QueryClass.ReadOnly })).not.toThrow()
  })

  it('lets a read-only statement carry a secret, because it never reaches the WAL', () => {
    expect(() =>
      assertQueryAllowed({ ...ok, queryClass: QueryClass.ReadOnly, hasSecrets: true }),
    ).not.toThrow()
  })

  it('refuses a mutation through query, whatever the method is called', () => {
    expectCategory(() => assertQueryAllowed(ok), 'classification_refused')
  })

  it('refuses multiple statements at both entry points', () => {
    expectCategory(() => assertQueryAllowed({ ...ok, queryClass: QueryClass.ReadOnly, statementCount: 2 }), 'classification_refused')
    expectCategory(() => assertExecuteAllowed({ ...ok, statementCount: 2 }, 'mem'), 'classification_refused')
  })

  it('accepts a single in-database mutation on execute', () => {
    expect(() => assertExecuteAllowed(ok, 'mem')).not.toThrow()
  })

  it('refuses every MUTATING_GLOBAL statement', () => {
    expectCategory(
      () => assertExecuteAllowed({ ...ok, queryClass: QueryClass.MutatingGlobal, writesOnlyTargetDatabase: false }, 'mem'),
      'classification_refused',
    )
  })

  it('refuses CONTROL and UNKNOWN, failing closed on the latter', () => {
    expectCategory(() => assertExecuteAllowed({ ...ok, queryClass: QueryClass.Control }, 'mem'), 'classification_refused')
    expectCategory(() => assertExecuteAllowed({ ...ok, queryClass: QueryClass.Unknown, statementCount: 0 }, 'mem'), 'classification_refused')
  })

  it('refuses a write core could not confine to this database', () => {
    expectCategory(() => assertExecuteAllowed({ ...ok, writesOnlyTargetDatabase: false }, 'mem'), 'classification_refused')
  })

  it('refuses a database lifecycle change', () => {
    expectCategory(() => assertExecuteAllowed({ ...ok, changesDatabaseLifecycle: true }, 'mem'), 'classification_refused')
  })

  it('refuses a secret-bearing mutation without echoing the statement', () => {
    let caught: unknown
    try {
      assertExecuteAllowed({ ...ok, hasSecrets: true }, 'mem')
    } catch (e) {
      caught = e
    }
    expect(isDurableErrorOf(caught, 'secret_refused')).toBe(true)
    expect((caught as Error).message).not.toMatch(/INSERT|SELECT|CREATE/)
  })
})

describe('review regressions: head parsing', () => {
  it('refuses a truncated lease instead of reading it as released', () => {
    // A half-written lease used to parse as the all-null released form, which
    // would hand the object to a new writer on the strength of a corrupt head.
    for (const lease of [
      { generation: 7 },
      { generation: 7, owner: 'w' },
      { generation: 7, owner: 'w', instance: 'i' },
      { generation: 7, owner: null, instance: null },
    ]) {
      expectCategory(() => parseHead(bytes(goodHead({ lease }))), 'corrupt')
    }
    // The released form is three explicit nulls, and still parses.
    const ok = goodHead({ lease: { generation: 7, owner: null, instance: null, expires_at: null } })
    expect(parseHead(bytes(ok)).head.lease.owner).toBeNull()
  })

  it('refuses required manifest fields that are absent or null', () => {
    for (const manifest of [
      { base: null, wal: [], seq: 0 },
      { db: 'mem', wal: [], seq: 0 },
      { db: 'mem', base: null, seq: 0 },
      { db: 'mem', base: null, wal: [] },
      { db: 'mem', base: null, wal: null, seq: 0 },
      { db: null, base: null, wal: [], seq: 0 },
    ]) {
      expectCategory(() => parseHead(bytes(goodHead({ manifest }))), 'corrupt')
    }
  })

  it('refuses an explicit null in a known field that has a default', () => {
    // The defaults exist for documents written before a field did; they are
    // not a way to launder a null into a valid value.
    const p = goodHead()
    ;(p['protocol'] as Record<string, unknown>)['version'] = null
    expectCategory(() => parseHead(bytes(p)), 'corrupt')
    const e = goodHead()
    ;(e['engine'] as Record<string, unknown>)['min_reader'] = null
    expectCategory(() => parseHead(bytes(e)), 'corrupt')
  })

  it('refuses to emit a head this parser would reject', () => {
    // head.json is created with a conditional create and V1 has no destroy, so
    // publishing an unreadable one makes the object permanently unopenable.
    // Failing at the write is the only recoverable end.
    expectCategory(() => serializeHead(coldHead('', '26.7.2')), 'corrupt')
    const noVersion = coldHead('mem', '26.7.2')
    noVersion.engine.version = ''
    expectCategory(() => serializeHead(noVersion), 'corrupt')
    const noFloor = coldHead('mem', '26.7.2')
    noFloor.engine.min_reader = ''
    expectCategory(() => serializeHead(noFloor), 'corrupt')
  })

  it('refuses malformed UTF-8 rather than rewriting it as replacement characters', () => {
    // Lenient decoding turned invalid bytes in an *unknown* field into U+FFFD
    // and wrote them back mangled, corrupting the one thing round-tripping is
    // for.
    const good = Buffer.from(JSON.stringify(goodHead({ vendor_extension: 'PLACEHOLDER' })))
    const bad = Buffer.from(good)
    bad[good.indexOf(Buffer.from('PLACEHOLDER'))] = 0x80 // lone continuation byte
    expectCategory(() => parseHead(bad), 'corrupt')
  })
})

describe('review regressions: WAL reader limits', () => {
  it('refuses a decoded statement over the per-statement limit', () => {
    // The segment ceiling is twice the statement ceiling, so a hand-built
    // segment could carry a statement no conforming writer could produce.
    const huge = 'x'.repeat(LIMITS.MAX_SQL_BYTES + 1)
    const segment = Buffer.from(JSON.stringify({ sql: huge }) + '\n')
    expect(segment.byteLength).toBeLessThan(LIMITS.MAX_WAL_SEGMENT_BYTES)
    expectCategory(() => decodeWalSegment(segment, 'wal/x'), 'limit_exceeded')
  })
})

describe('local backend conditional operations', () => {
  async function backend(): Promise<LocalDurableBackend> {
    const root = await mkdtemp(join(tmpdir(), 'durable-be-'))
    return new LocalDurableBackend({ root: join(root, 'obj') })
  }

  it('creates once and refuses to overwrite', async () => {
    const be = await backend()
    expect(await be.putBytesIfAbsent('wal/1-1-aaaaaaaa.jsonl', Buffer.from('a'))).toBe('created')
    expect(await be.putBytesIfAbsent('wal/1-1-aaaaaaaa.jsonl', Buffer.from('b'))).toBe('already-exists')
    expect(Buffer.from((await be.getBytes('wal/1-1-aaaaaaaa.jsonl'))!).toString()).toBe('a')
  })

  it('replaces only against the current token', async () => {
    const be = await backend()
    await be.putBytesIfAbsent('head.json', Buffer.from('{"v":0}'))
    const first = (await be.getBytesWithEtag('head.json'))!

    const replaced = await be.replaceIfMatch('head.json', Buffer.from('{"v":1}'), first.etag)
    expect(replaced.status).toBe('replaced')

    const stale = await be.replaceIfMatch('head.json', Buffer.from('{"v":2}'), first.etag)
    expect(stale.status).toBe('not-replaced')

    const now = (await be.getBytesWithEtag('head.json'))!
    expect(Buffer.from(now.bytes).toString()).toBe('{"v":1}')
  })

  it('lets exactly one of many concurrent replacers win', async () => {
    const be = await backend()
    await be.putBytesIfAbsent('head.json', Buffer.from('{"v":0}'))
    const { etag } = (await be.getBytesWithEtag('head.json'))!

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => be.replaceIfMatch('head.json', Buffer.from(`{"v":${i}}`), etag)),
    )
    expect(results.filter((r) => r.status === 'replaced')).toHaveLength(1)
  })

  it('adopts a plain head written by another implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-be-'))
    const objDir = join(root, 'obj')
    const be = new LocalDurableBackend({ root: objDir })
    // Another binding's fixture: a plain file, no version chain.
    await be.putBytesIfAbsent('placeholder', Buffer.from('x'))
    await writeFile(join(objDir, 'head.json'), '{"foreign":true}')

    const read = (await be.getBytesWithEtag('head.json'))!
    expect(read.etag.startsWith('f')).toBe(true)
    expect(Buffer.from(read.bytes).toString()).toBe('{"foreign":true}')

    const out = await be.replaceIfMatch('head.json', Buffer.from('{"ours":true}'), read.etag)
    expect(out.status).toBe('replaced')

    // A plain-file reader still sees the current head through the symlink.
    expect(await readFile(join(objDir, 'head.json'), 'utf8')).toBe('{"ours":true}')
    const stale = await be.replaceIfMatch('head.json', Buffer.from('{"no":true}'), read.etag)
    expect(stale.status).toBe('not-replaced')
  })

  /** Move an object into the version chain, which only happens on first replace. */
  async function chained(be: LocalDurableBackend): Promise<string> {
    await be.putBytesIfAbsent('head.json', Buffer.from('{"v":"plain"}'))
    const plain = (await be.getBytesWithEtag('head.json'))!
    await be.replaceIfMatch('head.json', Buffer.from('{"v":0}'), plain.etag)
    return (await be.getBytesWithEtag('head.json'))!.etag
  }

  it('refuses a token that names a version which is not the current one', async () => {
    // This used to create a version nobody had read, skip the one between, and
    // publish it — a compare-and-swap succeeding against a value never stored.
    const be = await backend()
    expect(await chained(be)).toBe('v1')
    const r = await be.replaceIfMatch('head.json', Buffer.from('{"hijacked":true}'), 'v2')
    expect(r.status).toBe('not-replaced')
    expect(Buffer.from((await be.getBytesWithEtag('head.json'))!.bytes).toString()).toBe('{"v":0}')
  })

  it('recovers from a crash between creating a version and publishing it', async () => {
    // The pointer is a hint; the highest existing version is the authority.
    // Trusting the pointer wedged the object permanently — every later writer
    // held the pointed-at token, lost the create to the orphan, and reported
    // not-replaced forever.
    const be = await backend()
    expect(await chained(be)).toBe('v1')
    const orphan = join(be.root, '.head-versions', '2.json')
    await writeFile(orphan, '{"v":"written by a writer that died"}')

    // A reader now sees the published version, not the stale pointer.
    const seen = (await be.getBytesWithEtag('head.json'))!
    expect(seen.etag).toBe('v2')
    expect(Buffer.from(seen.bytes).toString()).toContain('died')

    // And the chain moves on rather than deadlocking.
    const r = await be.replaceIfMatch('head.json', Buffer.from('{"v":3}'), seen.etag)
    expect(r.status).toBe('replaced')
    expect((await be.getBytesWithEtag('head.json'))!.etag).toBe('v3')
  })

  it('reports a stale token honestly and leaves recovery to the caller', async () => {
    // A writer whose own write landed but whose response was lost still holds
    // the old token. The backend does not try to be clever about that: the
    // token no longer names the current version, so the answer is
    // not-replaced. Recognising the write as one's own needs the head's
    // contents and the lease, neither of which a backend can interpret, so it
    // belongs to commitHead's reconciliation.
    const be = await backend()
    expect(await chained(be)).toBe('v1')
    const mine = Buffer.from('{"v":"mine"}')
    await writeFile(join(be.root, '.head-versions', '2.json'), mine)

    expect(await be.replaceIfMatch('head.json', mine, 'v1')).toEqual({ status: 'not-replaced' })
    // What the caller then rereads is its own write, which is what lets the
    // layer above conclude the commit landed.
    const fresh = (await be.getBytesWithEtag('head.json'))!
    expect(fresh.etag).toBe('v2')
    expect(Buffer.from(fresh.bytes)).toEqual(mine)
  })

  it('lets one of two concurrent writers win a version and tells the other', async () => {
    // The path that reaches the conditional-create collision: both read the
    // same version, both try to create the one above it.
    const be = await backend()
    const etag = await chained(be)
    const [a, b] = await Promise.all([
      be.replaceIfMatch('head.json', Buffer.from('{"w":"a"}'), etag),
      be.replaceIfMatch('head.json', Buffer.from('{"w":"b"}'), etag),
    ])
    const outcomes = [a.status, b.status].sort()
    expect(outcomes).toEqual(['not-replaced', 'replaced'])
    // Whoever won, the pointer names their version and it is readable.
    expect((await be.getBytesWithEtag('head.json'))!.etag).toBe('v2')
  })

  it('refuses to publish through a symlinked directory', async () => {
    // A lexically valid key can still leave the prefix if a component is a
    // link. Whoever plants it can usually write the object anyway, but a link
    // planted once in a shared parent should not silently redirect every
    // later operation.
    const root = await mkdtemp(join(tmpdir(), 'durable-link-'))
    const objDir = join(root, 'obj')
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await mkdir(objDir, { recursive: true })
    await symlink(outside, join(objDir, 'checkpoints'))

    const be = new LocalDurableBackend({ root: objDir })
    await expect(
      be.putBytesIfAbsent('checkpoints/1-1-aaaaaaaa.tar.gz', Buffer.from('x')),
    ).rejects.toThrow(/symlink/)
    expect(existsSync(join(outside, '1-1-aaaaaaaa.tar.gz'))).toBe(false)
  })

  it('publishes a staged file with its contents flushed, on every path', async () => {
    // The barriers live in the publish primitive, so a caller cannot reach
    // publication without them. This checks the observable half: the object is
    // there and correct however it got staged.
    const be = await backend()
    const dir = await mkdtemp(join(tmpdir(), 'durable-src-'))
    const src = join(dir, 'checkpoint.tar.gz')
    const payload = Buffer.from('archive bytes')
    await writeFile(src, payload)

    expect(await be.putFileIfAbsent('checkpoints/1-1-bbbbbbbb.tar.gz', src)).toBe('created')
    expect(Buffer.from((await be.getBytes('checkpoints/1-1-bbbbbbbb.tar.gz'))!)).toEqual(payload)
    // And it stays a conditional create.
    expect(await be.putFileIfAbsent('checkpoints/1-1-bbbbbbbb.tar.gz', src)).toBe('already-exists')
  })

  it('refuses a key that would escape the object prefix', async () => {
    const be = await backend()
    await expect(be.getBytes('../escape')).rejects.toThrow(/invalid key|escapes/)
  })

  it('reports a missing key rather than throwing', async () => {
    const be = await backend()
    expect(await be.getBytes('wal/nope.jsonl')).toBeUndefined()
    expect(await be.getBytesWithEtag('head.json')).toBeUndefined()
    expect(await be.openReadStream('checkpoints/nope.tar.gz')).toBeUndefined()
  })
})
