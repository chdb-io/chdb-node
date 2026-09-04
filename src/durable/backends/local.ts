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
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
} from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { DurableBackendError } from '../errors'
import { sha256Hex } from '../digest'
import { isValidObjectKey } from '../keys'
import type { DurableBackend, GetWithEtag, PutOutcome, ReplaceOutcome } from '../backend'

/**
 * Where the mutable-key version chain lives, relative to the object prefix.
 *
 * One directory, because V1 has exactly one mutable key. Everything else in an
 * object is immutable and never enters the chain — which is also why
 * {@link LocalDurableBackend.currentVersion} must not consult this directory
 * for a key that is not a chain: it is not per-key.
 */
const VERSIONS_DIR = '.head-versions'
/** Scratch for partially written files, relative to the object prefix. */
const TMP_DIR = '.tmp'

const VERSION_TARGET = /^\.head-versions\/(\d+)\.json$/

function errno(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined
}

/**
 * Write a file and make it survive power loss before returning.
 *
 * `writeFile` alone does not: it returns once the data reaches the page cache,
 * so a crash can lose bytes the caller has already been told were written. For
 * a version file that is about to be reported as a committed head, that is the
 * difference between a durable object and one that quietly rolls back.
 */
async function writeFileDurably(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Flush a file's contents, addressed by path rather than by an open handle. */
async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Flush a directory entry, so a create or rename inside it survives too.
 *
 * Syncing a file persists its contents; the *name* lives in the parent
 * directory and needs its own barrier. Best-effort on platforms that refuse to
 * open a directory for this, where the guarantee is simply not available.
 */
async function fsyncDir(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return
  }
  try {
    await handle.sync()
  } catch {
    /* not supported here; nothing further to do */
  } finally {
    await handle.close()
  }
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
    await writeFileDurably(tmp, bytes)
    try {
      return await this.linkIntoPlace(tmp, dest)
    } finally {
      await unlink(tmp).catch(() => {})
    }
  }

  async putFileIfAbsent(key: string, localPath: string): Promise<PutOutcome> {
    const dest = this.pathFor(key)
    // Hard-linking the caller's file avoids copying a multi-gigabyte archive.
    // It is safe because the durable object writes each backup to a fresh
    // unique path and never touches it again; a caller that mutated the source
    // afterwards would be mutating a published object, which the protocol
    // forbids anyway.
    try {
      return await this.linkIntoPlace(localPath, dest)
    } catch (e) {
      if (errno((e as { cause?: unknown }).cause ?? e) !== 'EXDEV') throw e
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
      const claimed = Number(etag.slice(1))
      if (!Number.isSafeInteger(claimed) || claimed < 1) {
        throw new DurableBackendError(`durable: malformed local etag ${JSON.stringify(etag)}`)
      }
      const observed = await this.currentVersion(path)
      if (observed === undefined) return { status: 'not-replaced' }
      // The token must name the version that is current, not merely one that
      // exists. Leaving this to the exclusive create below is not equivalent:
      // a token above the current version would create a version nobody has
      // read, skip the one in between, and publish it — a compare-and-swap
      // succeeding against a value that was never there.
      if (observed !== claimed) return { status: 'not-replaced' }
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
    await writeFileDurably(tmp, bytes)
    let claimed: PutOutcome
    try {
      claimed = await this.linkIntoPlace(tmp, versionPath)
    } finally {
      await unlink(tmp).catch(() => {})
    }

    if (claimed !== 'created') {
      // Someone already won this version number. That someone may have been an
      // earlier attempt of ours whose response was lost, so the bytes decide:
      // identical content means our write is the one that landed, different
      // content means a racer won it. Either way the pointer is advanced,
      // because the version is published whether or not its author survived
      // long enough to say so.
      const existing = await readFile(versionPath).catch((e) => {
        throw new DurableBackendError(
          `durable: version ${nextVersion} of ${key} exists but cannot be read`,
          { cause: e },
        )
      })
      await this.publishPointer(path, nextVersion)
      return Buffer.from(bytes).equals(existing)
        ? { status: 'replaced', etag: `v${nextVersion}` }
        : { status: 'not-replaced' }
    }

    // The version is published; swapping the pointer is what makes it current.
    try {
      await this.publishPointer(path, nextVersion)
    } catch (e) {
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

  /**
   * Current chain version for a path, or `undefined` if it is not a chain.
   *
   * The pointer is a hint, not the authority. Creating a version and swapping
   * the symlink are two syscalls, and a process that dies between them leaves
   * a version nothing points at. Trusting the symlink alone would wedge the
   * object permanently: every later writer would hold the pointed-at token,
   * fail to create the version above it because the orphan is already there,
   * and report `not-replaced` forever.
   *
   * So the authority is the highest version that actually exists, found by
   * stepping forward from the pointer. That costs one `stat` in the normal
   * case, where nothing is above it, and it is bounded because each step
   * requires a version file that some writer won an exclusive create for.
   *
   * The pointer is repaired opportunistically. Failing to repair it is
   * harmless — the next reader recomputes the same answer.
   */
  private async currentVersion(path: string): Promise<number | undefined> {
    let start: number
    try {
      const target = await readlink(path)
      const m = VERSION_TARGET.exec(target)
      if (!m) {
        throw new DurableBackendError(
          `durable: ${path} is a symlink to ${JSON.stringify(target)}, which this backend did not write`,
        )
      }
      start = Number(m[1])
    } catch (e) {
      if (e instanceof DurableBackendError) throw e
      const code = errno(e)
      // EINVAL: a plain file. ENOENT: nothing there yet. Either way there is
      // no chain for this key, and there must be no look-ahead: this method
      // serves every key, and the version directory belongs to the one mutable
      // key. Probing it for a WAL segment or a checkpoint would resolve that
      // key's read to the head's bytes.
      //
      // An adoption that created version 1 and died before the swap needs no
      // special case here. The plain file still reads, its digest is still the
      // ETag, and the next replaceIfMatch meets the existing version 1 through
      // the conditional-create path below, which compares content and
      // publishes the pointer.
      if (code !== 'EINVAL' && code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new DurableBackendError(`durable: failed to inspect ${path}`, { cause: e })
      }
      return undefined
    }

    let latest = start
    while (await this.versionExists(latest + 1)) latest++
    if (latest !== start) await this.publishPointer(path, latest).catch(() => {})
    return latest
  }

  private async versionExists(version: number): Promise<boolean> {
    try {
      await lstat(join(this.root, VERSIONS_DIR, `${version}.json`))
      return true
    } catch {
      return false
    }
  }

  /** Point the mutable key at a version. Atomic, and idempotent across racers. */
  private async publishPointer(path: string, version: number): Promise<void> {
    const tmpLink = await this.tmpPath()
    try {
      await symlink(`${VERSIONS_DIR}/${version}.json`, tmpLink)
      await rename(tmpLink, path)
      await fsyncDir(dirname(path))
    } catch (e) {
      await unlink(tmpLink).catch(() => {})
      throw e
    }
  }

  /**
   * The one way an object becomes visible under this root.
   *
   * Both durability barriers live here rather than at the call sites, and that
   * placement is the point. Publishing needs the contents flushed *and* the
   * directory entry flushed, and three separate paths reach this operation —
   * bytes staged into a temp file, a same-filesystem hard link, and a
   * cross-filesystem copy. Barriers added per path were missed twice, once on
   * each of the latter two, and the second miss was on the path a checkpoint
   * actually takes. A caller cannot forget what it does not perform.
   *
   * Re-flushing a source that is already durable costs a no-op syscall, which
   * is the right price for not having to reason about which callers did it.
   */
  private async linkIntoPlace(source: string, dest: string): Promise<PutOutcome> {
    await mkdir(dirname(dest), { recursive: true })
    await this.assertRealDirectory(dirname(dest))
    await fsyncFile(source)
    try {
      await link(source, dest)
    } catch (e) {
      if (errno(e) === 'EEXIST') return 'already-exists'
      throw new DurableBackendError(`durable: failed to create ${dest}`, { cause: e })
    }
    // The name is what makes the object visible, and the name lives in the
    // directory. An object reported as published has to still be there after a
    // crash, or a head will reference bytes that no longer exist.
    await fsyncDir(dirname(dest))
    return 'created'
  }

  /**
   * Refuse to operate through a directory that is a symlink.
   *
   * `pathFor` resolves lexically, which cannot see that `<root>/checkpoints`
   * is a link to somewhere else entirely — a valid-looking key would then read
   * or publish outside the object prefix with this process's privileges.
   *
   * This is defence in depth rather than a complete answer. Whoever can plant
   * that link can usually write the object directly, and a check followed by a
   * use is never perfectly atomic without `openat`, which Node does not
   * expose. What it does buy is that a link planted once, in a shared parent
   * such as a temp directory, does not silently redirect every later
   * operation.
   */
  private async assertRealDirectory(dir: string): Promise<void> {
    if (dir === this.root) return
    const st = await lstat(dir).catch(() => undefined)
    if (st?.isSymbolicLink()) {
      throw new DurableBackendError(
        `durable: refusing to use ${dir}, which is a symlink; an object prefix must contain ` +
          `only real directories`,
      )
    }
  }
}
