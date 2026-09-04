/**
 * Namespaces: the entry point to the durable control plane.
 *
 * A namespace is a URL plus an engine factory. The URL says where objects
 * live and, through its scheme, which backend implements the conditional
 * operations; the factory says how to bring up an engine for whichever object
 * is being opened.
 *
 * Backends are looked up in a registry rather than imported here on purpose.
 * V1 ships with the local filesystem backend, and a cloud provider arrives as
 * its own module that registers a scheme — so importing `chdb/durable` never
 * drags in an object-storage SDK, and a provider can be added without this
 * file changing.
 *
 * One constraint is not the namespace's to hide: chdb-core binds one data path
 * per process, so one process can hold one open durable object at a time.
 * `scan`-style fan-out therefore has to be sequential, or spread across worker
 * processes. A registry here that pretended otherwise would just move the
 * failure somewhere less obvious (contract §3.6).
 */

import { isAbsolute, join } from 'path'
import { fileURLToPath } from 'url'
import type { BackendFactory, DurableBackend } from './backend'
import { LocalDurableBackend } from './backends/local'
import type { EngineFactory } from './engine-adapter'
import { objectPrefix } from './keys'
import { DurableObject, type DurableOpenOptions, type DurableTuning } from './object'

/** Builds a backend for one object, given the namespace URL and the object id. */
export type BackendSchemeFactory = (url: URL, objectId: string) => Promise<DurableBackend> | DurableBackend

const SCHEMES = new Map<string, BackendSchemeFactory>()

/**
 * Schemes this package ships but does not register until their module is
 * imported. Getting "no backend for s3" when the S3 backend is right there is
 * a confusing five minutes, so the error says which import is missing rather
 * than only which schemes are present.
 */
const SHIPPED_BUT_UNIMPORTED: Readonly<Record<string, string>> = {
  s3: 'chdb/durable/s3',
}

function hintFor(scheme: string): string {
  const subpath = SHIPPED_BUT_UNIMPORTED[scheme]
  return subpath
    ? ` This package ships one — add \`import '${subpath}'\` to register it.`
    : ' Register others with registerBackendScheme().'
}

/**
 * Register a backend for a URL scheme, e.g. `s3`. Provider packages call this
 * on import; the durable core stays free of their dependencies.
 */
export function registerBackendScheme(scheme: string, factory: BackendSchemeFactory): void {
  SCHEMES.set(scheme.replace(/:$/, ''), factory)
}

registerBackendScheme('file', (url, objectId) => {
  const root = fileURLToPath(url)
  if (!isAbsolute(root)) {
    throw new RangeError(`durable: file namespace must be an absolute path, got ${url.href}`)
  }
  return new LocalDurableBackend({ root: join(root, objectId) })
})

export interface DurableNamespaceOptions {
  /** How to build the engine for an object being opened. Required. */
  engineFactory: EngineFactory
  /**
   * Bypass scheme lookup and supply the backend directly. Conformance suites
   * use this to wrap a real backend in fault injection.
   */
  backendFactory?: BackendFactory
  /** Default writer name for objects opened from this namespace. */
  owner?: string
  /** Default parent directory for scratch trees. */
  scratchRoot?: string
  /** Default lease and commit tuning. */
  tuning?: Partial<DurableTuning>
}

export class DurableNamespace {
  readonly url: URL
  private readonly options: DurableNamespaceOptions

  constructor(url: string | URL, options: DurableNamespaceOptions) {
    this.url = typeof url === 'string' ? new URL(url) : url
    if (!options?.engineFactory) {
      throw new TypeError('durable: DurableNamespace requires an engineFactory')
    }
    const scheme = this.url.protocol.replace(/:$/, '')
    if (!options.backendFactory && !SCHEMES.has(scheme)) {
      throw new RangeError(
        `durable: no backend registered for scheme ${JSON.stringify(scheme)}. ` +
          `Registered: ${[...SCHEMES.keys()].join(', ')}.${hintFor(scheme)}`,
      )
    }
    this.options = options
  }

  /**
   * Open one object. Writer by default; pass `readOnly` for a snapshot handle
   * that takes no lease, or `force` to take an unexpired lease from a writer
   * that is presumed dead.
   */
  async open(objectId: string, openOptions: DurableOpenOptions = {}): Promise<DurableObject> {
    const id = objectPrefix(objectId)
    const backend = this.options.backendFactory
      ? await this.options.backendFactory(id)
      : await (SCHEMES.get(this.url.protocol.replace(/:$/, '')) as BackendSchemeFactory)(this.url, id)

    const merged: DurableOpenOptions = {
      ...openOptions,
      owner: openOptions.owner ?? this.options.owner,
      scratchRoot: openOptions.scratchRoot ?? this.options.scratchRoot,
      tuning: { ...this.options.tuning, ...openOptions.tuning },
    }
    return DurableObject.open({ id, backend, engineFactory: this.options.engineFactory }, merged)
  }
}
