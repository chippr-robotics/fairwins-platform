/** A minimal `fetch` Response double — status, headers, JSON body. Shared by the assistant lib tests. */
export function response(status, body = null, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return body
    },
    text: async () => (body == null ? '' : JSON.stringify(body)),
  }
}

/** A fetch that never resolves until aborted — for timeout paths. */
export function hangingFetch() {
  return (_url, { signal } = {}) =>
    new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (signal?.aborted) abort()
      else signal?.addEventListener?.('abort', abort)
    })
}
