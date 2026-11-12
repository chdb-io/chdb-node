# Node native Arrow: threads and ownership

Direct Arrow input bridges a JS iterator and core's synchronous C Stream
consumer. The addon keeps JS buffers alive, exposes C Data descriptors, and
uses a native queue so a core worker never calls the JS iterator. Output
fetches run as libuv tasks over one stream handle. A task may reuse a worker
thread; a batch does not get a dedicated thread.

Time runs downward; columns represent execution domains:

```mermaid
sequenceDiagram
    participant JS as JS event loop
    participant Bridge as N-API bridge + bounded queue
    participant Worker as libuv worker / chdb-core

    Note over JS,Worker: Input: RecordBatch reader -> arrowstream()
    JS->>JS: await first batch; determine schema
    JS->>Bridge: register C Stream, pin JS buffers, enqueue first batch
    Bridge-->>JS: return name and close handle
    JS->>Worker: queryAsync(SQL using arrowstream(name))
    par Producer on JS event loop
      loop later batches
        JS->>Bridge: await enqueue(batch); wait if queue is full
      end
    and Consumer on query worker
      loop while SQL needs input
        Worker->>Bridge: get_next() waits, then dequeues C Data
        Bridge-->>Worker: batch descriptor
        Worker->>Bridge: C release callback (may run off JS thread)
        Bridge-->>JS: thread-safe notification; release N-API refs
      end
    end
    Worker-->>JS: query settles (result or error)
    JS->>Bridge: await handle.close(); cancel/unregister after active scan

    Note over JS,Worker: Output: SQL -> RecordBatch reader
    JS->>Bridge: queryArrowStream(SQL) creates one stream handle
    loop each awaited reader.next()
      JS->>Bridge: request next batch
      Bridge->>Worker: queue AsyncWorker fetch task
      Worker->>Worker: chdb_stream_fetch_arrow(handle)
      Worker->>Worker: copy buffers; call C release
      Worker-->>JS: resolve as JS RecordBatch
    end
    JS->>Bridge: reader.cancel() or iteration ends
    Bridge->>Worker: wait for in-flight fetch, then destroy handle
```

The queue admits at most two **not-yet-delivered** batches and one waiting
producer request. It applies backpressure to JS production, not to batches
that core has already dequeued and retained (for example, for sorting).
Closing during a scan defers unregister and input release until query cleanup;
the thread-safe callback releases JS-owned references on their isolate. On
output, the copy precedes C release, so a returned batch outlives the native
result. See the [user guide](../arrow.md) and [conformance scope](../arrow-rc3-conformance.md).
