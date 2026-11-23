/**
 * dsh-pypi-flow — read side of PyPI.
 *
 * Everything here talks to the public JSON API (`https://pypi.org/pypi/<name>/json`)
 * and the legacy upload endpoint, with no third-party client and no local
 * Python toolchain. Facts this module encodes, all verified against the live
 * service:
 *
 * - The JSON API exposes `ownership.roles[]`, which is how a project's owners
 *   are read without authenticating.
 * - A user page (`/user/<name>/`) is behind a JavaScript bot challenge, so
 *   "every project this account owns" cannot be scraped reliably. The plugin
 *   therefore tracks an explicit project list and verifies each entry's
 *   ownership instead of pretending to enumerate an account.
 * - PyPI serves no delete or yank API. The JSON API can report yank state, but
 *   changing it is a website action; this module only reports the facts the
 *   guidance needs.
 */

/** Base URL of the public JSON API. */
export const JSON_API = 'https://pypi.org/pypi'

/** Default ceiling for one PyPI request before it is abandoned. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/**
 * Current request timeout. `DSH_PYPI_FLOW_TIMEOUT_MS` overrides it so tests can
 * stay fast on a machine with no route to PyPI, and a user on a slow link can
 * raise it.
 * @returns {number}
 */
function requestTimeout() {
  const raw = Number(process.env.DSH_PYPI_FLOW_TIMEOUT_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS
}

/**
 * Compose the caller's signal with this module's own deadline.
 * @param {AbortSignal} [signal]
 * @returns {AbortSignal}
 */
function deadline(signal) {
  const timeout = AbortSignal.timeout(requestTimeout())
  return signal !== undefined ? AbortSignal.any([timeout, signal]) : timeout
}

/** A User-Agent that identifies this plugin, as PyPI asks clients to do. */
export const USER_AGENT = 'dsh-pypi-flow/0.1 (+https://github.com/zhang1024899756/dsh-pypi-flow)'

/**
 * PEP 503 normalized project name: runs of `-`, `_` and `.` collapse to a
 * single `-`, and the whole name is lower-cased. PyPI treats two names as the
 * same project exactly when their normalized forms match, so every comparison
 * in this plugin goes through this function.
 * @param {string} name
 * @returns {string}
 */
export function normalizeProjectName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[-_.]+/g, '-')
}

/**
 * Whether a string is syntactically a valid project name (PEP 508 name rule).
 * @param {string} name
 * @returns {boolean}
 */
export function isValidProjectName(name) {
  return /^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/.test(String(name ?? '').trim())
}

/** An error carrying a machine-readable kind the callers can branch on. */
export class PyPiError extends Error {
  /**
   * @param {string} message user-facing explanation (Chinese)
   * @param {'not-found'|'network'|'rate-limited'|'invalid'|'server'} kind
   * @param {number} [status]
   */
  constructor(message, kind, status) {
    super(message)
    this.name = 'PyPiError'
    this.kind = kind
    this.status = status
  }
}

/**
 * Fetch one project's JSON document.
 * @param {string} name project name (any case / separator style)
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<any>} the parsed document
 * @throws {PyPiError} on 404 or transport failure
 */
export async function fetchProject(name, options = {}) {
  const trimmed = String(name ?? '').trim()
  if (trimmed === '') throw new PyPiError('包名不能为空', 'invalid')
  const url = `${JSON_API}/${encodeURIComponent(trimmed)}/json`
  let response
  try {
    const signal = deadline(options.signal)
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal })
  } catch (error) {
    throw new PyPiError(`连接 PyPI 失败：${describeNetworkError(error)}`, 'network')
  }
  if (response.status === 404) {
    throw new PyPiError(`PyPI 上没有名为 ${trimmed} 的项目`, 'not-found', 404)
  }
  if (response.status === 429) {
    throw new PyPiError('PyPI 正在限流，请稍后重试', 'rate-limited', 429)
  }
  if (!response.ok) {
    throw new PyPiError(`PyPI 返回 HTTP ${response.status}`, 'server', response.status)
  }
  try {
    return await response.json()
  } catch {
    throw new PyPiError('PyPI 返回的内容不是合法 JSON', 'server', response.status)
  }
}

/**
 * Turn a caught fetch failure into a short cause without leaking a stack.
 * @param {unknown} error
 * @returns {string}
 */
function describeNetworkError(error) {
  const value = /** @type {{ message?: string, cause?: { code?: string, message?: string } }} */ (error)
  const cause = value?.cause
  if (cause?.code !== undefined) return `${cause.code}${cause.message ? ` (${cause.message})` : ''}`
  if (typeof value?.message === 'string' && value.message !== '') return value.message
  return String(error)
}

/**
 * Read the owner usernames from an ownership block.
 * @param {any} document a project JSON document
 * @returns {string[]}
 */
export function ownersOf(document) {
  const roles = document?.ownership?.roles
  if (!Array.isArray(roles)) return []
  const seen = new Set()
  const owners = []
  for (const role of roles) {
    const user = typeof role?.user === 'string' ? role.user.trim() : ''
    if (user === '' || seen.has(user.toLowerCase())) continue
    seen.add(user.toLowerCase())
    owners.push(user)
  }
  return owners
}

/**
 * Find the most recent upload timestamp across every file of every release.
 * @param {any} document a project JSON document
 * @returns {string | null} ISO-8601 timestamp, or null when the project has no files
 */
export function lastUploadOf(document) {
  const releases = document?.releases
  if (releases === null || typeof releases !== 'object') return null
  let latest = null
  for (const files of Object.values(releases)) {
    if (!Array.isArray(files)) continue
    for (const file of files) {
      const stamp = file?.upload_time_iso_8601 ?? file?.upload_time
      if (typeof stamp !== 'string' || stamp === '') continue
      if (latest === null || stamp > latest) latest = stamp
    }
  }
  return latest
}

/**
 * Count every file across every release.
 * @param {any} document a project JSON document
 * @returns {number}
 */
export function fileCountOf(document) {
  const releases = document?.releases
  if (releases === null || typeof releases !== 'object') return 0
  let total = 0
  for (const files of Object.values(releases)) {
    if (Array.isArray(files)) total += files.length
  }
  return total
}

/**
 * Structured release history, newest first.
 * @param {any} document a project JSON document
 * @returns {Array<{ version: string, fileCount: number, uploadedAt: string | null, yanked: boolean }>}
 */
export function releasesOf(document) {
  const releases = document?.releases
  if (releases === null || typeof releases !== 'object') return []
  const rows = []
  for (const [version, files] of Object.entries(releases)) {
    const list = Array.isArray(files) ? files : []
    let uploadedAt = null
    let yanked = list.length > 0
    for (const file of list) {
      const stamp = file?.upload_time_iso_8601 ?? file?.upload_time
      if (typeof stamp === 'string' && (uploadedAt === null || stamp > uploadedAt)) uploadedAt = stamp
      if (file?.yanked !== true) yanked = false
    }
    if (list.length === 0) yanked = false
    rows.push({ version: String(version), fileCount: list.length, uploadedAt, yanked })
  }
  rows.sort((left, right) => {
    const a = left.uploadedAt ?? ''
    const b = right.uploadedAt ?? ''
    if (a === b) return compareVersions(right.version, left.version)
    return a < b ? 1 : -1
  })
  return rows
}

/**
 * Best-effort version comparison so a release list reads newest-first even
 * when upload timestamps tie (a very common case during one `twine upload`).
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareVersions(left, right) {
  const a = String(left).split(/[.+-]/)
  const b = String(right).split(/[.+-]/)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index]
    const y = b[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1
      continue
    }
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * The compact project view shared by the tools and the settings panel.
 * @typedef {object} PackageView
 * @property {string} name canonical name as PyPI spells it
 * @property {string} version latest version
 * @property {string} summary one-line description
 * @property {string} requiresPython
 * @property {string[]} owner owner usernames
 * @property {number} totalReleases
 * @property {number} fileCount
 * @property {string | null} lastUpload ISO timestamp of the newest file
 * @property {string} projectUrl
 * @property {boolean} yanked whether the latest release is yanked
 * @property {string[]} classifiers a few classifiers, for context
 */

/**
 * Project a JSON document onto {@link PackageView}.
 * @param {any} document
 * @returns {PackageView}
 */
export function toPackageView(document) {
  const info = document?.info ?? {}
  const classifiers = Array.isArray(info.classifiers) ? info.classifiers : []
  return {
    name: typeof info.name === 'string' ? info.name : '',
    version: typeof info.version === 'string' ? info.version : '',
    summary: typeof info.summary === 'string' ? info.summary : '',
    requiresPython: typeof info.requires_python === 'string' ? info.requires_python : '',
    owner: ownersOf(document),
    totalReleases: releasesOf(document).length,
    fileCount: fileCountOf(document),
    lastUpload: lastUploadOf(document),
    projectUrl: typeof info.package_url === 'string' ? info.package_url : '',
    yanked: info.yanked === true,
    classifiers,
  }
}

/**
 * Look a project up and project it. Convenience wrapper over
 * {@link fetchProject} + {@link toPackageView}.
 * @param {string} name
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<PackageView>}
 */
export async function lookupPackage(name, options = {}) {
  return toPackageView(await fetchProject(name, options))
}

/**
 * Decide whether a name is free.
 *
 * PyPI has no dedicated "is this name available" endpoint, so the honest test
 * is the JSON API: a 404 means nothing is published under that name right now.
 * A name that 404s is *not* guaranteed to be registrable — PyPI reserves names
 * and applies PEP 541 name retention — so the result is reported as
 * availability at this moment, not as a promise.
 * @param {string} name
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ name: string, available: boolean, normalized: string, valid: boolean,
 *                     reason: string, existing: PackageView | null }>}
 */
export async function checkName(name, options = {}) {
  const trimmed = String(name ?? '').trim()
  const normalized = normalizeProjectName(trimmed)
  if (trimmed === '' || !isValidProjectName(trimmed)) {
    return {
      name: trimmed,
      normalized,
      valid: false,
      available: false,
      reason: '包名不合法：只能包含字母、数字、点、下划线、连字符，且必须以字母或数字开头结尾',
      existing: null,
    }
  }
  try {
    const document = await fetchProject(trimmed, options)
    return {
      name: trimmed,
      normalized,
      valid: true,
      available: false,
      reason: '该名称已被占用',
      existing: toPackageView(document),
    }
  } catch (error) {
    if (error instanceof PyPiError && error.kind === 'not-found') {
      return {
        name: trimmed,
        normalized,
        valid: true,
        available: true,
        reason: '当前没有项目使用该名称（PyPI 会保留部分名称，注册前请以官网为准）',
        existing: null,
      }
    }
    throw error
  }
}

/** Upload endpoints per repository key. */
export const REPOSITORIES = {
  pypi: { label: 'PyPI', uploadUrl: 'https://upload.pypi.org/legacy/', indexUrl: 'https://pypi.org/simple/' },
  testpypi: { label: 'TestPyPI', uploadUrl: 'https://test.pypi.org/legacy/', indexUrl: 'https://test.pypi.org/simple/' },
}

/**
 * @param {string} repository
 * @returns {{ label: string, uploadUrl: string, indexUrl: string }}
 */
export function repositoryInfo(repository) {
  return REPOSITORIES[repository === 'testpypi' ? 'testpypi' : 'pypi']
}

/**
 * Probe whether an API token authenticates, without uploading anything.
 *
 * PyPI's upload endpoint authenticates before it validates the form, so a
 * request carrying `:action=file_upload` and no file answers 403 for a bad or
 * missing token and a 4xx (not 403) once the token authenticates. That
 * distinction is what this function reports; it is an inference from the
 * endpoint's behaviour, not an official verification API, and the first real
 * upload remains the authoritative check.
 * @param {object} options
 * @param {string} options.token
 * @param {'pypi'|'testpypi'} [options.repository]
 * @param {{ signal?: AbortSignal }} [extra]
 * @returns {Promise<{ verified: boolean | null, status: number, message: string, inconclusive: boolean }>}
 */
export async function probeToken(options, extra = {}) {
  const token = String(options.token ?? '').trim()
  if (token === '') {
    return { verified: false, status: 0, message: '还没有配置令牌', inconclusive: false }
  }
  const repository = repositoryInfo(options.repository)
  const body = new FormData()
  body.set(':action', 'file_upload')
  body.set('protocol_version', '1')
  const auth = Buffer.from(`__token__:${token}`, 'utf8').toString('base64')
  let response
  try {
    const signal = deadline(extra.signal)
    response = await fetch(repository.uploadUrl, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Authorization: `Basic ${auth}` },
      body,
      signal,
    })
  } catch (error) {
    return {
      verified: null,
      status: 0,
      inconclusive: true,
      message: `无法连接 ${repository.label} 上传接口：${describeNetworkError(error)}`,
    }
  }
  const text = await response.text().catch(() => '')
  if (response.status === 403) {
    return {
      verified: false,
      status: 403,
      inconclusive: false,
      message: `${repository.label} 拒绝了该令牌（Invalid or non-existent authentication information）。令牌可能无效、已撤销，或没有目标项目的写权限。`,
    }
  }
  if (response.status >= 400) {
    // Authenticated, then rejected for the deliberately incomplete body.
    return {
      verified: true,
      status: response.status,
      inconclusive: false,
      message: `令牌已通过 ${repository.label} 认证（接口随后因请求体不完整返回 HTTP ${response.status}，这是预期结果）。`,
    }
  }
  return {
    verified: null,
    status: response.status,
    inconclusive: true,
    message: `连接返回了意外状态 HTTP ${response.status}，无法判定令牌有效性。${text.slice(0, 200)}`,
  }
}
