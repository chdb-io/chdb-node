/** Optional typed Arrow seam. Import this subpath when apache-arrow is installed. */
import type { Table, RecordBatch, Schema } from 'apache-arrow'
import type { Session, DirectArrowOptions } from '../index'

export interface TypedArrowReader extends AsyncIterable<RecordBatch> {
  readonly closed: boolean
  readonly schema: Schema | null
  cancel(): void
}

export function queryArrow(session: Session, sql: string, options?: DirectArrowOptions): Promise<Table> {
  return session.queryArrow(sql, options) as Promise<Table>
}

export function queryArrowBind(session: Session, sql: string, params: object,
                               options?: DirectArrowOptions): Promise<Table> {
  return session.queryArrowBind(sql, params, options) as Promise<Table>
}

export function queryArrowStream(session: Session, sql: string,
                                 options?: DirectArrowOptions): TypedArrowReader {
  return session.queryArrowStream(sql, options) as TypedArrowReader
}

export function queryArrowStreamBind(session: Session, sql: string, params: object,
                                     options?: DirectArrowOptions): TypedArrowReader {
  return session.queryArrowStreamBind(sql, params, options) as TypedArrowReader
}

export { registerArrowSource, registerArrowReader, insertArrow, insertArrowReader } from './layer3'
