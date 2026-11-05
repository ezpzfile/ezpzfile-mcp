/**
 * The design engines' command catalogues as MCP resources:
 *   ezpzfile://commands/vector/<word>   VectorCraft commands whose id or label contains <word>
 *   ezpzfile://commands/photo/<word>    PhotoCraft commands likewise
 * The whole catalogue is 300 KB a piece, too much to put in context; a word narrows it
 * ("text", "export", "layer", "align", "filter"). "all" lists every id with its label.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { photo, vec } from './designEngine'

interface Cmd {
  id: string
  label?: string
  params?: string
  menu?: string[]
}

const cache = new Map<string, Cmd[]>()

async function catalogue(engine: 'vector' | 'photo'): Promise<Cmd[]> {
  const hit = cache.get(engine)
  if (hit) return hit
  let list: Cmd[]
  if (engine === 'vector') {
    const r = (await vec('list_commands', {})).json as { commands?: Cmd[] } | Cmd[]
    list = Array.isArray(r) ? r : (r.commands ?? [])
  } else {
    const r = (await photo('engine.commands', {})) as { commands?: Cmd[] } | Cmd[]
    list = Array.isArray(r) ? r : (r.commands ?? [])
  }
  cache.set(engine, list)
  return list
}

export function registerCommandResources(server: McpServer): void {
  server.registerResource(
    'engine-commands',
    new ResourceTemplate('ezpzfile://commands/{engine}/{word}', { list: undefined }),
    {
      title: 'Design engine commands',
      description: 'Commands doc_edit op "command" can run on AI/EPS/SVG (engine vector) or PSD (engine photo), filtered by a word, e.g. ezpzfile://commands/vector/text',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const engine = String(vars.engine) === 'photo' ? 'photo' : 'vector'
      const word = decodeURIComponent(String(vars.word ?? 'all')).toLowerCase()
      const all = await catalogue(engine)
      const hits = word === 'all' ? all.map((c) => ({ id: c.id, label: c.label })) : all.filter((c) => `${c.id} ${c.label ?? ''} ${(c.menu ?? []).join(' ')}`.toLowerCase().includes(word)).map((c) => ({ id: c.id, label: c.label, params: c.params }))
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(hits, null, 1) }] }
    },
  )
}
