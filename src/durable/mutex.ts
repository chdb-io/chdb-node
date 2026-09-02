/**
 * Operation serialization (contract §5.3).
 *
 * The contract requires an explicit queue and forbids leaning on "the runtime
 * is single-threaded" or "the native call happens to be synchronous" as the
 * serialization argument. Both are true today and neither is a guarantee: the
 * moment any step awaits provider I/O, another operation can interleave, and
 * the state machine's invariants are exactly the things that break when it
 * does.
 *
 * A durable object uses two of these rather than one, and the split is the
 * interesting part.
 *
 *  - The **operation** mutex covers a whole logical operation: execute, query,
 *    flush, checkpoint, close. Holding it for the duration of a checkpoint is
 *    what stops new writes landing in a database that is being archived.
 *  - The **head** mutex covers a single compare-and-swap against `head.json`.
 *
 * If one mutex covered both, a checkpoint of a large database would block
 * heartbeat for the whole backup and upload, and the writer would fence itself
 * out of an object it was in the middle of legitimately checkpointing. With
 * the split, heartbeat only ever contends for the head mutex, which is held
 * for a single conditional write — while the checkpoint's own final commit
 * takes that same mutex and therefore sees the ETag heartbeat just produced.
 */

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  private sealedReason: (() => Error) | undefined
  private depth = 0

  /** True while an operation holds the mutex or is queued behind one. */
  get busy(): boolean {
    return this.depth > 0
  }

  /**
   * Run `fn` with exclusive access. Rejections propagate to the caller and do
   * not poison the queue — the next waiter runs regardless, because a failed
   * flush must not wedge the close that has to report it.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.sealedReason) throw this.sealedReason()
    this.depth++
    const prior = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => {
      release = r
    })
    await prior.catch(() => {})
    try {
      return await fn()
    } finally {
      this.depth--
      release()
    }
  }

  /**
   * Stop accepting new work, then wait for what is already queued. Used by
   * close: the drain has to happen before the durability barrier, and new
   * callers have to be turned away rather than silently queued behind a
   * close they will never come back from.
   */
  async sealAndDrain(reason: () => Error): Promise<void> {
    this.sealedReason = reason
    await this.tail.catch(() => {})
  }

  /**
   * Run `fn` even though the mutex is sealed. Close itself needs this: it
   * seals the queue against everyone else and then still has to do its own
   * work in the same serialized position.
   */
  async runSealed<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => {
      release = r
    })
    await prior.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
