/**
 * The MCP server's vendored tool table ⇔ `@fairwins/assistant-contract` (spec 104, research § 8.3).
 *
 * The MCP server may take no dependency and sits outside the npm workspace (spec 095 R4), so it
 * ships a COPY of `TOOL_DEFS` as `services/mcp-server/src/toolDefs.snapshot.json`. A copy drifts
 * — that is what copies do — and a drift here means the in-app assistant and an external agent are
 * shown two different tables for the same gateway. This test is the whole of the guarantee that
 * they are one table: deep-equal, both directions. Re-vendor with
 *
 *   node --input-type=module -e 'import { TOOL_DEFS } from "./packages/assistant-contract/src/tools.js";
 *     import { writeFileSync } from "node:fs";
 *     writeFileSync("services/mcp-server/src/toolDefs.snapshot.json", JSON.stringify(TOOL_DEFS, null, 2) + "\n")'
 *
 * Two smaller pairings ride along: the MCP server's `ROUTE_PATHS` (its own id → path map, since it
 * cannot read `contract.js`) against the gateway's ROUTES, and the honest-failure sentence, which
 * the package restates verbatim from the server's `failed()`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { TOOL_DEFS } from '@fairwins/assistant-contract/tools'
import { UNKNOWN_NOT_EMPTY } from '@fairwins/assistant-contract/results'
import { ROUTES, routeOf } from '../src/memberApi/contract.js'
import { ROUTE_PATHS, TOOL_SNAPSHOT } from '../../mcp-server/src/tools.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MCP_SRC = path.join(here, '..', '..', 'mcp-server', 'src')

/** JSON round-trip: the package's table is frozen objects, the snapshot is parsed JSON. */
const plain = (v) => JSON.parse(JSON.stringify(v))

describe('toolDefs.snapshot.json == @fairwins/assistant-contract TOOL_DEFS', () => {
  it('is byte-for-byte the serialised package table (re-vendor when this fails)', () => {
    const onDisk = readFileSync(path.join(MCP_SRC, 'toolDefs.snapshot.json'), 'utf8')
    expect(onDisk).toBe(JSON.stringify(TOOL_DEFS, null, 2) + '\n')
  })

  it('deep-equals in both directions — no tool missing from either side', () => {
    expect(plain(TOOL_SNAPSHOT)).toEqual(plain(TOOL_DEFS))
    const pkgNames = TOOL_DEFS.map((t) => t.name)
    const snapNames = TOOL_SNAPSHOT.map((t) => t.name)
    expect(snapNames).toEqual(pkgNames)
    for (const t of TOOL_DEFS) expect(plain(TOOL_SNAPSHOT.find((s) => s.name === t.name))).toEqual(plain(t))
    for (const s of TOOL_SNAPSHOT) expect(plain(TOOL_DEFS.find((t) => t.name === s.name))).toEqual(plain(s))
  })

  it('is what the MCP server actually loads — the module reads the file, not a copy of the copy', () => {
    const source = readFileSync(path.join(MCP_SRC, 'tools.js'), 'utf8')
    expect(source).toMatch(/toolDefs\.snapshot\.json/)
    // And it never IMPORTS the package (the header may name it): the server stays dependency-free.
    expect(source).not.toMatch(/^\s*import\b.*@fairwins\//m)
    expect(source).not.toMatch(/^\s*import\b.*\.\.\/\.\.\/(packages|relay-gateway|frontend)/m)
  })
})

describe('the MCP server’s route map == contract.js ROUTES', () => {
  it('maps every route id the snapshot names to the gateway’s own path', () => {
    for (const def of TOOL_SNAPSHOT.filter((d) => d.exec.kind === 'route')) {
      expect(ROUTE_PATHS[def.exec.route], `${def.name}: route "${def.exec.route}" unmapped on the MCP server`).toBe(routeOf(def.exec.route).path)
    }
  })

  it('names only ids that exist, and every path it states is the gateway’s', () => {
    for (const [id, p] of Object.entries(ROUTE_PATHS)) {
      expect(ROUTES.some((r) => r.id === id), `ROUTE_PATHS.${id} is not a contract.js route id`).toBe(true)
      expect(p).toBe(routeOf(id).path)
    }
  })
})

describe('the honest-failure sentence is one sentence', () => {
  it('appears verbatim in the MCP server’s failed()', () => {
    const source = readFileSync(path.join(MCP_SRC, 'tools.js'), 'utf8')
    // The server builds it from two string literals; compare after collapsing the concatenation.
    const collapsed = source.replace(/'\s*\+\s*'/g, '')
    expect(collapsed).toContain(UNKNOWN_NOT_EMPTY)
  })
})
