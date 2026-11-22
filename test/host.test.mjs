/**
 * Host-half test: context injection and post-close reaping against a real temporary
 * storage root. Run with `node test/host.test.mjs` (also part of `npm test`).
 */
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HOST = new URL('../index.js', import.meta.url)

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
}

const mod = await import(HOST)
check('exports apply', typeof mod.apply === 'function')
check('injects workspaceRegistry', mod.inject?.includes('workspaceRegistry'), mod.inject)
check('injects sessionQuery', mod.inject?.includes('sessionQuery'), mod.inject)
check('registers no slash command', !mod.inject?.includes('commands'), mod.inject)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const PARENT_MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: 'refactor the auth module' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'plan: split token storage' }] },
  { role: 'tool', content: [{ type: 'text', text: 'exit 0' }] },
]

function makeCtx(options = {}) {
  const calls = { inject: [], warns: [], infos: [] }
  let createdHandler
  const ctx = {
    calls,
    effect(fn) { const dispose = fn(); return () => { try { dispose?.() } catch {} } },
    on(name, handler) {
      if (name === 'agent/created') createdHandler = handler
      return () => {}
    },
    emitCreated(agent) { createdHandler?.(agent) },
    workspaceRegistry: { get archivedSessionIds() { return options.archived ?? [] } },
    sessionQuery: {
      async readTitle(sessionId) {
        const title = options.titles?.[sessionId]
        return title === undefined ? undefined : { title, eventSeq: 1, updatedAt: 0 }
      },
    },
    agents: {
      get(id) { return options.parents?.[id] },
    },
    logger: { info: m => calls.infos.push(m), warn: m => calls.warns.push(m) },
  }
  return ctx
}

const fast = { titlePollAttempts: 3, titlePollIntervalMs: 5, firstSweepDelayMs: 600000, sweepIntervalMs: 600000 }

// --- 1. inherits the parent conversation once, into the titled side session
{
  const child = {
    session: { header: { id: 'child-side-1' } },
    async inject(payload) { callsOf.inject.push(payload) },
  }
  const callsOf = { inject: [] }
  const parent = { session: { deriveMessages: () => PARENT_MESSAGES } }
  const ctx = makeCtx({ titles: { 'child-side-1': '〔side〕parent-1' }, parents: { 'parent-1': parent } })
  mod.apply(ctx, fast)
  ctx.emitCreated(child)
  await sleep(120)
  check('injects exactly once', callsOf.inject.length === 1, callsOf.inject.length)
  const text = callsOf.inject[0]?.content?.[0]?.text ?? ''
  check('injects the parent conversation', text.includes('refactor the auth module') && text.includes('split token storage'), text.slice(0, 120))
  check('labels the speakers', text.includes('User:') && text.includes('Assistant:'), text)
  check('marks the source', callsOf.inject[0]?.source?.kind === 'side-context', callsOf.inject[0]?.source)
  check('reports the inheritance', ctx.calls.infos.some(m => m.includes('inherited')), ctx.calls.infos)

  // duplicate creation events must not double-inject
  ctx.emitCreated(child)
  await sleep(80)
  check('is not injected twice', callsOf.inject.length === 1, callsOf.inject.length)
}

// --- 2. unrelated sessions are ignored
{
  const callsOf = { inject: [] }
  const child = { session: { header: { id: 'child-plain-session' } }, async inject(p) { callsOf.inject.push(p) } }
  const ctx = makeCtx({ titles: { 'child-plain-session': 'ordinary title' }, parents: {} })
  mod.apply(ctx, fast)
  ctx.emitCreated(child)
  await sleep(120)
  check('ignores sessions without the marker', callsOf.inject.length === 0, callsOf.inject.length)
}

// --- 3. a marker with a path-like parent id is refused
{
  const callsOf = { inject: [] }
  const child = { session: { header: { id: 'child-evil-session' } }, async inject(p) { callsOf.inject.push(p) } }
  const ctx = makeCtx({ titles: { 'child-evil-session': '〔side〕../../etc/passwd' }, parents: {} })
  mod.apply(ctx, fast)
  ctx.emitCreated(child)
  await sleep(120)
  check('refuses a path-like parent id', callsOf.inject.length === 0, callsOf.inject.length)
}

// --- 4. parent offline or empty: no injection, warned
{
  const callsOf = { inject: [] }
  const child = { session: { header: { id: 'child-side-2' } }, async inject(p) { callsOf.inject.push(p) } }
  const offline = makeCtx({ titles: { 'child-side-2': '〔side〕parent-2' }, parents: {} })
  mod.apply(offline, fast)
  offline.emitCreated(child)
  await sleep(120)
  check('no injection when the parent is offline', callsOf.inject.length === 0)
  check('warns about the offline parent', offline.calls.warns.some(m => m.includes('not live')), offline.calls.warns)

  const empty = makeCtx({
    titles: { 'child-side-3': '〔side〕parent-3' },
    parents: { 'parent-3': { session: { deriveMessages: () => [] } } },
  })
  const child3 = { session: { header: { id: 'child-side-3' } }, async inject(p) { callsOf.inject.push(p) } }
  mod.apply(empty, fast)
  empty.emitCreated(child3)
  await sleep(120)
  check('no injection when the parent has no messages', callsOf.inject.length === 0)
  check('warns about the empty parent', empty.calls.warns.some(m => m.includes('no visible messages')), empty.calls.warns)
}

// --- 5. the parent's live permission preset is copied to the child
{
  const applied = []
  const child = { session: { header: { id: 'child-perm-1' } }, async inject() {} }
  const parent = { session: { deriveMessages: () => PARENT_MESSAGES } }
  const ctx = makeCtx({ titles: { 'child-perm-1': '〔side〕parent-perm' }, parents: { 'parent-perm': parent } })
  ctx.permissionPresets = {
    current: session => (session === parent.session ? 'danger-full-access' : 'custom'),
    set: (session, preset) => { applied.push({ session, preset }) },
  }
  mod.apply(ctx, fast)
  ctx.emitCreated(child)
  await sleep(120)
  check('copies the parent preset', applied.length === 1 && applied[0].preset === 'danger-full-access', applied)
  check('applies it to the child session', applied[0]?.session === child.session, applied[0]?.session === child.session)

  // an unmatched custom state must not be written
  const other = { session: { header: { id: 'child-perm-2' } }, async inject() {} }
  const ctx2 = makeCtx({ titles: { 'child-perm-2': '〔side〕parent-perm' }, parents: { 'parent-perm': parent } })
  ctx2.permissionPresets = { current: () => 'custom', set: () => { applied.push('unexpected') } }
  mod.apply(ctx2, fast)
  ctx2.emitCreated(other)
  await sleep(120)
  check('never writes the custom state', !applied.includes('unexpected'), applied)
}

// --- 6. reaper still purges a closed side conversation
{
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-side-reap-'))
  const bucket = path.join(root, '--F-test-bucket--')
  const sideId = 'session-11111111-2222-3333-4444-555555555555'
  const otherId = 'session-99999999-8888-7777-6666-555555555555'
  for (const id of [sideId, otherId]) {
    await mkdir(path.join(bucket, id), { recursive: true })
    await writeFile(path.join(bucket, id, 'session.v4.jsonl.zstd'), 'x')
  }
  const ctx = makeCtx({
    archived: [sideId, otherId],
    titles: { [sideId]: `〔side-closed〕parent-1`, [otherId]: 'ordinary title' },
  })
  mod.apply(ctx, {
    sessionsRoot: root, firstSweepDelayMs: 5, sweepIntervalMs: 20,
    titlePollAttempts: 1, titlePollIntervalMs: 5,
  })
  await sleep(180)
  const remaining = await readdir(bucket)
  check('reaps the closed side conversation', !remaining.includes(sideId), remaining)
  check('keeps an ordinary archived session', remaining.includes(otherId), remaining)
  await rm(root, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${JSON.stringify(r.detail)}`}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
