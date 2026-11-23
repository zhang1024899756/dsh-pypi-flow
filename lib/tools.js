/**
 * dsh-pypi-flow — model-facing tools.
 *
 * Eight tools cover the workflow: status, configuration, package lookup,
 * version history, name availability, the tracked own-project list, publishing,
 * and the delete/yank path. Every tool resolves to `{ ok, message, ... }` and
 * never throws for an expected outcome (a missing package, a rejected token,
 * an unreachable registry); a thrown error is reserved for a bug.
 *
 * Two invariants hold across all of them:
 *
 * - No result ever contains an API token, not even masked in an error path.
 * - A tool that writes to PyPI says so before it does it, and `dryRun` walks
 *   the identical code path without the network.
 */
import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'

import {
  checkName,
  fetchProject,
  lookupPackage,
  normalizeProjectName,
  probeToken,
  releasesOf,
  repositoryInfo,
  toPackageView,
} from './pypi.js'
import { readDistribution } from './metadata.js'
import { uploadDistribution } from './upload.js'

/** Build one text ContentBlock list for `output.render`. */
const text = (value) => [{ type: 'text', text: String(value) }]

/**
 * Shared output declaration. The envelope is fixed (`ok`, `message`), and
 * `additionalProperties: true` lets each tool return its own structured fields
 * without maintaining a second schema per tool.
 * @param {Record<string, unknown>} [properties]
 * @returns {{ schema: Record<string, unknown>, render: (args: unknown, value: any) => any[] }}
 */
function envelope(properties = {}) {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        message: { type: 'string' },
        ...properties,
      },
      required: ['ok', 'message'],
    },
    render: (_args, value) => text(value?.message ?? ''),
  }
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {{ ok: true, message: string } & Record<string, unknown>}
 */
const succeed = (message, extra = {}) => ({ ok: true, message, ...extra })

/**
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {{ ok: false, message: string } & Record<string, unknown>}
 */
const fail = (message, extra = {}) => ({ ok: false, message, ...extra })

/**
 * Present an ISO timestamp as a short UTC string, tolerating null.
 * @param {string | null | undefined} value
 * @returns {string}
 */
function when(value) {
  if (typeof value !== 'string' || value === '') return '时间未知'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/**
 * One line summarizing a project view, reused by several tools.
 * @param {import('./pypi.js').PackageView} view
 * @returns {string}
 */
function describePackage(view) {
  const parts = [`${view.name}（最新 ${view.version}`, `共 ${view.totalReleases} 个版本 / ${view.fileCount} 个文件`]
  if (view.requiresPython !== '') parts.push(`需要 Python ${view.requiresPython}`)
  parts.push(`最近上传 ${when(view.lastUpload)}`)
  if (view.owner.length > 0) parts.push(`所有者 ${view.owner.join(', ')}`)
  if (view.yanked) parts.push('最新版本已被 yank')
  return parts.join('，') + '）'
}

/** @typedef {{ store: import('./store.js').PyPiStore, defaultRepository: 'pypi'|'testpypi', logger?: { warn(...args: unknown[]): void } }} ToolContext */

/**
 * Tool: plugin and account status.
 * @param {ToolContext} ctx
 * @returns {Record<string, unknown>} a ToolDefinition
 */
export function pypiStatusTool(ctx) {
  return {
    name: 'pypi_status',
    description:
      '查看 dsh-pypi-flow 的绑定状态：PyPI 用户名、是否已配置 API 令牌（只回显掩码）、令牌存于何处、追踪中的项目数量、默认发布目标、最近一次发布结果。开始任何 PyPI 操作前先调用它，避免重复询问用户已经配置过的信息。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: envelope({ projectCount: { type: 'number' }, tokenConfigured: { type: 'boolean' } }),
    /**
     * @returns {Promise<Record<string, unknown>>}
     */
    async execute() {
      const view = await ctx.store.view()
      const lines = [
        `账号：${view.username === '' ? '未绑定（可用 pypi_config 的 username 绑定）' : view.username}`,
        `令牌：${
          view.tokenConfigured
            ? `${view.tokenMasked}（${view.tokenPersistent ? '已存入本机凭据库' : '仅本次会话有效'}）`
            : view.credentialStoreAvailable
              ? '未配置（发布前需要，可用面板或 pypi_config 保存）'
              : '未配置，且本机没有可用凭据服务（只能在调用时逐次传 token）'
        }`,
        `追踪项目：${view.projects.length} 个${view.projects.length > 0 ? `（${view.projects.map((project) => project.name).join('、')}）` : ''}`,
        `默认目标：${repositoryInfo(view.defaultRepository).label}`,
        `最近发布：${
          view.lastPublish === null
            ? '无'
            : `${view.lastPublish.name} ${view.lastPublish.version} → ${view.lastPublish.repository}（HTTP ${view.lastPublish.status}，${when(view.lastPublish.at)}）`
        }`,
      ]
      return succeed(`dsh-pypi-flow：\n- ${lines.join('\n- ')}`, {
        username: view.username,
        tokenConfigured: view.tokenConfigured,
        tokenMasked: view.tokenMasked,
        projectCount: view.projects.length,
        defaultRepository: view.defaultRepository,
        credentialStoreAvailable: view.credentialStoreAvailable,
        statePath: view.statePath,
      })
    },
  }
}

/**
 * Tool: bind the account and manage the tracked project list.
 * @param {ToolContext} ctx
 * @returns {Record<string, unknown>} a ToolDefinition
 */
export function pypiConfigTool(ctx) {
  return {
    name: 'pypi_config',
    description:
      '配置 dsh-pypi-flow：绑定 PyPI 用户名、保存或清除 API 令牌、设置默认发布目标、增删追踪项目。令牌会写入本机 DSH 凭据库，返回值只给掩码；用户也可以在「设置 → PyPI」面板里完成同样的操作。',
    parameters: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'PyPI 用户名，用于归属校验；留空表示不改' },
        token: {
          type: 'string',
          description: 'PyPI API 令牌（pypi-AgEI... 开头）。持久保存到本机凭据库；不要把它写进任何回复',
        },
        sessionToken: {
          type: 'string',
          description: '只在本次会话内存中使用的令牌，不落盘；适合不想长期保存的场景',
        },
        clearToken: { type: 'boolean', description: '设为 true 时清除已保存的令牌（含会话令牌）' },
        defaultRepository: {
          type: 'string',
          enum: ['pypi', 'testpypi'],
          description: '默认发布目标；pypi 为正式仓库，testpypi 为测试仓库',
        },
        addProject: { type: 'string', description: '加入追踪列表的包名' },
        removeProject: { type: 'string', description: '从追踪列表移除的包名' },
      },
      additionalProperties: false,
    },
    output: envelope({ username: { type: 'string' }, tokenConfigured: { type: 'boolean' } }),
    /**
     * @param {{ username?: string, token?: string, sessionToken?: string, clearToken?: boolean,
     *           defaultRepository?: 'pypi'|'testpypi', addProject?: string, removeProject?: string }} args
     * @returns {Promise<Record<string, unknown>>}
     */
    async execute(args = {}) {
      const actions = []
      if (typeof args.clearToken === 'boolean' && args.clearToken) {
        await ctx.store.clearToken()
        actions.push('已清除令牌')
      }
      if (typeof args.token === 'string' && args.token.trim() !== '') {
        await ctx.store.setToken(args.token)
        // The argument is a secret and the executor hands it in frozen, so it is
        // read once and never echoed; nothing here writes back into `args`.
        actions.push('已保存令牌到本机凭据库')
      }
      if (typeof args.sessionToken === 'string' && args.sessionToken.trim() !== '') {
        ctx.store.setSessionToken(args.sessionToken)
        actions.push('已设置本次会话令牌（不落盘）')
      }
      const patch = {}
      if (typeof args.username === 'string') {
        patch.username = args.username.trim()
        actions.push(patch.username === '' ? '已清空用户名' : `用户名绑定为 ${patch.username}`)
      }
      if (args.defaultRepository === 'pypi' || args.defaultRepository === 'testpypi') {
        patch.defaultRepository = args.defaultRepository
        actions.push(`默认发布目标设为 ${repositoryInfo(args.defaultRepository).label}`)
      }
      if (Object.keys(patch).length > 0) await ctx.store.patch(patch)
      if (typeof args.addProject === 'string' && args.addProject.trim() !== '') {
        const result = await ctx.store.addProject(args.addProject)
        actions.push(result.added ? `已加入追踪：${args.addProject.trim()}` : `${args.addProject.trim()} 已在追踪列表中`)
      }
      if (typeof args.removeProject === 'string' && args.removeProject.trim() !== '') {
        const result = await ctx.store.removeProject(args.removeProject)
        actions.push(result.removed ? `已移除追踪：${args.removeProject.trim()}` : `${args.removeProject.trim()} 不在追踪列表中`)
      }
      const view = await ctx.store.view()
      if (actions.length === 0) return succeed('没有需要修改的配置；当前状态见 pypi_status。', { username: view.username, tokenConfigured: view.tokenConfigured })
      return succeed(`${actions.join('；')}。当前追踪项目 ${view.projects.length} 个。`, {
        username: view.username,
        tokenConfigured: view.tokenConfigured,
        tokenMasked: view.tokenMasked,
        projectCount: view.projects.length,
        defaultRepository: view.defaultRepository,
      })
    },
  }
}

/**
 * Tool: one project's current state.
 * @param {ToolContext} ctx
 * @returns {Record<string, unknown>} a ToolDefinition
 */
export function pypiInfoTool(ctx) {
  return {
    name: 'pypi_info',
    description:
      '按包名查询 PyPI 项目的当前状态：最新版本、摘要、requires_python、所有者（ownership）、版本数与文件数、最近上传时间、是否被 yank、项目主页链接。包不存在会返回 ok:false 并说明未发布。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'PyPI 包名，大小写与 -/_/. 无需精确匹配' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: envelope({ name: { type: 'string' }, version: { type: 'string' }, owner: { type: 'array' } }),
    /**
     * @param {{ name?: string }} args
     * @param {{ signal?: AbortSignal }} [exec]
     * @returns {Promise<Record<string, unknown>>}
     */
    async execute(args = {}, exec = {}) {
      const name = String(args.name ?? '').trim()
      if (name === '') return fail('需要提供包名')
      try {
        const view = await lookupPackage(name, { signal: exec.signal })
        const extra = view.summary === '' ? '' : `\n摘要：${view.summary}`
        return succeed(`${describePackage(view)}${extra}\n项目页：${view.projectUrl}`, { ...view })
      } catch (error) {
        if (/** @type {{ kind?: string }} */ (error)?.kind === 'not-found') {
          return fail(`PyPI 上还没有 ${name} 这个项目（该名称当前可用，可用 pypi_check_name 复核）。`, { notFound: true, name })
        }
        return fail(/** @type {Error} */ (error)?.message ?? String(error), { name })
      }
    },
  }
}

/**
 * Tool: release history for one project.
 * @param {ToolContext} ctx
 * @returns {Record<string, unknown>} a ToolDefinition
 */
export function pypiVersionsTool(ctx) {
  return {
    name: 'pypi_versions',
    description:
      '列出某个 PyPI 项目的历史版本（默认最新 10 个，按上传时间倒序），包含每个版本的文件数、上传时间与是否被 yank。用于确认某个版本号是否已被占用、或挑选要回滚/排查的版本。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'PyPI 包名' },
        limit: { type: 'integer', description: '返回多少个版本，默认 10，上限 100' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: envelope({ name: { type: 'string' }, totalReleases: { type: 'number' }, versions: { type: 'array' } }),
    /**
     * @param {{ name?: string, limit?: number }} args
     * @param {{ signal?: AbortSignal }} [exec]
     * @returns {Promise<Record<string, unknown>>}
     */
    async execute(args = {}, exec = {}) {
      const name = String(args.name ?? '').trim()
      if (name === '') return fail('需要提供包名')
      const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 100)
      try {
        const document = await fetchProject(name, { signal: exec.signal })
        const rows = releasesOf(document)
        if (rows.length === 0) return fail(`${name} 存在，但没有任何已上传的发行文件。`, { name, totalReleases: 0, versions: [] })
        const shown = rows.slice(0, limit)
        const list = shown
          .map((row) => `- ${row.version}：${row.fileCount} 个文件，${when(row.uploadedAt)}${row.yanked ? '（已 yank）' : ''}`)
          .join('\n')
        const tail = rows.length > shown.length ? `\n（另有 ${rows.length - shown.length} 个更早版本未显示）` : ''
        return succeed(`${name} 共 ${rows.length} 个版本：\n${list}${tail}`, {
          name: (document?.info?.name ?? name),
          totalReleases: rows.length,
          versions: shown.map((row) => ({ version: row.version, fileCount: row.fileCount, uploadedAt: row.uploadedAt, yanked: row.yanked })),
        })
      } catch (error) {
        if (/** @type {{ kind?: string }} */ (error)?.kind === 'not-found') {
          return fail(`PyPI 上还没有 ${name} 这个项目。`, { notFound: true, name })
        }
        return fail(/** @type {Error} */ (error).message, { name })
      }
    },
  }
}

/**
 * Tool: is this name free right now?
 * @param {ToolContext} ctx
 * @returns {Record<string, unknown>} a ToolDefinition
 */
export function pypiCheckNameTool(ctx) {
  return {
    name: 'pypi_check_name',
    description:
      '判断一个包名当前是否已被 PyPI 占用，并检查名称是否合法（只允许字母数字与 . _ -，首尾须为字母数字）。注意：未被占用不等于一定能注册，PyPI 会按 PEP 541 保留部分名称。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要检查的包名' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: envelope({ name: { type: 'string' }, available: { type: 'boolean' }, valid: { type: 'boolean' } }),
    /**
     * @param {{ name?: string }} args
     * @param {{ signal?: AbortSignal }} [exec]
     * @returns {Promise<Record<string, unknown>>}
     */
    async execute(args = {}, exec = {}) {
      const name = String(args.name ?? '').trim()
      if (name === '') return fail('需要提供包名')
      try {
        const result = await checkName(name, { signal: exec.signal })
        const normalized = normalizeProjectName(name)
        const normalizationNote = normalized !== name.toLowerCase() ? `（规范化后为 ${normalized}，PyPI 视两者为同一个项目）` : ''
        if (!result.valid) return fail(`${result.reason}${normalizationNote}`, { ...result })
        if (result.available) return succeed(`${name} 当前未被占用${normalizationNote}。${result.reason}`, { ...result })
        const existing = result.existing
        return succeed(
          `${name} 已被占用${normalizationNote}：现有项目 ${existing?.name} 最新 ${existing?.version}，所有者 ${existing?.owner.join(', ') || '未公开'}，最近上传 ${when(existing?.lastUpload)}。同名的不同版本仍然可以继续发布（同一项目、不同版本号）。`,
          { ...result },
        )
      } catch (error) {
        return fail(/** @type {Error} */ (error).message, { name })
      }
    },
  }
}

/**
 * Tool: the tracked own-project list with ownership verification.
 * @param {ToolContext} ctx
 * @returns {Record<string, unknown>} a ToolDefinition
 */
export function pypiMyPackagesTool(ctx) {
  return {
    name: 'pypi_my_packages',
    description:
      '列出本机追踪的自有 PyPI 项目，并逐个实时查询：最新版本、最近上传、文件数，以及 ownership 是否包含已绑定的用户名。PyPI 无法按账号枚举全部项目（用户主页有反爬挑战），所以这是本地维护的清单，不保证覆盖账号下所有项目。',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '设为 true 时忽略缓存并强制重新查询（本工具不做缓存，故该参数只影响提示文案）' },
      },
      additionalProperties: false,
    },
    output: envelope({ count: { type: 'number' }, projects: { type: 'array' } }),
    /**
     * @param {{ refresh?: boolean }} [_args]
     * @param {{ signal?: AbortSignal }} [exec]
     * @returns {Promise<Record<string, unknown>>}
     */
    async execute(_args = {}, exec = {}) {
      const view = await ctx.store.view()
      if (view.projects.length === 0) {
        return succeed('追踪列表还是空的。发布成功后会自动加入；也可以先用 pypi_config 的 addProject 添加，或在「设置 → PyPI」面板里添加。', {
          count: 0,
          projects: [],
        })
      }
      const username = view.username.trim().toLowerCase()
      const projects = []
      for (const tracked of view.projects) {
        try {
          const info = await lookupPackage(tracked.name, { signal: exec.signal })
          const ownedByMe =
            username === '' ? null : info.owner.some((owner) => owner.toLowerCase() === username)
          projects.push({
            name: info.name,
            latestVersion: info.version,
            lastUpload: info.lastUpload,
            fileCount: info.fileCount,
            totalReleases: info.totalReleases,
            owner: info.owner,
            ownedByMe,
            error: null,
          })
        } catch (error) {
          projects.push({
            name: tracked.name,
            latestVersion: null,
            lastUpload: null,
            fileCount: 0,
            totalReleases: 0,
            owner: [],
            ownedByMe: null,
            error: /** @type {Error} */ (error).message,
          })
        }
      }
      const lines = projects.map((project) => {
        if (project.error !== null) return `- ${project.name}：查询失败（${project.error}）`
        const ownership =
          project.ownedByMe === null
            ? '（未绑定用户名，无法校验归属）'
            : project.ownedByMe
              ? '属于当前账号'
              : `不属于当前账号（所有者：${project.owner.join(', ') || '未公开'}）`
        return `- ${project.name}：最新 ${project.latestVersion}，${project.fileCount} 个文件，最近上传 ${when(project.lastUpload)}，${ownership}`
      })
      const mismatched = projects.filter((project) => project.ownedByMe === false)
      const warning =
        mismatched.length === 0 ? '' : `\n注意：${mismatched.map((project) => project.name).join('、')} 的 ownership 不含已绑定用户名，发布前请确认账号权限。`
      return succeed(`追踪中的 ${projects.length} 个自有项目：\n${lines.join('\n')}${warning}`, {
        count: projects.length,
        projects,
        username: view.username,
      })
    },
  }
}

/**
 * Collect distribution files from a path that may be a directory.
 * @param {string} target absolute path
 * @returns {Promise<string[]>} absolute file paths, sorted for determinism
 */
async function collectDistributions(target) {
  const info = await stat(target)
  if (!info.isDirectory()) return [target]
  const entries = await readdir(target, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && /\.(whl|tar\.gz|tgz|zip)$/i.test(entry.name))
    .map((entry) => path.join(target, entry.name))
  files.sort()
  return files
}

/**
 * Run `python -m build` in a project directory.
 * @param {string} projectDir
 * @param {{ signal?: AbortSignal }} [exec]
 * @returns {Promise<{ ok: boolean, outDir: string, message: string }>}
 */
function runPythonBuild(projectDir, exec = {}) {
  return new Promise((resolve) => {
    const outDir = path.join(projectDir, 'dist')
    const child = spawn('python', ['-m', 'build', '--outdir', outDir], {
      cwd: projectDir,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const capture = (chunk) => {
      output += String(chunk)
      if (output.length > 8000) output = output.slice(-8000)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    const abort = () => child.kill()
    exec.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      resolve({ ok: false, outDir, message: `无法启动 python：${error.message}` })
    })
    child.on('close', (code) => {
      exec.signal?.removeEventListener('abort', abort)
      if (code === 0) resolve({ ok: true, outDir, message: '构建完成' })
      else resolve({ ok: false, outDir, message: `python -m build 退出码 ${code}：${output.trim().slice(-1200)}` })
    })
  })
}

/**
 * Tool: publish distributions to PyPI / TestPyPI.
 * @param {ToolContext} ctx
 * @returns {Record<string, unknown>} a ToolDefinition
 */
export function pypiPublishTool(ctx) {
  return {
    name: 'pypi_publish',
    description:
      '把本地已构建好的发行包上传到 PyPI 或 TestPyPI（内置零依赖上传器，直接调用官方 Upload API，不需要本机装 Python 或 twine）。path 可以指向单个 .whl/.tar.gz，也可以指向一个目录（上传其中全部发行包）。这是真实写入操作：版本号一旦发布就不能再次上传，发布前先用 pypi_info / pypi_versions 确认版本号未被占用，必要时先 dryRun: true 预检。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '发行包文件或包含发行包的目录；建议传绝对路径（相对路径按 DSH 进程工作目录解析）',
        },
        repository: {
          type: 'string',
          enum: ['pypi', 'testpypi'],
          description: '目标仓库；缺省用插件配置里的默认值（默认 pypi 正式仓库）',
        },
        token: {
          type: 'string',
          description: '本次使用的 API 令牌；省略则用已保存的凭据。令牌不会出现在任何返回内容里',
        },
        dryRun: {
          type: 'boolean',
          description: '设为 true 时只解析元数据并构造请求，不上传（用于确认包名/版本号/字段是否正确）',
        },
        build: {
          type: 'boolean',
          description: '设为 true 时先在该目录执行 python -m build 生成 dist/，再上传（需要本机 Python 与 build 模块）',
        },
        projectDir: {
          type: 'string',
          description: '配合 build 使用：要构建的项目根目录（含 pyproject.toml）；省略时用 path 或其父目录',
        },
        track: {
          type: 'boolean',
          description: '发布成功后是否加入「我的项目」追踪列表，默认 true',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: envelope({ published: { type: 'array' }, dryRun: { type: 'boolean' }, repository: { type: 'string' } }),
    /**
     * @param {{ path?: string, repository?: string, token?: string, dryRun?: boolean,
     *           build?: boolean, projectDir?: string, track?: boolean }} args
     * @param {{ signal?: AbortSignal }} [exec]
     * @returns {Promise<Record<string, unknown>>}
     */
    async execute(args = {}, exec = {}) {
      const rawPath = String(args.path ?? '').trim()
      if (rawPath === '') return fail('需要提供发行包路径')
      const view = await ctx.store.view()
      const repository = args.repository === 'testpypi' || args.repository === 'pypi' ? args.repository : view.defaultRepository
      const dryRun = args.dryRun === true
      const tracking = args.track !== false

      let target = path.resolve(rawPath)
      try {
        const info = await stat(target)
        if (!info.isDirectory() && args.build === true) {
          return fail('build 需要一个项目目录，但 path 指向的是文件；请把 path 设为项目根目录，或用 projectDir 指定。')
        }
      } catch {
        return fail(`路径不存在：${target}`)
      }

      if (args.build === true) {
        const projectDir = path.resolve(String(args.projectDir ?? '').trim() || target)
        const build = await runPythonBuild(projectDir, exec)
        if (!build.ok) return fail(`构建失败，未上传任何文件。${build.message}`)
        target = build.outDir
      }

      let files
      try {
        files = await collectDistributions(target)
      } catch (error) {
        return fail(`无法读取路径 ${target}：${/** @type {Error} */ (error).message}`)
      }
      if (files.length === 0) {
        return fail(`${target} 里没有找到发行包（.whl / .tar.gz / .zip）。先用 python -m build 或 build: true 生成 dist/。`)
      }

      const resolved = await ctx.store.resolveToken(args.token)
      const missingToken = resolved === undefined
      if (missingToken && !dryRun) {
        return fail(
          '发布需要 PyPI API 令牌，但当前没有可用的令牌。请在「设置 → PyPI」面板里保存令牌，或用 pypi_config 的 token 参数（也可在本次调用里传 token）；TestPyPI 需要单独在 test.pypi.org 申请的令牌。',
          { repository, published: [] },
        )
      }

      const results = []
      for (const file of files) {
        // `uploadDistribution` accepts a token; dry runs do not need a real one.
        const outcome = await uploadDistribution({
          filePath: file,
          token: resolved?.token ?? '',
          repository,
          dryRun,
          signal: exec.signal,
        })
        results.push(outcome)
      }

      const uploaded = results.filter((result) => result.ok && !result.dryRun)
      const failed = results.filter((result) => !result.ok)
      if (dryRun) {
        const lines = results.map(
          (result) =>
            `- ${result.filename}：${result.ok ? `预检通过（${result.filetype}，${result.name} ${result.version}）` : `预检失败（${result.message}）`}`,
        )
        return succeed(`预检完成，未上传任何文件：\n${lines.join('\n')}\n确认无误后去掉 dryRun 再执行。`, {
          published: [],
          dryRun: true,
          repository,
          fieldNames: results[0]?.fieldNames ?? [],
        })
      }

      if (uploaded.length > 0 && tracking) {
        const first = uploaded[0]
        await ctx.store.addProject(first.name, { lastVersion: first.version }).catch(() => {})
        await ctx.store
          .recordPublish({
            name: first.name,
            version: first.version,
            repository,
            at: new Date().toISOString(),
            filename: first.filename,
            status: first.status,
          })
          .catch(() => {})
      }

      const lines = results.map((result) => {
        // A file that failed local parsing carries no name/version, so label it by
        // filename alone rather than rendering an empty pair of brackets.
        const label = result.name !== '' && result.version !== '' ? `${result.filename}（${result.name} ${result.version}）` : result.filename
        return `- ${label}：${result.ok ? '上传成功' : `失败 — ${result.message}`}`
      })
      const summary =
        failed.length === 0
          ? `已成功上传 ${uploaded.length} 个文件到 ${repositoryInfo(repository).label}：\n${lines.join('\n')}`
          : `上传完成：成功 ${uploaded.length} 个，失败 ${failed.length} 个。\n${lines.join('\n')}`
      return {
        ok: failed.length === 0,
        message: summary,
        repository,
        published: uploaded.map((result) => ({ name: result.name, version: result.version, filename: result.filename, status: result.status })),
        failures: failed.map((result) => ({ filename: result.filename, message: result.message, errorKind: result.errorKind ?? 'unknown' })),
        dryRun: false,
      }
    },
  }
}

/**
 * Tool: the honest delete / yank path.
 * @param {ToolContext} ctx
 * @returns {Record<string, unknown>} a ToolDefinition
 */
export function pypiDeleteGuideTool(ctx) {
  return {
    name: 'pypi_delete_guide',
    description:
      '说明如何删除 PyPI 项目的某个版本、文件，或撤回（yank）一个版本，并给出直接可点的管理页链接。PyPI 没有提供删除或 yank 的 API，这类操作必须在网页上完成，本工具只给事实、规则和链接，不会代替用户执行。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'PyPI 包名' },
        version: { type: 'string', description: '可选：要处理的具体版本，用于生成直达该版本管理页的链接' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: envelope({ name: { type: 'string' }, manageUrl: { type: 'string' }, apiAvailable: { type: 'boolean' } }),
    /**
     * @param {{ name?: string, version?: string }} args
     * @param {{ signal?: AbortSignal }} [exec]
     * @returns {Promise<Record<string, unknown>>}
     */
    async execute(args = {}, exec = {}) {
      const name = String(args.name ?? '').trim()
      if (name === '') return fail('需要提供包名')
      const version = String(args.version ?? '').trim()
      const manageUrl = `https://pypi.org/manage/project/${encodeURIComponent(name)}/releases/`
      const versionUrl =
        version === ''
          ? manageUrl
          : `https://pypi.org/manage/project/${encodeURIComponent(name)}/release/${encodeURIComponent(version)}/`
      let facts = ''
      try {
        const document = await fetchProject(name, { signal: exec.signal })
        const view = toPackageView(document)
        const rows = releasesOf(document)
        const yanked = rows.filter((row) => row.yanked)
        facts = `\n现状：最新 ${view.version}，共 ${rows.length} 个版本 / ${view.fileCount} 个文件${
          yanked.length > 0 ? `，已被 yank 的版本：${yanked.map((row) => row.version).join('、')}` : ''
        }${version !== '' ? `\n目标版本 ${version} ${rows.some((row) => row.version === version) ? '存在' : '不存在'}` : ''}`
      } catch (error) {
        if (/** @type {{ kind?: string }} */ (error)?.kind !== 'not-found') {
          facts = `\n（实时状态查询失败：${/** @type {Error} */ (error).message}）`
        }
      }
      const message = [
        `删除与撤回（PyPI 只能网页操作，官方未提供 API；程序化删除的议题在 warehouse#12934 仍未实现）：`,
        `1. 删除单个文件 / 删除某个版本：打开 ${versionUrl} ，在 “Manage” 里删除该 release 的文件；version 下所有文件删除后该 release 即消失。`,
        `2. 删除整个项目：PyPI 不支持。项目名会一直保留（PEP 541 名称保留策略），重建同名项目即恢复。因此“删除项目”实际只能做到删除其全部版本。`,
        `3. 有下游依赖的版本不能删除：只要还有已发布的项目依赖这个版本，PyPI 会拒绝删除，此时应当用 yank。`,
        `4. yank（撤回）：在同一管理页勾选 “Yank”，已安装的环境不受影响，但新的解析器会跳过它。这是替代删除的推荐做法。`,
        `5. 重新发布同一版本号是不允许的：即使删除了文件，版本号也不能复用，必须升版本。`,
        facts,
        `项目页：https://pypi.org/project/${encodeURIComponent(name)}/`,
      ]
        .filter((line) => line !== '')
        .join('\n')
      return succeed(message, { name, version, manageUrl: versionUrl, projectUrl: `https://pypi.org/project/${encodeURIComponent(name)}/`, apiAvailable: false })
    },
  }
}

/**
 * A probe tool that lets the model and the panel share one verification path.
 * @param {ToolContext} ctx
 * @returns {Record<string, unknown>} a ToolDefinition
 */
export function pypiProbeTool(ctx) {
  return {
    name: 'pypi_probe_token',
    description:
      '用当前保存的（或本次传入的）API 令牌向 PyPI 上传接口做一次不会上传任何文件的连通性检查，判断令牌是否通过认证。这是基于接口行为的推断而非官方校验接口，首次真实上传仍是最终验证。',
    parameters: {
      type: 'object',
      properties: {
        token: { type: 'string', description: '本次探测使用的令牌；省略则用已保存的凭据' },
        repository: { type: 'string', enum: ['pypi', 'testpypi'], description: '要探测的仓库，缺省用插件默认值' },
      },
      additionalProperties: false,
    },
    output: envelope({ verified: { type: 'boolean' }, status: { type: 'number' } }),
    /**
     * @param {{ token?: string, repository?: string }} args
     * @param {{ signal?: AbortSignal }} [exec]
     * @returns {Promise<Record<string, unknown>>}
     */
    async execute(args = {}, exec = {}) {
      const view = await ctx.store.view()
      const repository = args.repository === 'testpypi' || args.repository === 'pypi' ? args.repository : view.defaultRepository
      const resolved = await ctx.store.resolveToken(args.token)
      if (resolved === undefined) return fail('还没有可用的令牌，无法探测。', { verified: false, status: 0 })
      const result = await probeToken({ token: resolved.token, repository }, { signal: exec.signal })
      return {
        ok: result.verified !== false,
        message: result.message,
        verified: result.verified,
        status: result.status,
        inconclusive: result.inconclusive,
        repository,
      }
    },
  }
}

/**
 * Build every tool for the registry.
 * @param {ToolContext} ctx
 * @returns {Array<Record<string, unknown>>}
 */
export function buildTools(ctx) {
  return [
    pypiStatusTool(ctx),
    pypiConfigTool(ctx),
    pypiInfoTool(ctx),
    pypiVersionsTool(ctx),
    pypiCheckNameTool(ctx),
    pypiMyPackagesTool(ctx),
    pypiPublishTool(ctx),
    pypiProbeTool(ctx),
    pypiDeleteGuideTool(ctx),
  ]
}

/** Re-export the metadata reader so callers do not import two modules. */
export { readDistribution }
