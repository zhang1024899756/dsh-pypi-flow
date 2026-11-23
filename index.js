/**
 * dsh-pypi-flow — PyPI workflow for DeepSeek Harness. Host half.
 *
 * Mounts the PyPI tools, the loopback routes the settings panel talks to, and
 * one system-prompt announcement. Nothing here patches core: the plugin is a
 * normal profile bundle that registers through the public service seams
 * (`tools`, `systemPrompt`, `webServer`) and reads the credential service
 * through `ctx.get('credentials')` so a profile without it still loads with a
 * reduced, still-honest capability set (no persisted token).
 *
 * Registry traffic rides PyPI's public JSON API; publishing constructs the
 * official `multipart/form-data` upload request directly, so neither querying
 * nor publishing needs a local Python toolchain.
 */
import { PyPiStore } from './lib/store.js'
import { buildTools } from './lib/tools.js'
import { makeRoutes } from './lib/routes.js'
import { PYPI_GUIDANCE, SECTION_ORDER } from './lib/guidance.js'

/** Stable cordis plugin name. */
export const name = 'pypi-flow'

/**
 * Services required before the PyPI surfaces can mount.
 *
 * `credentials` is intentionally absent: it is read optionally so a profile
 * without a credential provider still gets querying tools instead of failing
 * to activate. Persisting a token then reports why it cannot.
 */
export const inject = ['tools', 'systemPrompt', 'webServer']

/**
 * @typedef {object} Config
 * @property {boolean} [enabled] master switch for tools, routes and the announcement
 * @property {boolean} [announceToAgent] whether a system-prompt section announces the plugin
 * @property {'pypi'|'testpypi'} [defaultRepository] where a publish goes when the call names no repository
 */

/**
 * Mount the PyPI tools, routes and announcement.
 * @param {import('@deepseek-ai/cordis').Context} ctx host plugin context
 * @param {Config} [config] plugin config from the composition row
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const announceToAgent = config.announceToAgent !== false
  const defaultRepository = config.defaultRepository === 'testpypi' ? 'testpypi' : 'pypi'

  // Optional dependency: a profile without a credential provider can still query PyPI.
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  const store = new PyPiStore({ credentials: credentials ?? undefined })
  const toolContext = { store, defaultRepository }

  /** @type {undefined | (() => void)} */
  let disposeTools
  /** @type {undefined | (() => void)} */
  let disposeRoutes
  /** @type {undefined | (() => void)} */
  let disposeSection

  /** @returns {void} */
  const unmount = () => {
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
  }

  /** @returns {void} */
  const mount = () => {
    unmount()
    if (!enabled) return
    disposeTools = ctx.effect(() => {
      const disposers = buildTools(toolContext).map((tool) =>
        ctx.tools.register(/** @type {any} */ (tool)),
      )
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-pypi-flow: tools')
    disposeRoutes = ctx.effect(() => {
      const disposers = makeRoutes({ store }).map((route) => ctx.webServer.register(/** @type {any} */ (route)))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-pypi-flow: routes')
    if (announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-pypi-flow',
        order: SECTION_ORDER,
        text: PYPI_GUIDANCE,
      })
    }
  }

  mount()
  // The profile's patch reload replaces the row config; re-mount when it lands.
  ctx.on('dispose', unmount)
}

export { PyPiStore, statePath, mask, TOKEN_REF, DEFAULT_STATE_FILE } from './lib/store.js'
export {
  JSON_API,
  PyPiError,
  REPOSITORIES,
  checkName,
  compareVersions,
  fetchProject,
  fileCountOf,
  isValidProjectName,
  lastUploadOf,
  lookupPackage,
  normalizeProjectName,
  ownersOf,
  probeToken,
  releasesOf,
  repositoryInfo,
  toPackageView,
} from './lib/pypi.js'
export { buildTools } from './lib/tools.js'
export { makeRoutes, PYPI_API, trackedProjectViews } from './lib/routes.js'
export { PYPI_GUIDANCE, SECTION_ORDER } from './lib/guidance.js'
export { readDistribution } from './lib/metadata.js'
export { repositoryUrls, uploadDistribution } from './lib/upload.js'
