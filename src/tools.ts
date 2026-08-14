/**
 * Agent tools: CodeGraph integration for DSH.
 *
 * CodeGraph (https://github.com/colbymchenry/codegraph) builds a pre-indexed
 * code knowledge graph stored in `.codegraph/`. These tools shell out to the
 * codegraph CLI and read the generated data, giving the agent fast code
 * navigation without reading every file.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const execFileAsync = promisify(execFile)

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Resolve the codegraph binary — prefer a local install, fall back to npx. */
function resolveCodegraphBin(configured: string): { cmd: string; args: string[] } {
  if (configured.startsWith('npx ')) {
    return { cmd: 'npx', args: ['--yes', configured.slice(4)] }
  }
  return { cmd: configured, args: [] }
}

/** Run one codegraph CLI invocation and return stdout/stderr/exitCode. */
async function runCodegraph(
  configured: string,
  subArgs: string[],
  workdir: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bin = resolveCodegraphBin(configured)
  const fullArgs = [...bin.args, ...subArgs]
  try {
    const { stdout, stderr } = await execFileAsync(bin.cmd, fullArgs, {
      cwd: resolve(workdir),
      maxBuffer: 20 * 1024 * 1024,
      timeout: 300_000,
      signal: signal ?? undefined,
      // Windows ships `.cmd`/`.ps1` shims (npx.cmd, codegraph.cmd) that a bare
      // spawn cannot resolve (ENOENT) — route through the shell on win32, the
      // same approach dsh's own plugin manager uses for pnpm.
      shell: process.platform === 'win32',
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(error),
      exitCode: typeof e.code === 'number' ? e.code : 1,
    }
  }
}

/** Check whether a `.codegraph` directory exists in the given workdir. */
async function graphExists(workdir: string): Promise<boolean> {
  try {
    const s = await stat(join(resolve(workdir), '.codegraph'))
    return s.isDirectory()
  } catch {
    return false
  }
}

/** Read all JSON files from the `.codegraph/` directory. */
async function readGraphFiles(workdir: string): Promise<{ name: string; data: unknown }[]> {
  const dir = join(resolve(workdir), '.codegraph')
  const entries = await readdir(dir)
  const results: { name: string; data: unknown }[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, entry), 'utf-8')
      results.push({ name: entry, data: JSON.parse(raw) })
    } catch {
      // skip unreadable files
    }
  }
  return results
}

/** Gather stats from the graph directory. */
async function gatherGraphStats(workdir: string): Promise<{
  totalFiles: number
  totalSizeBytes: number
  jsonFiles: number
  graphFiles: { name: string; sizeBytes: number }[]
} | null> {
  const dir = join(resolve(workdir), '.codegraph')
  try {
    const entries = await readdir(dir)
    let totalSizeBytes = 0
    let jsonFiles = 0
    const graphFiles: { name: string; sizeBytes: number }[] = []
    for (const entry of entries) {
      const s = await stat(join(dir, entry))
      totalSizeBytes += s.size
      if (entry.endsWith('.json')) {
        jsonFiles++
        graphFiles.push({ name: entry, sizeBytes: s.size })
      }
    }
    return { totalFiles: entries.length, totalSizeBytes, jsonFiles, graphFiles }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*  codegraph_build                                                           */
/* -------------------------------------------------------------------------- */

export function codegraphBuildTool(codegraphPath: string, defaultWorkdir: string) {
  return defineTool({
    name: 'codegraph_build',
    description: 'Build or update the CodeGraph knowledge graph for a project. ' +
      'Analyzes the codebase and creates a graph of code relationships (functions, classes, imports, calls). ' +
      'Run this before querying, and again after significant code changes. ' +
      'Triggers: build graph, update graph, index code, analyze codebase, codegraph.',
    parameters: {
      workdir: {
        type: 'string',
        description: 'Project directory to analyze (default: session working directory).',
      },
      force: {
        type: 'boolean',
        description: 'Force a full rebuild even if a graph already exists (default: false, incremental).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          workdir: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const marker = `[exit code: ${value.exitCode}]`
        const parts = [marker, `workdir: ${value.workdir}`, `duration: ${value.durationMs} ms`]
        if (value.stdout.trim()) parts.push('stdout:\n' + value.stdout.trim())
        if (value.stderr.trim()) parts.push('stderr:\n' + value.stderr.trim())
        if (value.error) parts.push('error: ' + value.error)
        return text(parts.join('\n'))
      },
    },
    async execute(args, exec) {
      const workdir = args.workdir || defaultWorkdir
      // CLI v1.5+ renamed `build` to `sync` (incremental) / `index` (full rebuild).
      const subArgs = args.force ? ['index'] : ['sync']
      if (args.force) subArgs.push('--force')

      const start = Date.now()
      const result = await runCodegraph(codegraphPath, subArgs, workdir, exec.signal)
      const durationMs = Date.now() - start

      return {
        success: result.exitCode === 0,
        workdir: resolve(workdir),
        durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...(result.exitCode !== 0 ? { error: 'codegraph build failed' } : {}),
      }
    },
  })
}

/* -------------------------------------------------------------------------- */
/*  codegraph_query                                                           */
/* -------------------------------------------------------------------------- */

export function codegraphQueryTool(codegraphPath: string, defaultWorkdir: string) {
  return defineTool({
    name: 'codegraph_query',
    description: 'Query the CodeGraph knowledge graph to find code symbols, relationships, and dependencies. ' +
      'Use this to understand code structure, find related files, trace call chains, or locate definitions. ' +
      'Faster than reading every file — the graph is pre-indexed. ' +
      'Triggers: query graph, find dependencies, trace calls, search code relationships, codegraph search.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Symbol name, file path, or pattern to search for in the graph.',
      },
      workdir: {
        type: 'string',
        description: 'Project directory containing the .codegraph/ data (default: session working directory).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results to return (default: 50).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          query: { type: 'string', required: true },
          matchCount: { type: 'integer', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                file: { type: 'string', required: true },
                line: { type: 'integer' },
                references: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.success) return text(`query failed: ${value.error ?? 'unknown error'}`)
        if (value.matchCount === 0) return text(`no matches for "${value.query}"`)
        const lines = [`found ${value.matchCount} match(es) for "${value.query}":\n`]
        for (const m of value.matches) {
          const loc = m.line !== undefined ? `${m.file}:${m.line}` : m.file
          lines.push(`[${m.kind}] ${m.name}  (${loc})  source: ${m.source}`)
          if (m.references && m.references.length > 0) {
            lines.push(`  refs: ${m.references.join(', ')}`)
          }
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const workdir = args.workdir || defaultWorkdir

      // Check if graph exists first
      const exists = await graphExists(workdir)
      if (!exists) {
        return {
          success: false,
          query: args.query,
          matchCount: 0,
          matches: [],
          error: 'No .codegraph/ directory found. Run codegraph_build first.',
        }
      }

      // Try CLI query
      const subArgs = ['query', args.query]
      if (args.limit) subArgs.push('--limit', String(args.limit))
      const result = await runCodegraph(codegraphPath, subArgs, workdir)

      if (result.exitCode === 0 && result.stdout.trim()) {
        try {
          const parsed = JSON.parse(result.stdout)
          const matches = Array.isArray(parsed) ? parsed : (parsed.results ?? parsed.matches ?? [])
          return {
            success: true,
            query: args.query,
            matchCount: matches.length,
            matches: matches.slice(0, args.limit ?? 50).map((m: Record<string, unknown>) => ({
              source: String(m.source ?? m.file ?? 'unknown'),
              name: String(m.name ?? m.symbol ?? ''),
              kind: String(m.kind ?? m.type ?? 'symbol'),
              file: String(m.file ?? ''),
              ...(typeof m.line === 'number' ? { line: m.line } : {}),
              ...(Array.isArray(m.references) ? { references: m.references.map(String) } : {}),
            })),
          }
        } catch {
          // Not JSON — fall through to file-based search
        }
      }

      // Fallback: search the graph JSON files directly
      const graphData = await readGraphFiles(workdir)
      const queryLower = args.query.toLowerCase()
      const matches: Array<{
        source: string
        name: string
        kind: string
        file: string
        line?: number
        references?: string[]
      }> = []
      const limit = args.limit ?? 50

      for (const { name: fileName, data } of graphData) {
        if (matches.length >= limit) break
        searchGraph(data, queryLower, fileName, matches, limit)
      }

      return {
        success: true,
        query: args.query,
        matchCount: matches.length,
        matches: matches.slice(0, limit),
      }
    },
  })
}

/** Recursively search graph JSON for matches. */
function searchGraph(
  node: unknown,
  query: string,
  source: string,
  matches: Array<{
    source: string
    name: string
    kind: string
    file: string
    line?: number
    references?: string[]
  }>,
  limit: number,
): void {
  if (matches.length >= limit) return
  if (node === null || node === undefined) return

  if (Array.isArray(node)) {
    for (const item of node) {
      if (matches.length >= limit) return
      searchGraph(item, query, source, matches, limit)
    }
    return
  }

  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    const name = String(obj.name ?? obj.symbol ?? obj.id ?? '')
    const file = String(obj.file ?? obj.path ?? obj.location ?? '')
    const kind = String(obj.kind ?? obj.type ?? obj.nodeType ?? 'symbol')

    if (name.toLowerCase().includes(query) || file.toLowerCase().includes(query)) {
      matches.push({
        source,
        name: name || '(unnamed)',
        kind,
        file: file || '(unknown)',
        ...(typeof obj.line === 'number' ? { line: obj.line } : {}),
        ...(Array.isArray(obj.references) ? { references: obj.references.map(String) } : {}),
        ...(Array.isArray(obj.calls) ? { references: obj.calls.map(String) } : {}),
      })
    }

    for (const value of Object.values(obj)) {
      if (matches.length >= limit) return
      if (typeof value === 'object' && value !== null) {
        searchGraph(value, query, source, matches, limit)
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  codegraph_status                                                          */
/* -------------------------------------------------------------------------- */

export function codegraphStatusTool(codegraphPath: string, defaultWorkdir: string) {
  return defineTool({
    name: 'codegraph_status',
    description: 'Check the status of the CodeGraph knowledge graph: whether it exists, file count, size, and contents. ' +
      'Use this to verify the graph is built and see summary information. ' +
      'Triggers: check graph status, graph info, graph statistics, codegraph status.',
    parameters: {
      workdir: {
        type: 'string',
        description: 'Project directory to check (default: session working directory).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exists: { type: 'boolean', required: true },
          workdir: { type: 'string', required: true },
          totalFiles: { type: 'integer' },
          jsonFiles: { type: 'integer' },
          totalSizeBytes: { type: 'integer' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                sizeBytes: { type: 'integer', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.exists) {
          return text(`no codegraph found in ${value.workdir}\nRun codegraph_build to create one.`)
        }
        const parts = [
          `codegraph status for ${value.workdir}:`,
          `  files: ${value.totalFiles ?? 0} (${value.jsonFiles ?? 0} JSON)`,
          `  size: ${((value.totalSizeBytes ?? 0) / 1024).toFixed(1)} KB`,
        ]
        if (value.files && value.files.length > 0) {
          parts.push('  contents:')
          for (const f of value.files) {
            parts.push(`    ${f.name} (${(f.sizeBytes / 1024).toFixed(1)} KB)`)
          }
        }
        return text(parts.join('\n'))
      },
    },
    async execute(args) {
      const workdir = args.workdir || defaultWorkdir
      const exists = await graphExists(workdir)

      if (!exists) {
        return {
          exists: false,
          workdir: resolve(workdir),
          error: 'No .codegraph/ directory found',
        }
      }

      const stats = await gatherGraphStats(workdir)
      return {
        exists: true,
        workdir: resolve(workdir),
        totalFiles: stats?.totalFiles ?? 0,
        jsonFiles: stats?.jsonFiles ?? 0,
        totalSizeBytes: stats?.totalSizeBytes ?? 0,
        files: stats?.graphFiles ?? [],
      }
    },
  })
}