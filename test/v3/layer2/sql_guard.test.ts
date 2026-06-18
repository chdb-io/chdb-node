import { describe, it, expect } from 'vitest'
import { assertNoClusterTopology, stripStringsAndComments } from '../../../dist/layer2/sql_guard.js'
import { ChdbEmbeddedNotSupportedError } from '../../../index.js'

describe('stripStringsAndComments', () => {
  it('blanks string literals, line and block comments, preserves length', () => {
    const sql = "SELECT 'ON CLUSTER' -- cluster(x)\n, /* Distributed( */ 1"
    const out = stripStringsAndComments(sql)
    expect(out.length).toBe(sql.length)
    // none of the keyword-bearing text survives outside code positions
    expect(out).not.toMatch(/CLUSTER/)
    expect(out).not.toMatch(/Distributed/)
    expect(out).toMatch(/SELECT/)
  })

  it('handles backslash and doubled-quote escapes inside strings', () => {
    expect(() => stripStringsAndComments("SELECT 'a\\' cluster(' ")).not.toThrow()
    expect(() => stripStringsAndComments("SELECT 'it''s cluster(' ")).not.toThrow()
  })
})

describe('assertNoClusterTopology — rejects cluster topology', () => {
  it.each([
    'CREATE TABLE t ON CLUSTER my_cluster (a Int32) ENGINE = MergeTree ORDER BY a',
    'SELECT * FROM cluster(my_cluster, system.one)',
    'SELECT * FROM clusterAllReplicas(my_cluster, system.one)',
    'CREATE TABLE d (a Int32) ENGINE = Distributed(cl, db, tbl, rand())',
    'select count() from CLUSTER ( default , system.numbers )',
  ])('throws ChdbEmbeddedNotSupportedError for: %s', (sql) => {
    expect(() => assertNoClusterTopology(sql)).toThrow(ChdbEmbeddedNotSupportedError)
  })
})

describe('assertNoClusterTopology — passes federated table functions and benign SQL', () => {
  it.each([
    'SELECT 1',
    '',
    '   ',
    '-- ON CLUSTER in a comment\nSELECT 1',
    "SELECT 'cluster(' AS literal",
    "SELECT * FROM remote('127.0.0.1:9000', system.one)",
    "SELECT * FROM remoteSecure('host:9440', db.tbl)",
    "SELECT * FROM s3('https://b/x.parquet')",
    "SELECT * FROM postgresql('h:5432', 'db', 'tbl', 'u', 'p')",
    "SELECT * FROM url('https://x/data.csv', CSV)",
    'SELECT cluster_name FROM clusters_report',
  ])('passes: %s', (sql) => {
    expect(() => assertNoClusterTopology(sql)).not.toThrow()
  })
})
