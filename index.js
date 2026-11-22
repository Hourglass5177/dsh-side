/**
 * Host half of the `dsh-side` bundle.
 *
 * The browser half forks the current conversation, so the Agent already owns the
 * lossless event prefix — the Host injects nothing. What remains here is the one
 * thing a browser cannot do: delete a closed side session's stored transcript.
 *
 * DSH has no Session-delete operation, so once a side session is archived this
 * module removes the storage directory that belongs to it. Side sessions are
 * recognised by their title (the browser half names them 「侧边会话」/「侧边会话（n）」)
 * and only archived ones are touched.
 *
 * @module dsh-side
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Services this plugin needs; without them it stays inactive instead of throwing. */
export const inject = ['workspaceRegistry', 'sessionQuery']

/** Titles every side session carries: 「侧边会话」, then 「侧边会话（2）」 and so on. */
const SIDE_TITLE_PREFIX = '侧边会话'

/** Titles in other locales that should still be reclaimed. */
const SIDE_TITLE_PREFIXES = [SIDE_TITLE_PREFIX, 'Side session']

/** A Session id is used as one path segment, so reject anything path-like. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u

/** Buckets are the persistence layer's encoded working directories. */
const BUCKET_NAME = /^--.*--$/u

/** One persisted Session directory holds exactly one of these. */
const SESSION_FILE = /^session\..*\.jsonl/u

/** How often the reaper looks for a side session that has been closed. */
const SWEEP_INTERVAL_MS = 4000

/** Give the browser's archive a moment before the first sweep. */
const FIRST_SWEEP_DELAY_MS = 2000

/**
 * Append one line to `<DSH_HOME>/dsh-side.log`. The Host has no console the user can
 * read, so this file is the only trace of what the reaper did.
 * @param {string} message - line to record.
 */
function logLine(message) {
  try {
    const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
    mkdirSync(home, { recursive: true })
    appendFileSync(path.join(home, 'dsh-side.log'), `${new Date().toISOString()} ${message}\n`)
  } catch (_unwritableLog) {
    // Diagnostics must never break the feature.
  }
}

/**
 * Roots that may hold the JSONL persistence directories, most specific first.
 * @param {unknown} config - the row's `config` value.
 * @returns {string[]} candidate roots in priority order.
 */
function candidateRoots(config) {
  const roots = []
  const configured = typeof config === 'object' && config !== null ? config.sessionsRoot : undefined
  if (typeof configured === 'string' && configured !== '') roots.push(configured)
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') roots.push(path.join(home, 'sessions'))
  roots.push(path.join(homedir(), '.dsh', 'sessions'))
  return [...new Set(roots)]
}

/**
 * Locate the one directory that stores this Session.
 *
 * Only direct children of `--…--` buckets are considered, the directory name must
 * be the Session id itself, and it must contain a persisted Session log.
 *
 * @param {string} sessionId - Session whose storage to locate.
 * @param {readonly string[]} roots - candidate persistence roots.
 * @returns {Promise<string | undefined>} absolute directory, when found.
 */
async function findSessionDirectory(sessionId, roots) {
  for (const root of roots) {
    let buckets
    try {
      buckets = await readdir(root, { withFileTypes: true })
    } catch (_noSuchRoot) {
      continue
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory() || !BUCKET_NAME.test(bucket.name)) continue
      const directory = path.join(root, bucket.name, sessionId)
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (_noSuchSession) {
        continue
      }
      if (!entries.some(entry => entry.isFile() && SESSION_FILE.test(entry.name))) continue
      return directory
    }
  }
  return undefined
}

/**
 * Delete one closed side session's stored transcript.
 * @param {any} ctx - Host plugin context.
 * @param {string} sessionId - the closed side Session.
 * @param {readonly string[]} roots - candidate persistence roots.
 */
async function purge(ctx, sessionId, roots) {
  if (!SAFE_SESSION_ID.test(sessionId)) return
  const directory = await findSessionDirectory(sessionId, roots)
  if (directory === undefined) {
    logLine(`no stored transcript for ${sessionId}`)
    ctx.logger?.warn?.(`dsh-side: no stored transcript found for side conversation "${sessionId}"`)
    return
  }
  try {
    await rm(directory, { recursive: true, force: true })
    logLine(`purged ${sessionId}`)
    ctx.logger?.info?.(`dsh-side: purged side conversation "${sessionId}"`)
  } catch (error) {
    logLine(`purge failed for ${sessionId}: ${String(error)}`)
    ctx.logger?.warn?.(`dsh-side: could not purge side conversation "${sessionId}": ${String(error)}`)
  }
}

/**
 * @param {unknown} title - `sessionQuery.readTitle` result (a title snapshot).
 * @returns {boolean} whether this title marks a side session.
 */
function isSideTitle(title) {
  const text = typeof title?.title === 'string' ? title.title : (typeof title === 'string' ? title : '')
  return SIDE_TITLE_PREFIXES.some(prefix => text.startsWith(prefix))
}

/**
 * Register the closed side conversation reaper.
 * @param {any} ctx - Host plugin context.
 * @param {unknown} config - the row's `config` value.
 */
export function apply(ctx, config) {
  const roots = candidateRoots(config)
  const delayOption = (key, fallback) => {
    const configured = typeof config === 'object' && config !== null ? config[key] : undefined
    return Number.isSafeInteger(configured) && configured >= 0 ? configured : fallback
  }
  const firstDelay = delayOption('firstSweepDelayMs', FIRST_SWEEP_DELAY_MS)
  const interval = delayOption('sweepIntervalMs', SWEEP_INTERVAL_MS)

  const inspected = new Set()
  let running = false

  async function sweep() {
    if (running) return
    running = true
    try {
      const archived = ctx.workspaceRegistry?.archivedSessionIds
      if (!Array.isArray(archived)) return
      for (const sessionId of archived) {
        if (inspected.has(sessionId)) continue
        if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) continue
        let title
        try {
          title = await ctx.sessionQuery?.readTitle?.(sessionId)
        } catch (_unreadableTitle) {
          // An unreadable title is transient: retry on the next sweep instead of
          // remembering this id as "not a side session" forever.
          continue
        }
        if (title === undefined) continue
        inspected.add(sessionId)
        if (!isSideTitle(title)) continue
        await purge(ctx, sessionId, roots)
      }
    } finally {
      running = false
    }
  }

  ctx.effect(() => {
    const first = setTimeout(() => { void sweep() }, firstDelay)
    const timer = setInterval(() => { void sweep() }, interval)
    first.unref?.()
    timer.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, 'dsh-side: closed side conversation reaper')
}
