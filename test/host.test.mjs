// Host-half test: the closed side session reaper.
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeCtx(options = {}) {
  const warns = []
  const infos = []
  return {
    warns,
    infos,
    effect(fn) { const dispose = fn(); return () => { try { dispose?.() } catch {} } },
    workspaceRegistry: { get archivedSessionIds() { return options.archived ?? [] } },
    sessionQuery: {
      async readTitle(sessionId) {
        const title = options.titles?.[sessionId]
        return title === undefined ? undefined : { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 1, updatedAt: 0 }
      },
    },
    logger: { info: message => infos.push(message), warn: message => warns.push(message) },
  }
}

// --- 1. an archived side session is reaped, an ordinary one is kept
{
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-side-reap-'))
  const bucket = path.join(root, '--F-test-bucket--')
  const sideId = 'session-11111111-2222-3333-4444-555555555555'
  const numberedId = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const otherId = 'session-99999999-8888-7777-6666-555555555555'
  for (const id of [sideId, numberedId, otherId]) {
    await mkdir(path.join(bucket, id), { recursive: true })
    await writeFile(path.join(bucket, id, 'session.v4.jsonl.zstd'), 'x')
  }
  const ctx = makeCtx({
    archived: [sideId, numberedId, otherId],
    titles: { [sideId]: '侧边会话', [numberedId]: '侧边会话（2）', [otherId]: '接手 3DGS 审计' },
  })
  mod.apply(ctx, { sessionsRoot: root, firstSweepDelayMs: 5, sweepIntervalMs: 20 })
  await sleep(200)
  const remaining = await readdir(bucket)
  check('reaps the first side session', !remaining.includes(sideId), remaining)
  check('reaps a numbered side session', !remaining.includes(numberedId), remaining)
  check('keeps an ordinary archived session', remaining.includes(otherId), remaining)
  await rm(root, { recursive: true, force: true })
}

// --- 2. only archived sessions are considered
{
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-side-keep-'))
  const bucket = path.join(root, '--F-keep--')
  const liveId = 'session-22222222-3333-4444-5555-666666666666'
  await mkdir(path.join(bucket, liveId), { recursive: true })
  await writeFile(path.join(bucket, liveId, 'session.v4.jsonl.zstd'), 'x')
  const ctx = makeCtx({ archived: [], titles: { [liveId]: '侧边会话' } })
  mod.apply(ctx, { sessionsRoot: root, firstSweepDelayMs: 5, sweepIntervalMs: 20 })
  await sleep(150)
  const remaining = await readdir(bucket)
  check('keeps a side session that is still open', remaining.includes(liveId), remaining)
  await rm(root, { recursive: true, force: true })
}

// --- 3. a hostile session id never touches the filesystem
{
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-side-evil-'))
  const ctx = makeCtx({ archived: ['../escape'], titles: { '../escape': '侧边会话' } })
  mod.apply(ctx, { sessionsRoot: root, firstSweepDelayMs: 5, sweepIntervalMs: 20 })
  await sleep(120)
  check('ignores a path-like session id', true)
  await rm(root, { recursive: true, force: true })
}

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `  -> ${JSON.stringify(result.detail)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
