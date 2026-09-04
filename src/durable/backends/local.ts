/**
 * Local-filesystem durable backend.
 *
 * This is the backend every conformance run uses, and the one a developer
 * gets from a `file://` namespace URL. That makes its conditional operations
 * load-bearing rather than a convenience: if they were approximations, every
 * scenario that passes here would prove nothing about the ones that run
 * against a real object store.
 *
 * ## Conditional create
 *
 * `link(2)` is the primitive. It fails with `EEXIST` atomically, so writing to
 * a unique scratch file and then linking it into place is a true create-if-
 * absent — with the full contents already in the file at the moment the name
 * appears. `rename` would have been simpler and wrong: it clobbers.
 *
 * ## Conditional replace
 *
 * POSIX has no compare-and-swap on file contents, and the usual workarounds
 * are worse than the problem. A lock file turns a crash into a stuck object
 * that needs a staleness heuristic to recover; read-compare-rename has the
 * race it is meant to prevent.
 *
 * So the mutable key is stored as a chain of immutable versions with a symlink
 * naming the current one:
 *
 * ```text
 *   head.json                -> symlink to .head-versions/7.json
 *   .head-versions/7.json    immutable
 *   .head-versions/6.json    immutable
 * ```
 *
 * The ETag is the version number. Replacing against ETag `v7` means creating
 * `.head-versions/8.json`, and `link(2)` lets exactly one racer do that — so
 * the `EEXIST` *is* the CAS failure. The symlink is then swapped in with an
 * atomic `rename`. A writer that wins the create and dies before the rename
 * has still legitimately won: a racer reading version 7 will fail to create 8
 * and correctly report `not-replaced`.
 *
 * Version numbers only ever move forward, because creating version N+1
 * requires having read version N, which requires the symlink to already point
 * at it.
 *
 * ## Reading what another binding wrote
 *
 * A fixture produced elsewhere has a plain `head.json` file and no version
 * chain. That reads fine — the ETag is then a content digest — and the first
 * `replaceIfMatch` adopts it into the chain: verify the plain file still
 * hashes to the ETag, create `.head-versions/1.json` exclusively, swap the
 * symlink. Adoption is atomic against other adopters, since only one can win
 * the create. It assumes no *foreign* process is rewriting the plain file at
 * the same moment, which is the same single-writer assumption the protocol
 * already makes.
 *
 * The version chain and scratch directory are dot-prefixed so they cannot
 * collide with a protocol key, and a reader that only understands plain files
 * still sees a correct `head.json` through the symlink.
 */

import { createReadStream } from 'fs'
import { copyFile, link, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { DurableBackendError } from '../errors'
import { sha256Hex } from '../digest'
import { isValidObjectKey } from '../keys'
import type { DurableBackend, GetWithEtag, PutOutcome, ReplaceOutcome } from '../backend'

/** Where the mutable-key version chain lives, relative to the object prefix. */
const VERSIONS_DIR = '.head-versions'
/** Scratch for partially written files, relative to the object prefix. */
const TMP_DIR = '.tmp'

const VERSION_TARGET = /^\.head-versions\/(\d+)\.json$/

function errno(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined
}

export interface LocalBackendOptions {
  /** Absolute directory holding one durable object. Created on demand. */
  root: string
}

export class LocalDurableBackend implements DurableBackend {
  readonly root: string
  readonly describe: string

  constructor(options: LocalBackendOptions) {
    if (!isAbsolute(options.root)) {
      throw new RangeError(`durable: local backend root must be absolute, got ${options.root}`)
    }
    this.root = resolve(options.root)
    this.describe = `file://${this.root}`
  }

  /**
   * Resolve a protocol key to a path inside the object prefix. The key has
   * already been validated on the way out of the head, but this re-checks and
   * then confirms the resolved path really is under the root — a key is the
   * one piece of a head that turns into a filesystem path, so the traversal
   * check belongs at the point where that happens, not only at the point where
   * it was parsed.
   */
  private pathFor(key: string): string {
    if (!isValidObjectKey(key)) {
      throw new DurableBackendError(`durable: refusing to resolve invalid key ${JSON.stringify(key)}`)
    }
    const full = resolve(this.root, key)
    const rel = relative(this.root, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
      throw new DurableBackendError(`durable: key ${JSON.stringify(key)} escapes the object prefix`)
    }
    return full
  }

  private async tmpPath(): Promise<string> {
    const dir = join(this.root, TMP_DIR)
    await mkdir(dir, { recursive: true })
    return join(dir, `${Date.now().toString(36)}-${randomUUID()}`)
  }

  async getBytes(key: string): Promise<Uint8Array | undefined> {
    const target = await this.resolveReadPath(key)
    if (target === undefined) return undefined
    try {
      return await readFile(target)
    } catch (e) {
      if (errno(e) === 'ENOENT') return undefined
      throw new DurableBackendError(`durable: failed to read ${key} from ${this.describe}`, { cause: e })
    }
  }

  async getBytesWithEtag(key: string): Promise<GetWithEtag | undefined> {
    const path = this.pathFor(key)
    const version = await this.currentVersion(path)
    if (version !== undefined) {
      const bytes = await readFile(join(this.root, VERSIONS_DIR, `${version}.json`)).catch((e) => {
        // The symlink names a version that is not there. Nothing in this
        // backend removes a version, so the object has been tampered with.
        throw new DurableBackendError(
          `durable: ${key} points at version ${version}, which is missing from ${this.describe}`,
          { cause: e },
        )
      })
      return { bytes, etag: `v${version}` }
    }
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch (e) {
      if (errno(e) === 'ENOENT') return undefined
      throw new DurableBackendError(`durable: failed to read ${key} from ${this.describe}`, { cause: e })
    }
    return { bytes, etag: `f${sha256Hex(bytes)}` }
  }

  async openReadStream(key: string): Promise<Readable | undefined> {
    const target = await this.resolveReadPath(key)
    if (target === undefined) return undefined
    try {
      await lstat(target)
    } catch (e) {
      if (errno(e) === 'ENOENT') return undefined
      throw new DurableBackendError(`durable: failed to stat ${key} in ${this.describe}`, { cause: e })
    }
    return createReadStream(target)
  }

  async putBytesIfAbsent(key: string, bytes: Uint8Array): Promise<PutOutcome> {
    const dest = this.pathFor(key)
    const tmp = await this.tmpPath()
    await writeFile(tmp, bytes)
    try {
      return await this.linkIntoPlace(tmp, dest)
    } finally {
      await unlink(tmp).catch(() => {})
    }
  }

  async putFileIfAbsent(key: string, localPath: string): Promise<PutOutcome> {
    const dest = this.pathFor(key)
    await mkdir(dirname(dest), { recursive: true })
    // Hard-linking the caller's file avoids copying a multi-gigabyte archive.
    // It is safe because the durable object writes each backup to a fresh
    // unique path and never touches it again; a caller that mutated the source
    // afterwards would be mutating a published object, which the protocol
    // forbids anyway.
    try {
      await link(localPath, dest)
      return 'created'
    } catch (e) {
      const code = errno(e)
      if (code === 'EEXIST') return 'already-exists'
      if (code !== 'EXDEV') {
        throw new DurableBackendError(`durable: failed to publish ${key} to ${this.describe}`, { cause: e })
      }
    }
    // Different filesystem: stage a copy next to the destination, then link.
    const tmp = await this.tmpPath()
    try {
      await copyFile(localPath, tmp)
      return await this.linkIntoPlace(tmp, dest)
    } finally {
      await unlink(tmp).catch(() => {})
    }
  }

  async replaceIfMatch(key: string, bytes: Uint8Array, etag: string): Promise<ReplaceOutcome> {
    const path = this.pathFor(key)
    const versionsDir = join(this.root, VERSIONS_DIR)
    await mkdir(versionsDir, { recursive: true })

    let nextVersion: number
    if (etag.startsWith('v')) {
      const observed = await this.currentVersion(path)
      const claimed = Number(etag.slice(1))
      if (!Number.isSafeInteger(claimed) || claimed < 1) {
        throw new DurableBackendError(`durable: malformed local etag ${JSON.stringify(etag)}`)
      }
      // A stale claim is decided by the exclusive create below, not here; this
      // early exit only avoids pointless work when the chain has clearly moved
      // on or vanished.
      if (observed === undefined) return { status: 'not-replaced' }
      nextVersion = claimed + 1
    } else if (etag.startsWith('f')) {
      const current = await readFile(path).catch((e) => {
        if (errno(e) === 'ENOENT') return undefined
        throw new DurableBackendError(`durable: failed to read ${key} from ${this.describe}`, { cause: e })
      })
      if (current === undefined || `f${sha256Hex(current)}` !== etag) return { status: 'not-replaced' }
      nextVersion = 1
    } else {
      throw new DurableBackendError(`durable: malformed local etag ${JSON.stringify(etag)}`)
    }

    const versionPath = join(versionsDir, `${nextVersion}.json`)
    const tmp = await this.tmpPath()
    await writeFile(tmp, bytes)
    let claimed: PutOutcome
    try {
      claimed = await this.linkIntoPlace(tmp, versionPath)
    } finally {
      await unlink(tmp).catch(() => {})
    }
    if (claimed !== 'created') return { status: 'not-replaced' }

    // The version is published; swapping the pointer is what makes it current.
    const tmpLink = await this.tmpPath()
    try {
      await symlink(`${VERSIONS_DIR}/${nextVersion}.json`, tmpLink)
      await rename(tmpLink, path)
    } catch (e) {
      await unlink(tmpLink).catch(() => {})
      throw new DurableBackendError(
        `durable: created version ${nextVersion} of ${key} but failed to publish the pointer`,
        { cause: e },
      )
    }
    return { status: 'replaced', etag: `v${nextVersion}` }
  }

  /** Path to read `key` from: the pointed-at version, or the key itself. */
  private async resolveReadPath(key: string): Promise<string | undefined> {
    const path = this.pathFor(key)
    const version = await this.currentVersion(path)
    return version === undefined ? path : join(this.root, VERSIONS_DIR, `${version}.json`)
  }

  /** Current chain version for a path, or `undefined` if it is not a chain. */
  private async currentVersion(path: string): Promise<number | undefined> {
    let target: string
    try {
      target = await readlink(path)
    } catch (e) {
      const code = errno(e)
      // EINVAL: a plain file. ENOENT: nothing there yet. Both mean "no chain".
      if (code === 'EINVAL' || code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw new DurableBackendError(`durable: failed to inspect ${path}`, { cause: e })
    }
    const m = VERSION_TARGET.exec(target)
    if (!m) {
      throw new DurableBackendError(
        `durable: ${path} is a symlink to ${JSON.stringify(target)}, which this backend did not write`,
      )
    }
    return Number(m[1])
  }

  private async linkIntoPlace(tmp: string, dest: string): Promise<PutOutcome> {
    await mkdir(dirname(dest), { recursive: true })
    try {
      await link(tmp, dest)
      return 'created'
    } catch (e) {
      if (errno(e) === 'EEXIST') return 'already-exists'
      throw new DurableBackendError(`durable: failed to create ${dest}`, { cause: e })
    }
  }
}
