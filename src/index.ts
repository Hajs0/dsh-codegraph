/**
 * dsh-codegraph — CodeGraph integration for DSH
 * 
 * Provides agent tools to interact with CodeGraph (https://github.com/colbymchenry/codegraph):
 * - codegraph_build: Build or update the code knowledge graph
 * - codegraph_query: Query the graph for code relationships
 * - codegraph_status: Check graph status and statistics
 * 
 * CodeGraph creates a pre-indexed knowledge graph of your codebase,
 * enabling faster code exploration with fewer tokens and tool calls.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { codegraphBuildTool, codegraphQueryTool, codegraphStatusTool } from './tools'

/** Plugin name */
export const name = 'codegraph'

/** Services required */
export const inject = ['tools', 'systemPrompt']

/** Plugin config */
export interface Config {
  /** Enable/disable the plugin */
  enabled?: boolean
  /** Announce to agent via system prompt */
  announceToAgent?: boolean
  /** Path to codegraph binary (default: npx @colbymchenry/codegraph) */
  codegraphPath?: string
  /** Default working directory for codegraph operations */
  defaultWorkdir?: string
}

/** System prompt announcement */
export const CODEGRAPH_GUIDANCE = `本机已安装 dsh-codegraph 插件（CodeGraph 代码知识图谱）：提供代码库预索引能力，生成代码关系图谱，帮助 AI 更高效理解代码结构。工具：codegraph_build 构建/更新图谱、codegraph_query 查询代码关系、codegraph_status 查看图谱状态和统计。CodeGraph 完全本地运行，数据存储在项目的 .codegraph 目录。适用于大型代码库的快速导航和理解。用户提到「代码图谱 / 代码关系 / codegraph / 代码结构分析」时即指本插件。`

const SECTION_ORDER = 160

/**
 * Plugin entry point
 */
export function apply(ctx: Context, config?: Config): void {
  const resolve = (): Required<Config> => ({
    enabled: config?.enabled ?? true,
    announceToAgent: config?.announceToAgent ?? true,
    codegraphPath: config?.codegraphPath ?? 'npx @colbymchenry/codegraph',
    defaultWorkdir: config?.defaultWorkdir ?? process.cwd(),
  })

  const tools = [
    codegraphBuildTool(resolve().codegraphPath, resolve().defaultWorkdir),
    codegraphQueryTool(resolve().codegraphPath, resolve().defaultWorkdir),
    codegraphStatusTool(resolve().codegraphPath, resolve().defaultWorkdir),
  ]

  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    const value = resolve()

    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }

    if (!value.enabled) return

    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-codegraph',
        order: SECTION_ORDER,
        text: CODEGRAPH_GUIDANCE,
      })
    }

    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-codegraph: tools',
    )
  }

  sync()
}
