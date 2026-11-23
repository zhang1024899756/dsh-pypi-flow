/**
 * dsh-pypi-flow — loopback HTTP routes for the web settings panel.
 *
 * Route family: `/api/dsh-pypi-flow/*`. The panel runs in the browser and
 * cannot touch the Host credential service directly, so these routes are the
 * only bridge. They are deliberately narrow and loopback-only:
 *
 * - nothing here ever returns a token, only a mask and a boolean;
 * - `POST /credentials` accepts a token but never echoes it back;
 * - every handler answers JSON, and a failure is `{ ok: false, error }` with a
 *   non-2xx status, so the panel never has to parse an HTML error page.
 */
import { lookupPackage, probeToken, repositoryInfo } from './pypi.js'

/** Route paths, shared with the client bundle. */
export const PYPI_API = {
  state: '/api/dsh-pypi-flow/state',
  credentials: '/api/dsh-pypi-flow/credentials',
  projects: '/api/dsh-pypi-flow/projects',
  refresh: '/api/dsh-pypi-flow/projects/refresh',
  lookup: '/api/dsh-pypi-flow/lookup',
  probe: '/api/dsh-pypi-flow/probe',
}

/**
 * Reject anything that is not a loopback request, so the routes cannot be
 * driven by a remote page or a proxied connection.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === ''
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @returns {void}
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(payload)
}

/**
 * Read and parse a JSON request body with a hard size cap.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limitBytes]
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Fetch one tracked project's live view, degrading to an error row rather than
 * failing the whole list.
 * @param {string} name
 * @param {string} username bound username, '' when unbound
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ name: string, latestVersion: string|null, lastUpload: string|null, fileCount: number,
 *                     ownedByMe: boolean|null, summary: string|null, error: string|null }>}
 */
async function projectView(name, username, signal) {
  try {
    const info = await lookupPackage(name, { signal })
    const normalized = username.trim().toLowerCase()
    return {
      name: info.name,
      latestVersion: info.version,
      lastUpload: info.lastUpload,
      fileCount: info.fileCount,
      ownedByMe: normalized === '' ? null : info.owner.some((owner) => owner.toLowerCase() === normalized),
      summary: info.summary,
      error: null,
    }
  } catch (error) {
    return {
      name,
      latestVersion: null,
      lastUpload: null,
      fileCount: 0,
      ownedByMe: null,
      summary: null,
      error: /** @type {Error} */ (error)?.message ?? String(error),
    }
  }
}

/**
 * Live views for every tracked project.
 * @param {import('./store.js').PyPiStore} store
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Array<Awaited<ReturnType<typeof projectView>>>>}
 */
export async function trackedProjectViews(store, signal) {
  const view = await store.view()
  const rows = []
  for (const project of view.projects) {
    rows.push(await projectView(project.name, view.username, signal))
  }
  return rows
}

/**
 * Build the route list for `ctx.webServer.register`.
 * @param {{ store: import('./store.js').PyPiStore }} deps
 * @returns {Array<Record<string, unknown>>}
 */
export function makeRoutes(deps) {
  const { store } = deps

  /**
   * Wrap one handler with the loopback check, method check, and error mapping.
   * @param {string} method
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler
   */
  const wrap = (method, handler) => async (req, res) => {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '只允许本机访问' })
    if ((req.method ?? 'GET').toUpperCase() !== method) {
      return sendJson(res, 405, { ok: false, error: `只支持 ${method}` })
    }
    try {
      await handler(req, res)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: /** @type {Error} */ (error)?.message ?? String(error) })
    }
  }

  return [
    {
      kind: 'exact',
      path: PYPI_API.state,
      handler: wrap('GET', async (_req, res) => {
        const view = await store.view()
        sendJson(res, 200, {
          ok: true,
          username: view.username,
          tokenConfigured: view.tokenConfigured,
          tokenMasked: view.tokenMasked,
          tokenPersistent: view.tokenPersistent,
          tokenSession: view.tokenSession,
          credentialStoreAvailable: view.credentialStoreAvailable,
          defaultRepository: view.defaultRepository,
          credentialPath: view.statePath,
          lastPublish: view.lastPublish,
          repositories: [
            { key: 'pypi', label: repositoryInfo('pypi').label },
            { key: 'testpypi', label: repositoryInfo('testpypi').label },
          ],
          projects: await trackedProjectViews(store, undefined),
        })
      }),
    },
    {
      kind: 'exact',
      path: PYPI_API.credentials,
      handler: wrap('POST', async (req, res) => {
        const body = await readJsonBody(req)
        const actions = []
        if (body.clearToken === true) {
          await store.clearToken()
          actions.push('cleared')
        }
        if (typeof body.token === 'string' && body.token.trim() !== '') {
          await store.setToken(body.token)
          actions.push('token-saved')
        }
        if (typeof body.sessionToken === 'string' && body.sessionToken.trim() !== '') {
          store.setSessionToken(body.sessionToken)
          actions.push('session-token-set')
        }
        const patch = {}
        if (typeof body.username === 'string') patch.username = body.username.trim()
        if (body.defaultRepository === 'pypi' || body.defaultRepository === 'testpypi') {
          patch.defaultRepository = body.defaultRepository
        }
        if (Object.keys(patch).length > 0) await store.patch(patch)
        const view = await store.view()
        sendJson(res, 200, {
          ok: true,
          actions,
          username: view.username,
          tokenConfigured: view.tokenConfigured,
          tokenMasked: view.tokenMasked,
          tokenPersistent: view.tokenPersistent,
          tokenSession: view.tokenSession,
          defaultRepository: view.defaultRepository,
        })
      }),
    },
    {
      kind: 'exact',
      path: PYPI_API.projects,
      handler: wrap('POST', async (req, res) => {
        const body = await readJsonBody(req)
        const name = String(body.name ?? '').trim()
        if (name === '') return sendJson(res, 400, { ok: false, error: '需要提供项目名' })
        if (body.action === 'remove') {
          const result = await store.removeProject(name)
          if (!result.removed) return sendJson(res, 404, { ok: false, error: `${name} 不在追踪列表中` })
          return sendJson(res, 200, { ok: true, name, removed: true, projects: await trackedProjectViews(store, undefined) })
        }
        if (body.action !== 'add') return sendJson(res, 400, { ok: false, error: 'action 必须是 add 或 remove' })
        const added = await store.addProject(name)
        const view = await projectView(name, (await store.view()).username, undefined)
        sendJson(res, 200, {
          ok: true,
          name,
          added: added.added,
          notFound: view.error !== null && view.latestVersion === null,
          // Optional convenience for the panel: it may show the version it just
          // started tracking, but it must not depend on this field existing.
          lookup: view.error === null ? { version: view.latestVersion, summary: view.summary, ownedByMe: view.ownedByMe } : null,
          projects: await trackedProjectViews(store, undefined),
        })
      }),
    },
    {
      kind: 'exact',
      path: PYPI_API.refresh,
      handler: wrap('GET', async (_req, res) => {
        sendJson(res, 200, { ok: true, projects: await trackedProjectViews(store, undefined) })
      }),
    },
    {
      kind: 'exact',
      path: PYPI_API.lookup,
      handler: wrap('GET', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const name = (url.searchParams.get('name') ?? '').trim()
        if (name === '') return sendJson(res, 400, { ok: false, error: '需要提供包名' })
        try {
          const info = await lookupPackage(name, {})
          sendJson(res, 200, { ok: true, package: info })
        } catch (error) {
          const kind = /** @type {{ kind?: string }} */ (error)?.kind
          sendJson(res, kind === 'not-found' ? 404 : 502, {
            ok: false,
            error: /** @type {Error} */ (error)?.message ?? String(error),
            notFound: kind === 'not-found',
          })
        }
      }),
    },
    {
      kind: 'exact',
      path: PYPI_API.probe,
      handler: wrap('POST', async (_req, res) => {
        const view = await store.view()
        const resolved = await store.resolveToken()
        if (resolved === undefined) {
          return sendJson(res, 200, {
            ok: true,
            result: { verified: false, status: 0, message: '还没有配置令牌，无法验证。', repository: view.defaultRepository },
          })
        }
        const result = await probeToken({ token: resolved.token, repository: view.defaultRepository })
        sendJson(res, 200, {
          ok: true,
          result: {
            verified: result.verified,
            status: result.status,
            message: result.message,
            inconclusive: result.inconclusive,
            repository: view.defaultRepository,
          },
        })
      }),
    },
  ]
}
