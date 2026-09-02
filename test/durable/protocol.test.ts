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
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { coldHead, parseHead, serializeHead } from '../../src/durable/head'
import { assertEngineMatches, assertReadable, assertWritable } from '../../src/durable/negotiate'
import { decodeWalSegment, encodeWalSegment } from '../../src/durable/wal'
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
    engine: { name: 'chdb', version: '26.7.0' },
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
    expect(head.engine.version).toBe('26.7.0')
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

  it('requires an exact engine version match', () => {
    const head = coldHead('mem', '26.7.0')
    expect(() => assertEngineMatches(head, '26.7.0')).not.toThrow()
    expectCategory(() => assertEngineMatches(head, '26.7.1'), 'engine_incompatible')
    expectCategory(() => assertEngineMatches(head, '26.7'), 'engine_incompatible')
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
