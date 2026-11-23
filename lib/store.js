/**
 * dsh-pypi-flow — account state and credential store.
 *
 * Two different kinds of data live in two different places on purpose:
 *
 * - The API token is a secret, so it goes to the DSH credential service
 *   (`ctx.credentials`, persisted by the credentials provider in
 *   `$DSH_HOME/.credentials.yaml`). Configuration and this plugin's own state
 *   file never hold it. A token handed in for a single operation may also stay
 *   in memory only, which is the "temporary credential" path.
 *
 * - Everything else (the bound username, the tracked project list, the last
 *   publish receipt) is ordinary state, persisted to `$DSH_HOME/pypi-flow.json`
 *   with mode 0600. It contains no secret, so the settings panel can render it
 *   without going through a credential prompt.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { normalizeProjectName } from './pypi.js'

/** Credential reference name for the PyPI API token (POSIX-identifier shaped). */
export const TOKEN_REF = 'PYPI_API_TOKEN'

/** Default machine-wide state location. */
export const DEFAULT_STATE_FILE = path.join(
  process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : path.join(homedir(), '.dsh'),
  'pypi-flow.json',
)

/**
 * Current state file path. `DSH_PYPI_FLOW_STATE` overrides it, which the smoke
 * tests and the HTTP routes' test fixtures use to stay off the real file.
 * @returns {string}
 */
export function statePath() {
  const override = process.env.DSH_PYPI_FLOW_STATE
  return override !== undefined && override !== '' ? override : DEFAULT_STATE_FILE
}

/**
 * Mask a secret for display, keeping only a short head and tail.
 * @param {string} value
 * @returns {string} the masked form, or '' when there is nothing to show
 */
export function mask(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 12) return value.slice(0, 2) + '****'
  return value.slice(0, 6) + '****' + value.slice(-4)
}

/** @typedef {{ name: string, addedAt: string, lastVersion?: string }} TrackedProject */

/** @typedef {{
 *   username: string,
 *   projects: TrackedProject[],
 *   defaultRepository: 'pypi' | 'testpypi',
 *   lastPublish: null | { name: string, version: string, repository: string,
 *                         at: string, filename: string, status: number },
 * }} PyPiState */

/** @returns {PyPiState} a fresh, empty state */
function emptyState() {
  return { username: '', projects: [], defaultRepository: 'pypi', lastPublish: null }
}

/**
 * Coerce whatever was on disk into a shape the rest of the plugin can trust.
 * A hand-edited or truncated file must degrade to sensible defaults instead of
 * breaking every tool.
 * @param {unknown} raw
 * @returns {PyPiState}
 */
function normalizeState(raw) {
  const base = emptyState()
  if (raw === null || typeof raw !== 'object') return base
  const value = /** @type {Record<string, unknown>} */ (raw)
  const username = typeof value.username === 'string' ? value.username.trim() : ''
  const projects = Array.isArray(value.projects)
    ? value.projects
        .map((entry) => {
          if (typeof entry === 'string') return { name: entry.trim(), addedAt: '' }
          if (entry !== null && typeof entry === 'object') {
            const item = /** @type {Record<string, unknown>} */ (entry)
            const name = typeof item.name === 'string' ? item.name.trim() : ''
            if (name === '') return null
            return {
              name,
              addedAt: typeof item.addedAt === 'string' ? item.addedAt : '',
              ...(typeof item.lastVersion === 'string' ? { lastVersion: item.lastVersion } : {}),
            }
          }
          return null
        })
        .filter((entry) => entry !== null && entry.name !== '')
    : []
  // De-duplicate by PEP 503 normalized name, preserving first-seen order.
  // `my_pkg`, `my.pkg` and `my-pkg` name the same PyPI project, so a list keyed
  // on the raw spelling would track the same project twice.
  const seen = new Set()
  const unique = []
  for (const project of projects) {
    const key = normalizeProjectName(project.name)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(project)
  }
  const repository = value.defaultRepository === 'testpypi' ? 'testpypi' : 'pypi'
  const lastPublish =
    value.lastPublish !== null && typeof value.lastPublish === 'object'
      ? /** @type {PyPiState['lastPublish']} */ (value.lastPublish)
      : null
  return { username, projects: unique, defaultRepository: repository, lastPublish }
}

/**
 * PyPI account state plus token access.
 *
 * The store also answers the questions the tools and the settings panel ask:
 * "which token applies to this operation", "is a token configured", "what
 * happened last time".
 */
export class PyPiStore {
  /**
   * @param {object} [options]
   * @param {undefined | { resolve(ref: string): Promise<{ value: string } | undefined>,
   *                       describe(ref: string): Promise<{ configured: boolean, source?: string, writable?: boolean }>,
   *                       set(ref: string, value: string): Promise<void>,
   *                       unset(ref: string): Promise<void> }} [options.credentials]
   *   the DSH credential service (`ctx.credentials`); when absent the store
   *   reports that a token cannot be persisted and relies on per-call tokens.
   */
  constructor(options = {}) {
    this.credentials = options.credentials
    /** @type {string | null} in-memory token for one session, never persisted */
    this.sessionToken = null
    /** @type {PyPiState | null} */
    this.cached = null
    /** @type {Promise<unknown>} serializes writes so two patches cannot interleave */
    this.writeChain = Promise.resolve()
  }

  /** @returns {boolean} whether tokens can survive a restart */
  get persistentTokenAvailable() {
    return this.credentials !== undefined && this.credentials !== null
  }

  /**
   * Read the persisted state (cached after the first read).
   * @returns {Promise<PyPiState>}
   */
  async state() {
    if (this.cached !== null) return this.cached
    let raw = null
    try {
      raw = JSON.parse(await readFile(statePath(), 'utf8'))
    } catch (error) {
      // A missing file is the normal first-run case; a corrupt file is worth
      // surfacing once rather than failing every later call.
      if (/** @type {{ code?: string }} */ (error)?.code !== 'ENOENT') {
        this.lastReadError = String(/** @type {Error} */ (error)?.message ?? error)
      }
    }
    this.cached = normalizeState(raw)
    return this.cached
  }

  /**
   * Apply one state mutation inside the serialized write region.
   *
   * Read-modify-write has to be atomic: two concurrent `addProject` calls that
   * each read the list outside the queue would both write a list containing
   * only their own entry and silently drop the other. So the read happens
   * inside the queued task, not before it.
   * @param {(current: PyPiState) => PyPiState | undefined | Promise<PyPiState | undefined>} mutator
   *   returns the complete next state, or undefined to leave the state untouched
   * @returns {Promise<PyPiState>} the state after the mutation
   */
  async mutate(mutator) {
    const run = async () => {
      const current = await this.state()
      const candidate = await mutator(current)
      if (candidate === undefined || candidate === null) return current
      const next = normalizeState(candidate)
      const file = statePath()
      await mkdir(path.dirname(file), { recursive: true })
      // mode is applied on create (POSIX); Windows protects via the user's profile ACL.
      await writeFile(file, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      await chmod(file, 0o600).catch(() => {})
      this.cached = next
      return next
    }
    const next = this.writeChain.then(run, run)
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * Merge a partial state update and persist it.
   * @param {Partial<PyPiState>} patch
   * @returns {Promise<PyPiState>}
   */
  async patch(patch) {
    return this.mutate((current) => ({ ...current, ...patch }))
  }

  /**
   * Add one project to the tracked list (idempotent, case-insensitive).
   * @param {string} name
   * @param {{ lastVersion?: string }} [extra]
   * @returns {Promise<{ added: boolean, state: PyPiState }>}
   */
  async addProject(name, extra = {}) {
    const trimmed = String(name ?? '').trim()
    if (trimmed === '') throw new Error('项目名不能为空')
    const key = normalizeProjectName(trimmed)
    let added = false
    const state = await this.mutate((current) => {
      if (current.projects.some((project) => normalizeProjectName(project.name) === key)) return undefined
      added = true
      return {
        ...current,
        projects: [...current.projects, { name: trimmed, addedAt: new Date().toISOString(), ...extra }],
      }
    })
    return { added, state }
  }

  /**
   * Remove one project from the tracked list.
   * @param {string} name
   * @returns {Promise<{ removed: boolean, state: PyPiState }>}
   */
  async removeProject(name) {
    const key = normalizeProjectName(name)
    let removed = false
    const state = await this.mutate((current) => {
      const kept = current.projects.filter((project) => normalizeProjectName(project.name) !== key)
      if (kept.length === current.projects.length) return undefined
      removed = true
      return { ...current, projects: kept }
    })
    return { removed, state }
  }

  /**
   * Record the outcome of a publish so the panel and later calls can report it.
   * @param {NonNullable<PyPiState['lastPublish']>} receipt
   * @returns {Promise<PyPiState>}
   */
  async recordPublish(receipt) {
    return this.patch({ lastPublish: receipt })
  }

  /**
   * Resolve the token an operation should use.
   *
   * Order: an explicit per-call token, then the session token, then the stored
   * credential. Every read goes through the credential service so a rotation
   * reaches the very next operation without a restart.
   * @param {string} [explicit]
   * @returns {Promise<{ token: string, source: 'argument' | 'session' | 'stored' } | undefined>}
   */
  async resolveToken(explicit) {
    if (typeof explicit === 'string' && explicit.trim() !== '') {
      return { token: explicit.trim(), source: 'argument' }
    }
    if (typeof this.sessionToken === 'string' && this.sessionToken !== '') {
      return { token: this.sessionToken, source: 'session' }
    }
    const stored = await this.storedToken()
    if (stored !== undefined) return { token: stored, source: 'stored' }
    return undefined
  }

  /**
   * @returns {Promise<string | undefined>} the persisted token, if any
   */
  async storedToken() {
    if (!this.persistentTokenAvailable) return undefined
    try {
      const hit = await this.credentials.resolve(TOKEN_REF)
      const value = hit?.value
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Persist a token through the credential service.
   * @param {string} token
   * @returns {Promise<void>}
   */
  async setToken(token) {
    const value = String(token ?? '').trim()
    if (value === '') throw new Error('令牌不能为空')
    if (!this.persistentTokenAvailable) {
      throw new Error('本机没有可用的凭据服务，无法长期保存令牌；可以在调用时直接传 token，或改用面板里的会话令牌')
    }
    await this.credentials.set(TOKEN_REF, value)
  }

  /**
   * Remove the persisted token.
   * @returns {Promise<void>}
   */
  async clearToken() {
    this.sessionToken = null
    if (!this.persistentTokenAvailable) return
    await this.credentials.unset(TOKEN_REF)
  }

  /**
   * Keep a token in memory for this process only.
   * @param {string} token
   * @returns {void}
   */
  setSessionToken(token) {
    const value = String(token ?? '').trim()
    this.sessionToken = value === '' ? null : value
  }

  /**
   * Whether a token is configured at all (either kind), without revealing it.
   * @returns {Promise<{ configured: boolean, masked: string, persistent: boolean, session: boolean }>}
   */
  async tokenView() {
    const stored = await this.storedToken()
    if (stored !== undefined) {
      return { configured: true, masked: mask(stored), persistent: true, session: false }
    }
    if (typeof this.sessionToken === 'string' && this.sessionToken !== '') {
      return { configured: true, masked: mask(this.sessionToken), persistent: false, session: true }
    }
    return { configured: false, masked: '', persistent: false, session: false }
  }

  /**
   * Secret-free snapshot for tools and the settings panel.
   * @returns {Promise<{ username: string, projects: TrackedProject[], defaultRepository: 'pypi' | 'testpypi',
   *                     lastPublish: PyPiState['lastPublish'], tokenConfigured: boolean, tokenMasked: string,
   *                     tokenPersistent: boolean, tokenSession: boolean, credentialStoreAvailable: boolean,
   *                     statePath: string, tokenRef: string }>}
   */
  async view() {
    const state = await this.state()
    const token = await this.tokenView()
    return {
      username: state.username,
      projects: state.projects,
      defaultRepository: state.defaultRepository,
      lastPublish: state.lastPublish,
      tokenConfigured: token.configured,
      tokenMasked: token.masked,
      tokenPersistent: token.persistent,
      tokenSession: token.session,
      credentialStoreAvailable: this.persistentTokenAvailable,
      statePath: statePath(),
      tokenRef: TOKEN_REF,
    }
  }
}
