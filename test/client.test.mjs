/**
 * Browser-half test: drives the Client plugin with a fake module loader and a fake
 * Cordis context. Run with `node test/client.test.mjs` (also part of `npm test`).
 */
const CLIENT = new URL('../client.js', import.meta.url)

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
}

const store = new Map()
let moduleExports

globalThis.window = {
  localStorage: {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  },
  __ModuleLoader__: {
    load({ id, factory }) {
      results.push({ name: 'loader id is the package name', ok: id === 'dsh-side', detail: id })
      moduleExports = factory(name => {
        if (name !== 'react') throw new Error(`unexpected require ${name}`)
        return {
          createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
          Fragment: 'fragment',
          useState: value => [value, () => {}],
          useMemo: fn => fn(),
          useCallback: fn => fn,
          useEffect: () => {},
          useRef: value => ({ current: value }),
          useSyncExternalStore: (_s, get) => get(),
        }
      })
    },
  },
}

await import(CLIENT.href)
check('registers a module', moduleExports !== undefined)
for (const service of ['sessions', 'sidebarRight', 'uiWorkspace', 'commandUi', 'slots', 'locale']) {
  check(`injects ${service}`, moduleExports?.inject?.includes(service), moduleExports?.inject)
}
check('no test seam for hand-written UI', moduleExports?.__internal === undefined)

const live = []
function disposeLive() {
  for (const client of live.splice(0)) {
    for (const dispose of client.effects) { try { dispose?.() } catch {} }
  }
}

function makeClient(options = {}) {
  const calls = {
    create: [], fork: [], open: [], archive: [], renamed: [], registrations: [],
    slotInjects: [], injected: [], resources: [], tabs: [], archived: [], views: [], eventDefinitions: [],
  }
  const effects = []
  const commands = {}
  let closeHandler

  const locale = {
    register() { return () => {} },
    bind(namespace) { return key => `${namespace}:${key}` },
  }

  const ctxUiConversation = {
    views: { register(definition) { calls.views.push(definition); return () => {} } },
    events: { register(definition) { calls.eventDefinitions.push(definition); return () => {} } },
  }

  const byId = { 'parent-1': { workspaceId: 'ws-1', cwd: 'F:/work' } }
  const sessions = {
    list: { getSnapshot: () => ({ byId }) },
    async create(opts) {
      calls.create.push(opts)
      if (options.createThrows) throw new Error('create failed')
      const childId = options.childIds !== undefined ? options.childIds.shift() : (options.childId ?? 'child-side-1')
      byId[childId] = { cwd: 'F:/work', blank: true }
      return childId
    },
    async fork(request) {
      calls.fork.push(request)
      if (options.forkThrows) throw new Error('fork failed')
      const childId = options.childIds !== undefined ? options.childIds.shift() : (options.childId ?? 'child-side-1')
      byId[childId] = { cwd: 'F:/work', blank: true }
      return childId
    },
    retain(target, opts) {
      calls.retained = { target, opts }
      return { release: () => { calls.released = true } }
    },
    scope: sessionId => ({ sessionId }),
    sessionOf: () => ({
      async rename(title) { calls.renamed.push(title); return { ok: true, value: { title, seq: 1 } } },
    }),
  }

  const scope = {
    sessions,
    uiConversation: ctxUiConversation,
    resources: { register(provider) { calls.resources.push(provider); return () => {} } },
    sidebarRightTabs: { register(definition) { calls.tabs.push(definition); return () => {} } },
    slots: {
      inject(name, cb) { calls.slotInjects.push(name); effects.push(cb()); return () => {} },
      register(definition) {
        if (options.rejectSlots === true) throw new Error('duplicate declaration')
        calls.registrations.push(definition)
        return () => {}
      },
    },
    effect(fn) { effects.push(fn()); return () => {} },
  }

  const ctx = {
    effects,
    locale,
    sessions,
    slots: scope.slots,
    inject(deps, callback) { calls.injected.push([...deps]); callback(scope); return () => {} },
    effect(fn) { effects.push(fn()); return () => {} },
    get(name) {
      if (name !== 'workspaces') return undefined
      return { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', sessionIds: ['parent-1'] }, { workspaceId: 'ws-2', sessionIds: [] }] }) } }
    },
    commandUi: { register(contribution) { commands[contribution.name] = contribution; return () => {} } },
    uiConversation: {
      views: { register(definition) { calls.views.push(definition); return () => {} } },
      events: { register(definition) { calls.eventDefinitions.push(definition); return () => {} } },
    },
    sidebarRight: {
      openResource(address, opts) {
        if (options.openThrows) throw new Error('no surface')
        calls.open.push({ address, opts })
      },
      openTabs: { getSnapshot: () => options.openTabs ?? [] },
      registerCloseHandler(kind, handler) { calls.closeKind = kind; closeHandler = handler; return () => {} },
    },
    uiWorkspace: {
      async archiveSession(sessionId, archOpts) { calls.archive.push({ sessionId, opts: archOpts }) },
      openSession(sessionId) { calls.openedInMain = sessionId },
    },
  }
  moduleExports.apply(ctx)
  const client = { calls, commands, effects, runClose: (parentId, tab) => closeHandler?.(parentId, tab) }
  live.push(client)
  return client
}

const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))

// --- 1. /side creates a blank session, titles it with the parent id, opens the panel
{
  store.clear()
  const c = makeClient()
  const command = c.commands.side
  check('/side is registered', command !== undefined)
  check('command is a bare action', command?.ui?.kind === 'action', command?.ui)
  check('label is localized', command?.label?.() === 'dsh-side:command.label', command?.label?.())
  check('command row carries the mark', typeof command?.icon === 'function', command?.icon)

  command.ui.run({ sessionId: 'parent-1' })
  await settle()
  check('forks the parent conversation', c.calls.fork.length === 1 && c.calls.create.length === 0, c.calls.fork)
  check('passes only the parent id', c.calls.fork[0]?.sessionId === 'parent-1' && Object.keys(c.calls.fork[0]).length === 1, c.calls.fork[0])
  check('titles the first side session', c.calls.renamed[0] === 'dsh-side:session.title', c.calls.renamed)
  const address = c.calls.open[0]?.address
  check('opens the side panel', typeof address === 'string' && address.endsWith('/child-side-1'), address)
  check('opens the sidechat kind', c.calls.open[0]?.opts?.kind === 'sidechat', c.calls.open[0]?.opts)
  check('remembers the child for cleanup', JSON.parse(store.get('dsh-side.sessions.v1') ?? '[]').includes('child-side-1'))
  check('does not archive the new session', c.calls.archive.length === 0, c.calls.archive)
}

// --- 1b. numbering follows the side sessions that still exist
{
  store.clear()
  const client = makeClient({ childIds: ['child-a-1', 'child-b-2'] })
  client.commands.side.ui.run({ sessionId: 'parent-1' })
  await settle()
  client.commands.side.ui.run({ sessionId: 'parent-1' })
  await settle()
  check('numbers the second side session', client.calls.renamed[1] === 'dsh-side:session.title（2）', client.calls.renamed)
  check('both fork the same parent', client.calls.fork.every(call => call.sessionId === 'parent-1'), client.calls.fork)

  // Deleting the first frees its number: the next panel takes it again.
  disposeLive()
  store.clear()
  const reopened = makeClient({ childId: 'child-c-3' })
  reopened.commands.side.ui.run({ sessionId: 'parent-1' })
  await settle()
  check('starts again at 1 after a deletion', reopened.calls.renamed[0] === 'dsh-side:session.title', reopened.calls.renamed)
}

// --- 2. the tab renders the product's conversation, declares no custom renderer
{
  const c = makeClient()
  const body = c.calls.registrations.find(r => r.name === 'sidebar.right.pane.tab')
  check('tab body declares only its conversation child', JSON.stringify(Object.keys(body?.children ?? {})) === '["side.chat.conversation"]', body?.children)
  const title = c.calls.registrations.find(r => r.name === 'sidebar.right.pane.tab.title')
  check('registers the chip title component', title?.key === 'dsh-side/chat', title)
  check('injects the conversation service for the transcript', c.calls.injected.some(deps => deps.includes('uiConversation')), c.calls.injected)
  check('content seat registered', c.calls.registrations.some(r => r.name === 'side.chat.conversation'))
  const tab = c.calls.tabs[0]
  check('tab type still opens our addresses', tab?.canOpen('dsh-resource://sidechat/session/x') === true)
}

// --- 2a. the side transcript target is registered
{
  const c = makeClient()
  check('registers the side view target', c.calls.views.some(v => v.target === 'side' && typeof v.create === 'function'), c.calls.views.map(v => v.target))
  const kinds = c.calls.eventDefinitions.map(d => d.kind)
  check('registers the seed boundary definition', kinds.includes('side-seed'), kinds)
  check('registers user/assistant/tool definitions', kinds.includes('side-user') && kinds.includes('side-assistant') && kinds.includes('side-tool'), kinds)
  const builder = c.calls.views[0]?.create()
  check('builder publishes an empty snapshot', Array.isArray(builder?.empty?.nodes) && builder.empty.inherited === 0, builder?.empty)
  builder?.replace?.({ nodes: [
    { key: 'seed', kind: 'side-seed', id: 'seed', target: 'side', data: { seq: 5 } },
    { key: 'user:1', kind: 'side-user', id: '1', target: 'side', data: { seq: 3, text: 'older' } },
    { key: 'user:2', kind: 'side-user', id: '2', target: 'side', data: { seq: 7, text: 'own' } },
  ], timeline: {} })
  const snapshot = builder.replace({ nodes: [], timeline: {} })
  check('drops the inherited prefix', Array.isArray(snapshot?.nodes) && snapshot.nodes.length === 0, snapshot)
}

// --- 2b. the start page carries our card and its page type
{
  const c = makeClient()
  const page = c.calls.tabs.find(tab => tab.kind === 'sidechat-new')
  check('registers a guide page type', page !== undefined, c.calls.tabs.map(t => t.kind))
  check('declares one guide entry', Array.isArray(page?.guide) && page.guide.length === 1, page?.guide)
  check('guide entry carries copy', typeof page?.guide?.[0]?.title === 'function' && typeof page?.guide?.[0]?.description === 'function')
  check('guide entry has an order', Number.isSafeInteger(page?.guide?.[0]?.order), page?.guide?.[0])
  check('guide entry carries the mark', typeof page?.guide?.[0]?.icon === 'function', page?.guide?.[0]?.icon)
  check('each card opens its own page', page?.multiple === true, page?.multiple)
  const pageBody = c.calls.registrations.find(r => r.key === 'dsh-side/new')
  check('registers the guide page body', pageBody !== undefined, c.calls.registrations.map(r => r.key))
}

// --- 3. closing stops and archives, and forgets the record
{
  store.clear()
  const c = makeClient()
  c.commands.side.ui.run({ sessionId: 'parent-1' })
  await settle()
  c.runClose('parent-1', { contentId: 'dsh-resource://sidechat/session/child-side-1' })
  await settle()
  const closeCall = c.calls.archive.at(-1)
  check('close archives with stopActivity', closeCall?.sessionId === 'child-side-1'
    && closeCall?.opts?.stopActivity === true, closeCall)
  check('closed session is forgotten', !JSON.parse(store.get('dsh-side.sessions.v1') ?? '[]').includes('child-side-1'))
}

// --- 4. failures are contained
{
  const failing = makeClient({ forkThrows: true })
  let threw = false
  try { failing.commands.side.ui.run({ sessionId: 'parent-1' }); await settle() } catch { threw = true }
  check('fork failure does not throw', threw === false)
  check('fork failure opens nothing', failing.calls.open.length === 0)

  const noSurface = makeClient({ openThrows: true })
  noSurface.commands.side.ui.run({ sessionId: 'parent-1' })
  await settle()
  check('panel failure archives the orphan', noSurface.calls.archive[0]?.sessionId === 'child-side-1', noSurface.calls.archive)

  const rejected = makeClient({ rejectSlots: true })
  check('command survives a rejected slot seat', rejected.commands.side !== undefined)
  check('tab types survive a rejected slot seat', rejected.calls.tabs.length === 2, rejected.calls.tabs.map(t => t.kind))
}

disposeLive()

// --- 5. reload reconciliation archives sessions with no open tab
{
  store.clear()
  store.set('dsh-side.sessions.v1', JSON.stringify(['orphan-1', 'kept-1']))
  const c = makeClient({ openTabs: [{ contentId: 'dsh-resource://sidechat/session/kept-1' }] })
  await new Promise(resolve => setTimeout(resolve, 2800))
  const archived = c.calls.archive.map(entry => entry.sessionId)
  check('archives the orphaned side session', archived.includes('orphan-1'), archived)
  check('keeps the one whose tab is open', !archived.includes('kept-1'), archived)
}

const failed = results.filter(r => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${JSON.stringify(r.detail)}`}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
