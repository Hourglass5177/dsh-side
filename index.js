/**
 * Host half of the `dsh-side` bundle.
 *
 * Supplies the two things a browser cannot do:
 *
 *  1. **Inherit the parent conversation.** The Client creates a blank Session (no
 *     fork seed, so the product's own conversation view starts clean) and titles it
 *     `〔side〕<parentSessionId>`. When that Session's Agent appears, this module
 *     reads the title, takes the parent Agent's model-visible messages, and calls
 *     `agent.inject()` on the child. The injection is a durable
 *     `agent/inbox/spliced` record, so the child genuinely inherits the thread while
 *     its transcript shows only one collapsed context row.
 *  2. **Delete the closed side conversation.** DSH has no Session-delete operation,
 *     so once a side Session is archived this module removes the one storage
 *     directory that belongs to it.
 *
 * @module dsh-side
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Services this plugin needs; without them it stays inactive instead of throwing. */
export const inject = ['workspaceRegistry', 'sessionQuery']

/** Every side Session id starts with this: `session-side-<parentSessionId>-<random>`. */
const SIDE_ID_PREFIX = 'session-side-'

/** A Session id is used as one path segment, so reject anything path-like. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u

/** Buckets are the persistence layer's encoded working directories. */
const BUCKET_NAME = /^--.*--$/u

/** One persisted Session directory holds exactly one of these. */
const SESSION_FILE = /^session\..*\.jsonl/u

/** How often the reaper looks for a side conversation that has been closed. */
const SWEEP_INTERVAL_MS = 4000

/** Give the Client's archive a moment before the first sweep. */
const FIRST_SWEEP_DELAY_MS = 2000

/** How long to wait for the Client's title marker on a new Agent. */
const TITLE_POLL_ATTEMPTS = 40

/** Delay between title polls while an Agent is being titled. */
const TITLE_POLL_INTERVAL_MS = 100

/** Bound on how much inherited text one injection carries. */
const INHERITED_TEXT_LIMIT = 60000

/**
 * @param {number} ms - delay in milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Append one line to `<DSH_HOME>/dsh-side.log`. The Host has no console the user can
 * read, so this file is the only way to tell why inheritance did or did not happen.
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
 * Resolve the Agent registry: a plugin may reach it as a property or via `get`.
 * @param {any} ctx - Host plugin context.
 * @returns {any} the registry, when available.
 */
function agentsOf(ctx) {
  try {
    return ctx.agents ?? ctx.get?.('agents')
  } catch (_noAgents) {
    return undefined
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
 * Delete one closed side conversation's stored transcript.
 * @param {any} ctx - Host plugin context.
 * @param {string} sessionId - the closed side Session.
 * @param {readonly string[]} roots - candidate persistence roots.
 */
async function purge(ctx, sessionId, roots) {
  if (!SAFE_SESSION_ID.test(sessionId)) return
  const directory = await findSessionDirectory(sessionId, roots)
  if (directory === undefined) {
    ctx.logger?.warn?.(`dsh-side: no stored transcript found for side conversation "${sessionId}"`)
    return
  }
  try {
    await rm(directory, { recursive: true, force: true })
    logLine(`purged ${sessionId}`)
    ctx.logger?.info?.(`dsh-side: purged side conversation "${sessionId}"`)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-side: could not purge side conversation "${sessionId}": ${String(error)}`)
  }
}

/**
 * Recover the parent Session id from a side Session id.
 * @param {string} sessionId - the side Session id.
 * @returns {string | undefined} the parent id, when the id carries one.
 */
function parentOfSideId(sessionId) {
  if (!sessionId.startsWith(SIDE_ID_PREFIX)) return undefined
  const rest = sessionId.slice(SIDE_ID_PREFIX.length)
  const cut = rest.lastIndexOf('-')
  if (cut <= 0) return undefined
  const parent = rest.slice(0, cut)
  const suffix = rest.slice(cut + 1)
  if (!/^[0-9a-f]{8}$/u.test(suffix)) return undefined
  return SAFE_SESSION_ID.test(parent) ? parent : undefined
}

/**
 * @param {unknown} message - one derived model message.
 * @returns {string} its text content, without tool payloads.
 */
function textOfMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text.trim()
}

/**
 * @param {unknown} role - message role.
 * @returns {string} a stable speaker label.
 */
function speakerOf(role) {
  switch (role) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'tool': return 'Tool'
    case 'system': return 'System'
    default: return 'Context'
  }
}

/**
 * Build the injected context from persisted parent events. Used when the parent
 * Agent is not live: the same conversation, read from storage instead of memory.
 * @param {any} observation - `sessionQuery.observeSession` result.
 * @returns {object[]} content blocks, empty when there is nothing to inherit.
 */
function inheritedBlocksFromEvents(observation) {
  const events = Array.isArray(observation?.events) ? observation.events : []
  const lines = []
  for (const event of events) {
    const data = event?.data
    if (event?.type === 'user/message') {
      if (data?.source?.kind !== 'user') continue
      const text = textOfMessage(data)
      if (text !== '') lines.push(`User: ${text}`)
    } else if (event?.type === 'assistant/message') {
      const text = textOfMessage(data?.message ?? data)
      if (text !== '') lines.push(`Assistant: ${text}`)
    }
  }
  if (lines.length === 0) return []
  let body = lines.join('\n\n')
  if (body.length > INHERITED_TEXT_LIMIT) body = body.slice(body.length - INHERITED_TEXT_LIMIT)
  return [{
    type: 'text',
    text: `Context inherited from the main conversation. It is background; continue from the question that follows.\n\n${body}`,
  }]
}

/**
 * Build the injected context from the parent Agent's model-visible messages.
 * @param {any} parentAgent - live parent Agent.
 * @returns {object[]} content blocks, empty when there is nothing to inherit.
 */
function inheritedBlocks(parentAgent) {
  let messages
  try {
    messages = parentAgent?.session?.deriveMessages?.() ?? []
  } catch (error) {
    return []
  }
  if (!Array.isArray(messages) || messages.length === 0) return []
  const lines = []
  for (const message of messages) {
    const text = textOfMessage(message)
    if (text === '') continue
    lines.push(`${speakerOf(message?.role)}: ${text}`)
  }
  if (lines.length === 0) return []
  let body = lines.join('\n\n')
  if (body.length > INHERITED_TEXT_LIMIT) {
    body = body.slice(body.length - INHERITED_TEXT_LIMIT)
  }
  return [{
    type: 'text',
    text: `Context inherited from the main conversation. It is background; continue from the question that follows.\n\n${body}`,
  }]
}

/**
 * Register the context injector and the closed-conversation reaper.
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

  const pollAttempts = delayOption('titlePollAttempts', TITLE_POLL_ATTEMPTS)
  const pollInterval = delayOption('titlePollIntervalMs', TITLE_POLL_INTERVAL_MS)

  const inspected = new Set()
  const injected = new Set()
  let running = false

  // ---- inheritance -------------------------------------------------------

  /**
   * Inject the parent conversation into one side Session's Agent.
   * @param {any} agent - the new Agent.
   */
  async function inherit(agent) {
    const sessionId = agent?.session?.header?.id
    if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId) || injected.has(sessionId)) return
    const parentId = parentOfSideId(sessionId)
    if (parentId === undefined) return
    injected.add(sessionId)
    let parentAgent
    try {
      parentAgent = ctx.agents?.get?.(parentId)
    } catch (_noRegistry) {
      parentAgent = undefined
    }
    if (parentAgent === undefined || parentAgent === null) {
      logLine(`parent ${parentId} is not a live agent; falling back to storage`)
      ctx.logger?.warn?.(`dsh-side: parent conversation "${parentId}" is not live; side conversation starts without inherited context`)
      // Storage can still supply the conversation, so continue instead of returning.
      const blocks = await (async () => {
        try {
          return inheritedBlocksFromEvents(await ctx.sessionQuery?.observeSession?.(parentId))
        } catch (error) {
          logLine(`storage read failed for ${parentId}: ${String(error)}`)
          return []
        }
      })()
      if (blocks.length === 0) return
      try {
        agent.inject({
          id: `side-context-${randomUUID()}`,
          role: 'user',
          content: blocks,
          source: { kind: 'side-context' },
        })
        logLine(`injected ${blocks[0].text.length} chars from storage into ${sessionId}`)
      } catch (error) {
        logLine(`storage-path inject failed for ${sessionId}: ${String(error)}`)
      }
      return
    }
    let blocks = inheritedBlocks(parentAgent)
    if (blocks.length === 0) {
      try {
        blocks = inheritedBlocksFromEvents(await ctx.sessionQuery?.observeSession?.(parentId))
      } catch (error) {
        logLine(`storage read failed for ${parentId}: ${String(error)}`)
      }
    }
    if (blocks.length === 0) {
      logLine(`no visible messages to inherit from ${parentId}`)
      ctx.logger?.warn?.('dsh-side: the parent conversation has no visible messages to inherit')
      return
    }
    logLine(`inheriting ${blocks[0].text.length} chars from ${parentId} into ${sessionId}`)
    // `inject()` takes a complete UserMessage, not a bare `{ content, source }`: the
    // inbox stores it verbatim and rejects a message without an id and a role.
    try {
      agent.inject({
        id: `side-context-${randomUUID()}`,
        role: 'user',
        content: blocks,
        source: { kind: 'side-context' },
      })
      logLine(`injected ${blocks[0].text.length} chars into ${sessionId}`)
      ctx.logger?.info?.(`dsh-side: inherited ${blocks[0].text.length} characters into side conversation "${sessionId}"`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-side: could not inject the inherited context into "${sessionId}": ${String(error)}`)
    }
    // A seeded session keeps the permission preset recorded at event zero, which can be
    // older than the parent's current choice. Copy the live preset so the side session
    // does not ask for approval the main conversation already granted.
    try {
      const presets = ctx.permissionPresets ?? ctx.get?.('permissionPresets')
      if (presets !== undefined && typeof presets.current === 'function' && typeof presets.set === 'function') {
        const preset = presets.current(parentAgent.session)
        if (typeof preset === 'string' && preset !== '' && preset !== 'custom') {
          presets.set(agent.session, preset)
          ctx.logger?.info?.(`dsh-side: copied permission preset "${preset}" into "${sessionId}"`)
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-side: could not copy the permission preset into "${sessionId}": ${String(error)}`)
    }
    // Keep the temporary conversation out of the session list without archiving it: an
    // archived Session is refused a model step by the controller's gate. Detaching
    // removes it from the workspace account while the session keeps running for its tab.
    // Runs last and is not awaited, so a slow workspace write cannot delay inheritance.
    void (async () => {
      try {
        const workspaces = ctx.workspaceRegistry?.list?.() ?? []
        for (const workspace of workspaces) {
          if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
            await workspace.detachSession(sessionId)
            ctx.logger?.info?.(`dsh-side: detached side conversation "${sessionId}" from its workspace`)
            break
          }
        }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-side: could not detach "${sessionId}" from its workspace: ${String(error)}`)
      }
    })()
  }

  ctx.effect(() => ctx.on('agent/created', (...args) => {
    // The payload may be the Agent itself or an AgentHandle; accept either shape.
    for (const value of args) {
      if (value === null || typeof value !== 'object') continue
      const agent = value.session !== undefined ? value : value.agent
      if (agent === undefined || agent === null || typeof agent.inject !== 'function') continue
      logLine(`agent/created ${agent.session?.header?.id ?? '?'}`)
      void inherit(agent)
      return
    }
  }), 'dsh-side: inherited context')

  // The creation event is not the only path: poll the registry so a missed or
  // late delivery still resolves every side session that exists.
  ctx.effect(() => {
    const sweep = () => {
      let agents
      try {
        agents = agentsOf(ctx)?.list?.() ?? []
      } catch (_unreadableAgents) {
        return
      }
      for (const agent of agents) {
        const sessionId = agent?.session?.header?.id
        if (typeof sessionId !== 'string' || !sessionId.startsWith(SIDE_ID_PREFIX)) continue
        if (injected.has(sessionId)) continue
        if (typeof agent.inject !== 'function') continue
        void inherit(agent)
      }
    }
    const timer = setInterval(sweep, 700)
    timer.unref?.()
    sweep()
    return () => { clearInterval(timer) }
  }, 'dsh-side: side session watcher')

  // ---- reaper ------------------------------------------------------------

  async function sweep() {
    if (running) return
    running = true
    try {
      const archived = ctx.workspaceRegistry?.archivedSessionIds
      if (!Array.isArray(archived)) return
      for (const sessionId of archived) {
        if (inspected.has(sessionId)) continue
        inspected.add(sessionId)
        if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) continue
        if (!sessionId.startsWith(SIDE_ID_PREFIX)) continue
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
