#!/usr/bin/env node
/**
 * CORS front for alto on the LOCAL e2e stack. Dependency-free (node:http only).
 *
 * WHY. The SPA at http://localhost:5173 talks to the bundler from the browser, so every JSON-RPC
 * POST is cross-origin and the browser sends an OPTIONS preflight first. alto answers that with
 * `Route OPTIONS:/ not found` and no CORS headers — measured on the first full-stack run, where
 * not one eth_sendUserOperation ever reached the bundler and every UserOp-dependent spec timed
 * out. Production never sees this because alto sits behind nginx
 * (services/alto-bundler/nginx/bundler.conf.template), which answers the preflight itself and
 * stamps Access-Control-Allow-Origin on the proxied response. This is that nginx role, in the
 * 40 lines CI needs — same three headers, same "answer OPTIONS here, never forward it" rule.
 *
 *   ALTO_PROXY_PORT (default 4337)   what the SPA and wait-for-stack.js address
 *   ALTO_UPSTREAM   (default http://127.0.0.1:4338)   where alto actually listens
 *   ALTO_PROXY_ORIGIN (default http://localhost:5173) the one origin allowed
 */
const http = require('node:http')

const PORT = Number(process.env.ALTO_PROXY_PORT || 4337)
const UPSTREAM = new URL(process.env.ALTO_UPSTREAM || 'http://127.0.0.1:4338')
const ORIGIN = process.env.ALTO_PROXY_ORIGIN || 'http://localhost:5173'

function cors(res, reqOrigin) {
  // Echo the origin only when it is the allow-listed one; otherwise omit the header, exactly as
  // the nginx map does — a wildcard would grant every page on the runner a bundler.
  if (reqOrigin === ORIGIN) res.setHeader('Access-Control-Allow-Origin', ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Max-Age', '600')
  res.setHeader('Vary', 'Origin')
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin
  if (req.method === 'OPTIONS') {
    cors(res, origin)
    res.writeHead(204)
    res.end()
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const up = http.request(
      {
        hostname: UPSTREAM.hostname,
        port: Number(UPSTREAM.port || 80),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: UPSTREAM.host, 'content-length': body.length },
      },
      (upRes) => {
        cors(res, origin)
        res.writeHead(upRes.statusCode || 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    up.on('error', (err) => {
      cors(res, origin)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: `alto upstream unreachable: ${err.message}` } }))
    })
    up.end(body)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`alto CORS proxy: 127.0.0.1:${PORT} -> ${UPSTREAM.origin} (origin ${ORIGIN})`)
})
