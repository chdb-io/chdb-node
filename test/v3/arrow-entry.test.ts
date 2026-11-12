import { describe, expect, it } from 'vitest'
import type { Table, RecordBatch } from 'apache-arrow'
import { Session } from '../../index.js'
import { queryArrow, queryArrowStream } from 'chdb/arrow'

describe('optional typed Arrow subpath', () => {
  it('returns typed Table and RecordBatch values without a hard peer on the base entry', async () => {
    const session = new Session()
    try {
      const table: Table = await queryArrow(session, 'SELECT toInt32(7) AS x')
      expect(table.toArray()[0]!.x).toBe(7)
      const stream = queryArrowStream(session, 'SELECT toInt32(number) AS x FROM numbers(2)')
      const rows: number[] = []
      for await (const batch of stream) {
        const typed: RecordBatch = batch
        rows.push(...typed.getChild('x')!.toArray() as Int32Array)
      }
      expect(rows).toEqual([0, 1])
    } finally {
      session.close()
    }
  })
})
