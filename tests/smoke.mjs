/**
 * dsh-pypi-flow — host-side smoke tests.
 *
 * Runs offline and without Python. Every case gets its own state file, because
 * a shared one turns an earlier case's binding into a later case's fixture and
 * hides real bugs behind ordering.
 *
 * The distribution-parsing and uploader suites live in `tests/uploader.mjs` and
 * are imported at the end, so `node tests/smoke.mjs` covers the whole package.
 *
 * What is asserted here is the behaviour that would break silently in
 * production: state normalization, credential precedence, route hardening, the
 * PEP 503 identity rule, and the "never leak a token" invariant.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Keep any accidental network case short instead of hanging the suite.
process.env.DSH_PYPI_FLOW_TIMEOUT_MS = '2500'

let passed = 0
const failures = []

/**
 * @param {string} label
 * @param {() => unknown | Promise<unknown>} body
 * @returns {Promise<void>}
 */
async function test(label, body) {
  try {
    await body()
    passed += 1
    process.stdout.write(`  ok  ${label}\n`)
  } catch (error) {
    failures.push({ label, error })
    process.stdout.write(`  FAIL ${label}\n        ${/** @type {Error} */ (error)?.message}\n`)
  }
}

const workDir = await mkdtemp(path.join(tmpdir(), 'dsh-pypi-flow-'))

const storeModule = await import('../lib/store.js')
const pypi = await import('../lib/pypi.js')
const routesModule = await import('../lib/routes.js')
const toolsModule = await import('../lib/tools.js')
const { PyPiStore, mask, statePath } = storeModule

let stateSeq = 0

/**
 * Build a store backed by its own fresh state file.
 * @param {{ credentials?: any, initial?: unknown }} [options]
 * @returns {Promise<PyPiStore>}
 */
async function freshStore(options = {}) {
  const file = path.join(workDir, `state-${(stateSeq += 1)}.json`)
  if (options.initial !== undefined) {
    await writeFile(file, typeof options.initial === 'string' ? options.initial : JSON.stringify(options.initial), 'utf8')
  }
  process.env.DSH_PYPI_FLOW_STATE = file
  return options.credentials !== undefined ? new PyPiStore({ credentials: options.credentials }) : new PyPiStore()
}

/**
 * A fake credential service with the same surface the store uses.
 * @param {string | undefined} initial
 */
function fakeCredentialService(initial) {
  /** @type {string | undefined} */
  let stored = initial
  return {
    /** @returns {Promise<{ value: string } | undefined>} */
    async resolve() {
      return stored === undefined ? undefined : { value: stored }
    },
    async describe() {
      return { configured: stored !== undefined }
    },
    /** @param {string} _ref @param {string} value */
    async set(_ref, value) {
      stored = value
    },
    async unset() {
      stored = undefined
    },
    /** test hook */
    peek() {
      return stored
    },
  }
}

process.stdout.write('\nstate store\n')

await test('first run yields an empty state on the configured path', async () => {
  const store = await freshStore()
  const state = await store.state()
  assert.equal(state.username, '')
  assert.deepEqual(state.projects, [])
  assert.equal(state.defaultRepository, 'pypi')
  assert.equal(state.lastPublish, null)
  assert.equal(statePath(), process.env.DSH_PYPI_FLOW_STATE)
})

await test('patch persists a 0600 JSON file that contains no secret', async () => {
  const store = await freshStore()
  await store.patch({ username: 'zhang1024899756', defaultRepository: 'testpypi' })
  const raw = await readFile(statePath(), 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.username, 'zhang1024899756')
  assert.equal(parsed.defaultRepository, 'testpypi')
  assert.ok(!/pypi-ag/i.test(raw), 'state file must not contain a token')
  if (process.platform !== 'win32') {
    const info = await stat(statePath())
    assert.equal(info.mode & 0o777, 0o600)
  }
})

await test('addProject treats separator and case variants as one project (PEP 503)', async () => {
  const store = await freshStore()
  const first = await store.addProject('Pre_Sales-Kit')
  assert.equal(first.added, true)
  // PyPI resolves my_pkg / my.pkg / my-pkg to the same project, so all three
  // spellings must collapse into one tracked row.
  const second = await store.addProject('pre.sales.kit')
  const third = await store.addProject('PRE-SALES-KIT')
  assert.equal(second.added, false)
  assert.equal(third.added, false)
  assert.equal(third.state.projects.length, 1)
  assert.equal(third.state.projects[0].name, 'Pre_Sales-Kit')
})

await test('a state file written with duplicate spellings collapses on read', async () => {
  const store = await freshStore({
    initial: { username: '', defaultRepository: 'pypi', projects: [{ name: 'My_Pkg', addedAt: '' }, { name: 'my.pkg', addedAt: '' }] },
  })
  const state = await store.state()
  assert.equal(state.projects.length, 1)
})

await test('removeProject matches the same normalized identity', async () => {
  const store = await freshStore()
  await store.addProject('demo-pkg')
  const removed = await store.removeProject('DEMO_pkg')
  assert.equal(removed.removed, true)
  const again = await store.removeProject('demo-pkg')
  assert.equal(again.removed, false)
  assert.deepEqual(again.state.projects, [])
})

await test('a corrupt state file degrades to defaults instead of throwing', async () => {
  const store = await freshStore({ initial: '{not json' })
  const state = await store.state()
  assert.deepEqual(state.projects, [])
  assert.equal(state.username, '')
})

await test('concurrent patches serialize instead of losing a write', async () => {
  const store = await freshStore()
  await Promise.all([store.addProject('alpha'), store.addProject('beta'), store.addProject('gamma')])
  const state = await store.state()
  assert.deepEqual(
    state.projects.map((project) => project.name).sort(),
    ['alpha', 'beta', 'gamma'],
  )
})

process.stdout.write('\ncredentials\n')

await test('without a credential service, persisting a token fails loudly', async () => {
  const store = await freshStore()
  await assert.rejects(() => store.setToken('pypi-AgEIcHlwaS5vcmcTESTONLY'), /凭据服务/)
})

await test('session token works without persistence and is masked in views', async () => {
  const store = await freshStore()
  store.setSessionToken('pypi-AgEIcHlwaS5vcmcSESSIONONLY1234')
  const view = await store.view()
  assert.equal(view.tokenConfigured, true)
  assert.equal(view.tokenSession, true)
  assert.equal(view.tokenPersistent, false)
  assert.ok(!view.tokenMasked.includes('SESSIONONLY'), 'mask must not expose the middle of the token')
})

await test('token precedence is argument > session > stored', async () => {
  const store = await freshStore({ credentials: fakeCredentialService(undefined) })
  assert.equal(await store.resolveToken(), undefined)
  await store.setToken('pypi-stored-0001')
  assert.equal((await store.resolveToken())?.source, 'stored')
  store.setSessionToken('pypi-session-0002')
  assert.equal((await store.resolveToken())?.source, 'session')
  assert.equal((await store.resolveToken('pypi-arg-0003'))?.source, 'argument')
  await store.clearToken()
  assert.equal(await store.resolveToken(), undefined)
})

await test('a stored token is re-read per operation, so rotation takes effect', async () => {
  const credentials = fakeCredentialService('pypi-first-1111')
  const store = await freshStore({ credentials })
  assert.equal((await store.resolveToken())?.token, 'pypi-first-1111')
  await credentials.set('PYPI_API_TOKEN', 'pypi-rotated-2222')
  assert.equal((await store.resolveToken())?.token, 'pypi-rotated-2222')
})

await test('mask keeps only a short head and tail', () => {
  assert.equal(mask(''), '')
  assert.equal(mask('short'), 'sh****')
  const masked = mask('pypi-AgEIcHlwaS5vcmcABCDEFGH')
  assert.ok(masked.startsWith('pypi-A'))
  assert.ok(masked.endsWith('EFGH'))
  assert.ok(masked.includes('****'))
  assert.ok(masked.length < 'pypi-AgEIcHlwaS5vcmcABCDEFGH'.length)
})

process.stdout.write('\nPyPI helpers\n')

await test('normalizeProjectName implements PEP 503', () => {
  assert.equal(pypi.normalizeProjectName('Pre_Sales.Kit'), 'pre-sales-kit')
  assert.equal(pypi.normalizeProjectName('a--b__c..d'), 'a-b-c-d')
  assert.equal(pypi.normalizeProjectName('  Django  '), 'django')
})

await test('isValidProjectName follows the PEP 508 name rule', () => {
  assert.equal(pypi.isValidProjectName('my-pkg'), true)
  assert.equal(pypi.isValidProjectName('my_pkg.2'), true)
  assert.equal(pypi.isValidProjectName('-leading'), false)
  assert.equal(pypi.isValidProjectName('trailing-'), false)
  assert.equal(pypi.isValidProjectName('has space'), false)
  assert.equal(pypi.isValidProjectName(''), false)
})

await test('ownersOf de-duplicates and skips malformed roles', () => {
  const owners = pypi.ownersOf({
    ownership: { organization: null, roles: [{ role: 'Owner', user: 'alice' }, { role: 'Maintainer', user: 'ALICE' }, { role: 'Owner' }, {}] },
  })
  assert.deepEqual(owners, ['alice'])
})

await test('releasesOf sorts newest-first and marks yanked releases', () => {
  const rows = pypi.releasesOf({
    releases: {
      '1.0.0': [{ upload_time_iso_8601: '2024-01-01T00:00:00Z', yanked: false }],
      '2.0.0': [
        { upload_time_iso_8601: '2025-01-01T00:00:00Z', yanked: true },
        { upload_time_iso_8601: '2025-01-02T00:00:00Z', yanked: true },
      ],
      '0.9.0': [],
    },
  })
  assert.deepEqual(rows.map((row) => row.version), ['2.0.0', '1.0.0', '0.9.0'])
  assert.equal(rows[0].yanked, true)
  assert.equal(rows[0].fileCount, 2)
  assert.equal(rows[2].fileCount, 0)
})

await test('toPackageView projects a JSON document safely', () => {
  const view = pypi.toPackageView({
    info: {
      name: 'demo',
      version: '1.2.3',
      summary: 's',
      requires_python: '>=3.11',
      package_url: 'https://pypi.org/project/demo/',
      yanked: false,
      classifiers: ['A'],
    },
    releases: { '1.2.3': [{ upload_time_iso_8601: '2025-05-05T00:00:00Z' }] },
    ownership: { roles: [{ user: 'bob' }] },
  })
  assert.equal(view.name, 'demo')
  assert.equal(view.totalReleases, 1)
  assert.deepEqual(view.owner, ['bob'])
  assert.equal(view.lastUpload, '2025-05-05T00:00:00Z')
})

await test('toPackageView survives a malformed document', () => {
  const view = pypi.toPackageView({})
  assert.equal(view.name, '')
  assert.deepEqual(view.owner, [])
  assert.equal(view.totalReleases, 0)
  assert.equal(view.lastUpload, null)
})

await test('compareVersions orders numeric segments', () => {
  assert.ok(pypi.compareVersions('1.10.0', '1.9.0') > 0)
  assert.ok(pypi.compareVersions('2.0.0', '1.99.99') > 0)
  assert.equal(pypi.compareVersions('1.0.0', '1.0.0'), 0)
})

await test('checkName rejects an invalid name without any network call', async () => {
  const result = await pypi.checkName('bad name!')
  assert.equal(result.valid, false)
  assert.equal(result.available, false)
  assert.match(result.reason, /不合法/)
})

await test('repositoryInfo falls back to PyPI for an unknown key', () => {
  assert.match(pypi.repositoryInfo('nope').uploadUrl, /upload\.pypi\.org/)
  assert.match(pypi.repositoryInfo('testpypi').uploadUrl, /test\.pypi\.org/)
})

process.stdout.write('\nroutes\n')

/**
 * Minimal IncomingMessage/ServerResponse pair, good enough for these handlers.
 * @param {{ method?: string, url?: string, body?: unknown, remoteAddress?: string }} init
 */
function mockExchange(init = {}) {
  const listeners = new Map()
  const request = {
    method: init.method ?? 'GET',
    url: init.url ?? '/',
    socket: { remoteAddress: init.remoteAddress ?? '127.0.0.1' },
    on(event, handler) {
      listeners.set(event, handler)
      return request
    },
    destroy() {},
  }
  const response = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value)
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
  /**
   * @param {(req: any, res: any) => Promise<void>} handler
   * @returns {Promise<{ status: number, json: any }>}
   */
  const run = async (handler) => {
    const pending = handler(request, response)
    if (init.body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(init.body), 'utf8'))
    listeners.get('end')?.()
    await pending
    return { status: response.statusCode, json: response.body === '' ? null : JSON.parse(response.body) }
  }
  return { run }
}

/**
 * @param {Array<Record<string, any>>} routes
 * @param {string} pathname
 */
function findRoute(routes, pathname) {
  const route = routes.find((candidate) => candidate.path === pathname)
  assert.ok(route !== undefined, `route ${pathname} must be registered`)
  return route
}

await test('state route returns a secret-free snapshot', async () => {
  const store = await freshStore()
  await store.patch({ username: 'alice' })
  store.setSessionToken('pypi-AgEIcHlwaS5vcmcROUTETEST99')
  const routes = routesModule.makeRoutes({ store })
  const { status, json } = await mockExchange().run(findRoute(routes, routesModule.PYPI_API.state).handler)
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.username, 'alice')
  assert.equal(json.tokenConfigured, true)
  assert.deepEqual(json.projects, [])
  assert.ok(!JSON.stringify(json).includes('ROUTETEST99'), 'state must never echo the token')
})

await test('non-loopback requests are refused', async () => {
  const store = await freshStore()
  const routes = routesModule.makeRoutes({ store })
  const { status, json } = await mockExchange({ remoteAddress: '10.0.0.7' }).run(
    findRoute(routes, routesModule.PYPI_API.state).handler,
  )
  assert.equal(status, 403)
  assert.equal(json.ok, false)
})

await test('wrong method is rejected with 405', async () => {
  const store = await freshStore()
  const routes = routesModule.makeRoutes({ store })
  const { status } = await mockExchange({ method: 'GET' }).run(
    findRoute(routes, routesModule.PYPI_API.credentials).handler,
  )
  assert.equal(status, 405)
})

await test('credentials route saves a session token and never echoes it', async () => {
  const store = await freshStore()
  const routes = routesModule.makeRoutes({ store })
  const { status, json } = await mockExchange({
    method: 'POST',
    body: { username: 'bob', sessionToken: 'pypi-AgEIcHlwaS5vcmcSESSIONX1' },
  }).run(findRoute(routes, routesModule.PYPI_API.credentials).handler)
  assert.equal(status, 200)
  assert.equal(json.username, 'bob')
  assert.equal(json.tokenConfigured, true)
  assert.ok(!JSON.stringify(json).includes('SESSIONX1'))
})

await test('projects route rejects an unknown action', async () => {
  const store = await freshStore()
  const routes = routesModule.makeRoutes({ store })
  const { status } = await mockExchange({ method: 'POST', body: { action: 'nope', name: 'x' } }).run(
    findRoute(routes, routesModule.PYPI_API.projects).handler,
  )
  assert.equal(status, 400)
})

await test('projects route removes a tracked project', async () => {
  const store = await freshStore()
  await store.addProject('tracked-demo')
  const routes = routesModule.makeRoutes({ store })
  const { status, json } = await mockExchange({ method: 'POST', body: { action: 'remove', name: 'tracked-demo' } }).run(
    findRoute(routes, routesModule.PYPI_API.projects).handler,
  )
  assert.equal(status, 200)
  assert.equal(json.removed, true)
  assert.deepEqual(json.projects, [])
})

await test('lookup route rejects an empty name without touching the network', async () => {
  const store = await freshStore()
  const routes = routesModule.makeRoutes({ store })
  const { status } = await mockExchange({ url: '/api/dsh-pypi-flow/lookup?name=' }).run(
    findRoute(routes, routesModule.PYPI_API.lookup).handler,
  )
  assert.equal(status, 400)
})

await test('every route path lives under the plugin prefix', async () => {
  const store = await freshStore()
  for (const route of routesModule.makeRoutes({ store })) {
    assert.ok(String(route.path).startsWith('/api/dsh-pypi-flow/'), `${route.path} must stay namespaced`)
    assert.equal(typeof route.handler, 'function')
  }
})

process.stdout.write('\ntools\n')

/**
 * @param {string} name
 * @param {PyPiStore} store
 */
function toolNamed(name, store) {
  const tool = toolsModule.buildTools({ store, defaultRepository: 'pypi' }).find((entry) => entry.name === name)
  assert.ok(tool !== undefined, `tool ${name} must exist`)
  return tool
}

await test('every tool declares a name, description, object parameters and output', async () => {
  const store = await freshStore()
  const tools = toolsModule.buildTools({ store, defaultRepository: 'pypi' })
  assert.ok(tools.length >= 8)
  const names = new Set()
  for (const tool of tools) {
    assert.ok(String(tool.name).startsWith('pypi_'), `${tool.name} must use the pypi_ prefix`)
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.ok(!names.has(tool.name), `duplicate tool name ${tool.name}`)
    names.add(tool.name)
  }
})

await test('output.render produces a text content block', async () => {
  const store = await freshStore()
  const blocks = toolNamed('pypi_status', store).output.render({}, { ok: true, message: 'hello' })
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }])
})

await test('status tool reports an unbound account, isolated from other cases', async () => {
  const store = await freshStore()
  const value = await toolNamed('pypi_status', store).execute({}, {})
  assert.equal(value.ok, true)
  assert.match(value.message, /未绑定/)
  assert.equal(value.tokenConfigured, false)
  assert.equal(value.projectCount, 0)
})

await test('publish tool refuses a missing path', async () => {
  const store = await freshStore()
  const value = await toolNamed('pypi_publish', store).execute({ path: '' }, {})
  assert.equal(value.ok, false)
})

await test('publish tool refuses a nonexistent path', async () => {
  const store = await freshStore()
  const value = await toolNamed('pypi_publish', store).execute({ path: path.join(workDir, 'nope.whl') }, {})
  assert.equal(value.ok, false)
  assert.match(value.message, /不存在/)
})

await test('publish tool refuses an empty distribution directory', async () => {
  const store = await freshStore()
  const empty = path.join(workDir, 'empty-dist')
  await mkdir(empty, { recursive: true })
  const value = await toolNamed('pypi_publish', store).execute({ path: empty }, {})
  assert.equal(value.ok, false)
  assert.match(value.message, /没有找到发行包/)
})

await test('publish tool refuses to upload without any token', async () => {
  const store = await freshStore()
  const distDir = path.join(workDir, 'dist')
  await mkdir(distDir, { recursive: true })
  await writeFile(path.join(distDir, 'demo-1.0.0.tar.gz'), 'x')
  const value = await toolNamed('pypi_publish', store).execute({ path: distDir }, {})
  assert.equal(value.ok, false)
  assert.match(value.message, /令牌/)
})

await test('config tool binds a username and adds/removes a project', async () => {
  const store = await freshStore()
  const tool = toolNamed('pypi_config', store)
  const bound = await tool.execute({ username: 'zhang1024899756', addProject: 'demo-pkg' }, {})
  assert.equal(bound.ok, true)
  const view = await store.view()
  assert.equal(view.username, 'zhang1024899756')
  assert.ok(view.projects.some((project) => project.name === 'demo-pkg'))
  const removed = await tool.execute({ removeProject: 'demo-pkg' }, {})
  assert.equal(removed.ok, true)
  assert.ok(!(await store.view()).projects.some((project) => project.name === 'demo-pkg'))
})

await test('config tool reports when there is nothing to change', async () => {
  const store = await freshStore()
  const value = await toolNamed('pypi_config', store).execute({}, {})
  assert.equal(value.ok, true)
  assert.match(value.message, /没有需要修改/)
})

await test('config tool accepts frozen arguments and never echoes the token', async () => {
  const store = await freshStore()
  // The real executor hands in a frozen, losslessly-snapshotted object, so a
  // tool that mutates its arguments would throw here rather than in production.
  const args = Object.freeze({ sessionToken: 'pypi-AgEIcHlwaS5vcmcNEVERECHO' })
  const value = await toolNamed('pypi_config', store).execute(args, {})
  assert.equal(value.ok, true)
  assert.ok(!JSON.stringify(value).includes('NEVERECHO'), 'tool result must not contain the token')
  assert.equal((await store.tokenView()).configured, true, 'the session token must actually be stored')
})

await test('my-packages reports an empty list on a fresh state', async () => {
  const store = await freshStore()
  const value = await toolNamed('pypi_my_packages', store).execute({}, {})
  assert.equal(value.ok, true)
  assert.equal(value.count, 0)
  assert.match(value.message, /空的/)
})

await test('delete guide states that no delete API exists and links the manage page', async () => {
  const store = await freshStore()
  // A name that certainly is not on PyPI keeps this case off the network path
  // that would otherwise answer from a live project.
  const name = 'dsh-pypi-flow-definitely-not-published-0000'
  const value = await toolNamed('pypi_delete_guide', store).execute({ name, version: '1.0.0' }, {})
  assert.equal(value.ok, true)
  assert.equal(value.apiAvailable, false)
  assert.match(value.message, /未提供 API|没有.*API/)
  assert.match(value.message, /yank/i)
  assert.ok(value.manageUrl.includes(`pypi.org/manage/project/${name}/release/1.0.0/`))
  assert.ok(value.projectUrl.includes(`pypi.org/project/${name}/`))
})

await test('check-name rejects an invalid name without a network call', async () => {
  const store = await freshStore()
  const value = await toolNamed('pypi_check_name', store).execute({ name: 'bad name!' }, {})
  assert.equal(value.ok, false)
  assert.match(value.message, /不合法/)
})

process.stdout.write('\npackage identity\n')

await test('locale files carry meta.title and meta.description in both languages', async () => {
  for (const locale of ['zh', 'en']) {
    const raw = await readFile(path.join(import.meta.dirname, '..', 'locale', `${locale}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    assert.ok(parsed.meta.title.length > 2, `${locale} title too short`)
    assert.ok(parsed.meta.description.length > 20, `${locale} description too short`)
    assert.ok(parsed.meta.description.length < 400, `${locale} description too long for a settings row`)
    assert.ok(!/template/i.test(parsed.meta.description), `${locale} description must not be template copy`)
  }
})

await test('the package entry point imports cleanly and mounts nine tools', async () => {
  // `node --check` only validates syntax, so a wrong relative specifier passes
  // it and then fails at plugin activation. Importing the real entry point is
  // the check that catches that class of mistake.
  const entry = await import('../index.js')
  assert.equal(entry.name, 'pypi-flow')
  assert.deepEqual(entry.inject, ['tools', 'systemPrompt', 'webServer'])
  assert.equal(typeof entry.apply, 'function')
  assert.equal(typeof entry.PYPI_GUIDANCE, 'string')
  const store = await freshStore()
  assert.equal(entry.buildTools({ store, defaultRepository: 'pypi' }).length, 9)
  assert.ok(Array.isArray(entry.makeRoutes({ store })))
})

await test('manifest declares the bundle patch, client half and icon export', async () => {
  const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.exports['./client'].includes('client.js'))
  assert.ok(manifest.exports['./icon'].includes('icon.svg'))
  assert.ok(manifest.files.includes('lib'))
  assert.ok(manifest.files.includes('client.js'))
})

await test('cordis patch inserts exactly one row named after the package', async () => {
  const yaml = await readFile(path.join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
  const inserts = yaml.split('\n').filter((line) => /^\s*-\s+insert:/.test(line))
  assert.equal(inserts.length, 1)
  assert.match(yaml, /name: dsh-pypi-flow/)
  assert.match(yaml, /id: pypi-flow/)
})

await test('icon is a parseable SVG within the size limit', async () => {
  const raw = await readFile(path.join(import.meta.dirname, '..', 'icon.svg'), 'utf8')
  assert.match(raw, /^<svg[\s>]/)
  assert.match(raw, /viewBox="0 0 64 64"/)
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 256 * 1024)
})

process.stdout.write('\ndistributions and uploader\n')

// Delegate to the dedicated suite; it owns its fixtures and asserts the wire format.
try {
  await import('./uploader.mjs')
} catch (error) {
  failures.push({ label: 'uploader suite', error: /** @type {Error} */ (error) })
  process.stdout.write(`  FAIL uploader suite\n        ${/** @type {Error} */ (error)?.message}\n`)
}

await rm(workDir, { recursive: true, force: true })

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) {
    process.stdout.write(`\n[${failure.label}]\n${failure.error?.stack ?? failure.error}\n`)
  }
  process.exitCode = 1
}
