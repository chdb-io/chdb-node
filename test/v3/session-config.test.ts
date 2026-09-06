import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Session, query, drainPending } from '../../index.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'chdb-session-config-'))

function rejectsConnection(open: () => Session) {
  let thrown: unknown
  try {
    open().close()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toMatchObject({ name: 'ChdbConnectionError', code: 'CHDB_CONNECTION' })
}

describe('Session startup configuration', () => {
  it('rejects invalid files without losing default-connection data', () => {
    const root = tempDir()
    const table = 'session_config_default_guard'
    query(`CREATE TABLE ${table} (value UInt8) ENGINE = Memory`)
    query(`INSERT INTO ${table} VALUES (42)`)
    try {
      for (const configFile of [join(root, 'missing.xml'), root, '', '\0', null, 42]) {
        rejectsConnection(() => new Session('', { configFile: configFile as string }))
        expect(query(`SELECT value FROM ${table}`)).toBe('42\n')
      }
    } finally {
      query(`DROP TABLE IF EXISTS ${table}`)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps same-path sessions usable when a conflicting configuration is refused', async () => {
    const root = tempDir()
    const dataPath = join(root, 'data')
    const firstConfig = join(root, 'first.xml')
    const secondConfig = join(root, 'second.xml')
    writeFileSync(firstConfig, '<clickhouse/>')
    writeFileSync(secondConfig, '<clickhouse/>')
    const sessions: Session[] = []
    try {
      const first = new Session(dataPath, { configFile: firstConfig })
      sessions.push(first)
      first.query('CREATE TABLE config_guard (value UInt8) ENGINE = Memory')
      first.query('INSERT INTO config_guard VALUES (41)')
      const alongside = new Session(dataPath, { configFile: relative(process.cwd(), firstConfig) })
      sessions.push(alongside)
      alongside.query('INSERT INTO config_guard VALUES (1)')
      rejectsConnection(() => new Session(dataPath, { configFile: secondConfig }))
      rejectsConnection(() => new Session(dataPath))
      expect(first.query('SELECT sum(value) FROM config_guard')).toBe('42\n')
      first.close()
      rejectsConnection(() => new Session(dataPath, { configFile: secondConfig }))
      expect(alongside.query('SELECT sum(value) FROM config_guard')).toBe('42\n')
      alongside.close()
      await drainPending()

      const changed = new Session(dataPath, { configFile: secondConfig })
      sessions.push(changed)
      expect(changed.query('SELECT 43')).toBe('43\n')
      changed.close()
      const ordinary = new Session(dataPath)
      sessions.push(ordinary)
      rejectsConnection(() => new Session(dataPath, { configFile: firstConfig }))
      expect(ordinary.query('SELECT 44')).toBe('44\n')
      ordinary.close()
      expect(readFileSync(firstConfig, 'utf8')).toBe('<clickhouse/>')
      expect(readFileSync(secondConfig, 'utf8')).toBe('<clickhouse/>')
    } finally {
      for (const session of sessions) session.close()
      await drainPending()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('signs every loopback S3 request with the configured region, including after reopening', async () => {
    const root = tempDir()
    const dataPath = join(root, 'data')
    const body = Buffer.from('41\n42\n')
    const requests: { method: string | undefined; url: string | undefined; region: string | undefined }[] = []
    let expectedRegion = ''
    const server = createServer((request, response) => {
      // Keep only the signing region. Do not retain or print authorization headers.
      const region = /Credential=[^/]+\/\d{8}\/([^/]+)\/s3\/aws4_request/.exec(request.headers.authorization || '')?.[1]
      requests.push({ method: request.method, url: request.url, region })
      if (region !== expectedRegion) {
        request.resume()
        response.writeHead(403, { 'Content-Type': 'application/xml' })
        response.end('<Error><Code>SignatureDoesNotMatch</Code><Message>Wrong signing region</Message></Error>')
        return
      }
      if (request.url !== '/session-config/rows.csv' || !['HEAD', 'GET'].includes(request.method || '')) {
        response.writeHead(404).end()
        return
      }
      response.setHeader('Content-Type', 'text/csv')
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader('ETag', '"session-config-fixture"')
      if (request.method === 'HEAD') {
        response.setHeader('Content-Length', body.length)
        response.end()
        return
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
      if (start > end) {
        response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end()
        return
      }
      if (range) {
        response.statusCode = 206
        response.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`)
      }
      response.setHeader('Content-Length', end - start + 1)
      response.end(body.subarray(start, end + 1))
    })
    let session: Session | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('The loopback server has no TCP address.')
      const endpoint = `http://127.0.0.1:${address.port}/session-config/`
      for (const region of ['eu-west-1', 'ap-southeast-2']) {
        expectedRegion = region
        const configFile = join(root, `${region}.xml`)
        const config = `<clickhouse><s3><session_config><endpoint>${endpoint}</endpoint><region>${region}</region></session_config></s3></clickhouse>`
        writeFileSync(configFile, config)
        requests.length = 0
        session = new Session(dataPath, { configFile: relative(process.cwd(), configFile) })
        const stream = session.queryStreamBind(
          "SELECT value FROM s3({url:String}, {key:String}, {secret:String}, 'CSV', 'value UInt8') ORDER BY value",
          { url: `${endpoint}rows.csv`, key: 'session-config-test', secret: 'session-config-dummy-secret' },
          { format: 'CSV' },
        )
        let result = ''
        for await (const chunk of stream) result += chunk.text()
        expect(result).toBe('41\n42\n')
        expect(requests.some((request) => request.method === 'GET')).toBe(true)
        expect(requests.map((request) => request.region)).toEqual(requests.map(() => region))
        expect(requests.map((request) => request.url)).toEqual(requests.map(() => '/session-config/rows.csv'))
        session.close()
        await drainPending()
        expect(existsSync(configFile)).toBe(true)
        expect(readFileSync(configFile, 'utf8')).toBe(config)
      }
    } finally {
      session?.close()
      await drainPending()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
