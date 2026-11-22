/**
 * Client half of the `dsh-side` bundle.
 *
 * `/side` opens a temporary conversation beside the current thread:
 *   1. `ctx.sessions.fork({ atSeq: 0 })` cuts the current Session at event zero: the
 *      child inherits its workspace, directory and preset but no messages, so the
 *      product's own conversation view renders an empty transcript.
 *   2. The Session is titled `〔side〕<parentSessionId>`; an ordinary fork records no
 *      parent, so that marker is how the Host finds the source thread. It then
 *      injects the parent's model-visible messages as one context record, which is
 *      what lets the side agent inherit the real conversation.
 *   3. A right-Sidebar tab type owned by this bundle hosts the product's own
 *      `conversation.content` — official rows, official composer, official keys.
 *      Closing the tab stops and archives the Session, and the Host reaper deletes
 *      its stored transcript.
 *
 * There is no hand-written chat UI in this bundle.
 *
 * @module dsh-side
 */
window.__ModuleLoader__.load({
  id: 'dsh-side',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Resource protocol, tab kind, and tab-type id owned by this bundle. */
    const PROTOCOL = 'sidechat'
    const KIND = 'sidechat'
    const TAB_ID = 'dsh-side/chat'
    const ADDRESS_PREFIX = `dsh-resource://${PROTOCOL}/session/`

    /** Page tab type that backs the guide card; it hands off to a resource tab. */
    const PAGE_ID = 'dsh-side/new'
    const PAGE_KIND = 'sidechat-new'

    /** Child slot hosting the product's conversation inside this tab body. */
    const TRANSCRIPT_SEAT = 'side.chat.transcript'

    /** Parent-side reference source recorded by the resource provider. */
    const REFERENCE_SOURCE = 'sideChat'

    const SIDE_ID_SUFFIX = /^[0-9a-f]{8}$/u

    /** Localized copy namespace. */
    const NS = 'dsh-side'

    /** Record of live side Sessions, so a crash or reload cannot leak them. */
    const STORAGE_KEY = 'dsh-side.sessions.v1'

    /** Session id → the number used in its 「侧边会话（n）」 title. */
    const SIDE_TITLES_KEY = 'dsh-side.titles.v1'

    /** Wait before reconciling orphans; the Sidebar restores tabs during boot. */
    const RECONCILE_DELAY_MS = 2500

    const DICTIONARIES = {
      en: {
        'command.label': 'Side session',
        'command.description': 'Start a temporary side session that inherits the current context',
        'tab.title': 'Side session',
        'session.title': 'Side session',
        'guide.description': 'Open a temporary session beside this one',
        'guide.noSession': 'No conversation is open in this panel.',
        'fallback.note': 'This panel could not load the conversation inline.',
        'fallback.open': 'Open in the main view',
      },
      zh: {
        'command.label': '侧边会话',
        'command.description': '发起临时侧边会话，继承当前上下文',
        'tab.title': '侧边会话',
        'session.title': '侧边会话',
        'guide.description': '在当前会话旁边，开一条临时会话',
        'guide.noSession': '这个面板当前没有打开的会话。',
        'fallback.note': '这个面板无法内嵌加载会话。',
        'fallback.open': '在主视图打开',
      },
    }

    /** Fallback copy used before (or without) the locale service. */
    const FALLBACK_COPY = DICTIONARIES.en

    /**
     * @param {string} sessionId - Session to address.
     * @returns {string} canonical resource address.
     */
    function addressOf(sessionId) {
      return `${ADDRESS_PREFIX}${encodeURIComponent(sessionId)}`
    }

    /**
     * @param {unknown} address - possible side-chat resource address.
     * @returns {string | undefined} the Session id, or undefined for anything else.
     */
    function sessionIdOf(address) {
      if (typeof address !== 'string') return undefined
      let url
      try {
        url = new URL(address)
      } catch (_invalidUrl) {
        return undefined
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== PROTOCOL) return undefined
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2 || parts[0] !== 'session') return undefined
      try {
        const id = decodeURIComponent(parts[1])
        return id === '' ? undefined : id
      } catch (_invalidEncoding) {
        return undefined
      }
    }

    /**
     * @param {AbortSignal} signal - resource occurrence signal.
     * @returns {Promise<void>} resolves when the occurrence is disposed.
     */
    function waitForAbort(signal) {
      if (signal.aborted) return Promise.resolve()
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }

    /** Message + escape hatch used when the inline conversation cannot render. */
    function Unavailable({ sessionId, note, open, onOpen }) {
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '8px',
          padding: '16px', fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: '18px',
        },
      }, h('div', null, note), h('button', {
        type: 'button',
        onClick: () => { onOpen(sessionId) },
        style: {
          alignSelf: 'flex-start', padding: '4px 10px', borderRadius: 'var(--dsw-radius-md, 8px)',
          border: '1px solid var(--dsw-alias-line, rgba(127,127,127,0.4))',
          background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer',
        },
      }, open))
    }

    return {
      inject: ['sessions', 'sidebarRight', 'uiWorkspace', 'commandUi', 'slots', 'locale'],
      /**
       * @param {import('@deepseek-ai/cordis').Context} ctx - Client plugin context.
       */
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, DICTIONARIES)
          } catch (error) {
            console.warn('[dsh-side] locale registration skipped:', error)
            return () => {}
          }
        }, 'dsh-side: dictionaries')
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : key => FALLBACK_COPY[key] ?? key

        /** Run one registration defensively: a rejected seat must not disable the rest. */
        function guardSlot(label, register) {
          try {
            return register()
          } catch (error) {
            console.warn(`[dsh-side] ${label} unavailable:`, error)
            return () => {}
          }
        }

        /** Remember a live side Session so a reload can archive orphans. */
        function remember(sessionId) {
          try {
            const ids = new Set(remembered())
            ids.add(sessionId)
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
          } catch (_unavailableStorage) {
            // Storage is a cleanup aid only; the panel still works without it.
          }
        }

        /** @param {string} sessionId - side Session. */
        function forget(sessionId) {
          try {
            const ids = new Set(remembered())
            ids.delete(sessionId)
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
          } catch (_unavailableStorage) {
            // Ignore.
          }
        }

        /** @returns {string[]} remembered side Sessions. */
        function remembered() {
          try {
            const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
            return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []
          } catch (_unavailableStorage) {
            return []
          }
        }

        /**
         * End one side Session: stop it and archive it out of every list. The Host
         * half deletes its stored transcript once it observes the archive.
         * @param {string} sessionId - side Session.
         */
        async function retire(sessionId) {
          forget(sessionId)
          const numbers = sideNumbers()
          if (numbers[sessionId] !== undefined) {
            delete numbers[sessionId]
            saveSideNumbers(numbers)
          }
          try {
            await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true })
          } catch (error) {
            console.warn('[dsh-side] could not archive the side conversation:', error)
          }
        }

        /**
         * Rename a side Session while it is retained.
         * @param {string} sessionId - the side Session.
         * @param {string} title - new title.
         */
        async function renameSideSession(sessionId, title) {
          let reference
          try {
            reference = ctx.sessions.retain(sessionId, { source: REFERENCE_SOURCE })
          } catch (error) {
            console.warn('[dsh-side] could not retain the side conversation to title it:', error)
            return
          }
          try {
            const scope = ctx.sessions.scope?.(sessionId)
            const face = scope === undefined ? undefined : ctx.sessions.sessionOf?.(scope)
            if (face === undefined || typeof face.rename !== 'function') return
            const renamed = await face.rename(title)
            if (renamed !== undefined && renamed.ok === false) {
              console.warn('[dsh-side] could not title the side conversation:', renamed.error)
            }
          } catch (error) {
            console.warn('[dsh-side] could not title the side conversation:', error)
          } finally {
            try {
              reference.release()
            } catch (_alreadyReleased) {
              // Releasing twice is harmless.
            }
          }
        }

        /** @param {string} sessionId - side Session. */
        function openInMain(sessionId) {
          try {
            ctx.uiWorkspace.openSession(sessionId)
          } catch (error) {
            console.warn('[dsh-side] could not open the side conversation in the main view:', error)
          }
        }

        // ------------------------------------------------------------------
        // Side transcript: a Conversation target that renders only what this
        // side session itself recorded. The fork inherited the parent prefix,
        // so everything up to `session/end-seed` is dropped here instead of in
        // the model context — the agent keeps the full, lossless history.
        // ------------------------------------------------------------------

        /** Registered Conversation view target for the side transcript. */
        const SIDE_TARGET = 'side'

        /** Conversation service, captured once the client can see it. */
        let conversation = undefined

        /** @param {unknown} content - message content blocks. @returns {string} text. */
        function blockText(content, type) {
          if (!Array.isArray(content)) return ''
          let text = ''
          for (const block of content) {
            if (block?.type === type && typeof block.text === 'string') text += block.text
          }
          return text.trim()
        }

        /** @param {unknown} content - message content blocks. @returns {object[]} images. */
        function blockImages(content) {
          if (!Array.isArray(content)) return []
          return content.filter(block => block?.type === 'image')
        }

        /**
         * Fold one `assistant/attempt` stream into text and reasoning.
         * Records are `text-chunks` / `reasoning-chunks` / `tool-call-chunks` / raw `chunk`.
         * @param {unknown} stream - attempt stream records.
         * @returns {{ text: string, reasoning: string }} accumulated text.
         */
        function accumulateStream(stream) {
          let text = ''
          let reasoning = ''
          if (!Array.isArray(stream)) return { text, reasoning }
          for (const record of stream) {
            if (record?.type === 'text-chunks') text += (record.texts ?? []).join('')
            else if (record?.type === 'reasoning-chunks') reasoning += (record.texts ?? []).join('')
            else if (record?.type === 'chunk') {
              const chunk = record.chunk ?? {}
              if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
              else if (chunk.type === 'reasoning-delta') reasoning += String(chunk.text ?? '')
            }
          }
          return { text, reasoning }
        }

        /**
         * @param {object} source - ObservableSnapshot source.
         * @returns {unknown} its current snapshot.
         */
        function useObservable(source) {
          const subscribe = React.useCallback(
            listener => (source === undefined ? () => {} : source.subscribe(listener)),
            [source],
          )
          const getSnapshot = React.useCallback(
            () => (source === undefined ? undefined : source.getSnapshot()),
            [source],
          )
          return React.useSyncExternalStore(subscribe, getSnapshot)
        }

        // ---------------------------------------------------------------- markdown

        /**
         * Split assistant text into the block shapes this transcript renders.
         * @param {unknown} input - markdown-ish text.
         * @returns {object[]} blocks.
         */
        function parseBlocks(input) {
          const lines = String(input ?? '').split('\n')
          const blocks = []
          let paragraph = []
          let code = null
          let list = null
          const flushParagraph = () => {
            if (paragraph.length > 0) {
              blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
              paragraph = []
            }
          }
          const flushList = () => {
            if (list !== null) {
              blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
              list = null
            }
          }
          for (const line of lines) {
            if (code !== null) {
              if (line.trim().startsWith('```')) {
                blocks.push({ kind: 'code', language: code.language, text: code.lines.join('\n') })
                code = null
              } else code.lines.push(line)
              continue
            }
            const fence = /^```([\w+-]*)\s*$/.exec(line.trim())
            if (fence !== null) {
              flushParagraph()
              flushList()
              code = { language: fence[1] ?? '', lines: [] }
              continue
            }
            if (/^\s*$/.test(line)) {
              flushParagraph()
              flushList()
              continue
            }
            const heading = /^(#{1,4})\s+(.*)$/.exec(line)
            if (heading !== null) {
              flushParagraph()
              flushList()
              blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
              continue
            }
            if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
              flushParagraph()
              flushList()
              blocks.push({ kind: 'rule' })
              continue
            }
            const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
            if (bullet !== null) {
              flushParagraph()
              if (list === null || list.ordered) {
                flushList()
                list = { ordered: false, items: [] }
              }
              list.items.push(bullet[1])
              continue
            }
            const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
            if (ordered !== null) {
              flushParagraph()
              if (list === null || !list.ordered) {
                flushList()
                list = { ordered: true, items: [] }
              }
              list.items.push(ordered[1])
              continue
            }
            flushList()
            paragraph.push(line)
          }
          flushParagraph()
          flushList()
          if (code !== null) blocks.push({ kind: 'code', language: code.language, text: code.lines.join('\n') })
          return blocks
        }

        /**
         * Inline markdown: code spans, bold, italic and links (rendered as text).
         * @param {string} text - inline text.
         * @returns {unknown[]} React children.
         */
        function inlineNodes(text) {
          const nodes = []
          const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/gu
          let last = 0
          let match
          while ((match = pattern.exec(text)) !== null) {
            if (match.index > last) nodes.push(text.slice(last, match.index))
            const token = match[0]
            if (token.startsWith('`')) {
              nodes.push(h('code', {
                key: `c${match.index}`,
                style: {
                  padding: '1px 4px', borderRadius: '4px',
                  background: 'var(--dsw-specific-input-major, rgba(127,127,127,0.16))',
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '0.92em',
                },
              }, token.slice(1, -1)))
            } else if (token.startsWith('**')) {
              nodes.push(h('strong', { key: `b${match.index}` }, token.slice(2, -2)))
            } else if (token.startsWith('*')) {
              nodes.push(h('em', { key: `i${match.index}` }, token.slice(1, -1)))
            } else {
              const link = /\[([^\]]+)\]\(([^)]+)\)/u.exec(token)
              nodes.push(h('span', { key: `l${match.index}`, title: link?.[2] ?? '' }, link?.[1] ?? token))
            }
            last = match.index + token.length
          }
          if (last < text.length) nodes.push(text.slice(last))
          return nodes
        }

        /** Render one markdown text as React children. */
        function Markdown({ text }) {
          const blocks = parseBlocks(text)
          return h(React.Fragment, null, ...blocks.map((block, index) => {
            if (block.kind === 'code') {
              return h('pre', {
                key: `k${index}`,
                style: {
                  margin: '8px 0', padding: '10px 12px', borderRadius: 'var(--dsw-radius-md, 8px)',
                  background: 'var(--dsw-specific-input-major, rgba(127,127,127,0.14))',
                  overflowX: 'auto', whiteSpace: 'pre',
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '0.92em',
                },
              }, h('code', null, block.text))
            }
            if (block.kind === 'heading') {
              const size = block.level === 1 ? '1.25em' : block.level === 2 ? '1.15em' : '1.05em'
              return h('div', {
                key: `k${index}`,
                style: { margin: '10px 0 4px', fontWeight: 600, fontSize: size },
              }, ...inlineNodes(block.text))
            }
            if (block.kind === 'rule') {
              return h('hr', {
                key: `k${index}`,
                style: { margin: '12px 0', border: 'none', borderTop: '1px solid var(--dsw-alias-line, rgba(127,127,127,0.3))' },
              })
            }
            if (block.kind === 'list') {
              return h(block.ordered ? 'ol' : 'ul', {
                key: `k${index}`, style: { margin: '6px 0', paddingLeft: '1.4em' },
              }, ...block.items.map((item, itemIndex) => h('li', { key: `i${itemIndex}`, style: { margin: '2px 0' } }, ...inlineNodes(item))))
            }
            return h('div', { key: `k${index}`, style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
              ...inlineNodes(block.text))
          }))
        }

        // ------------------------------------------------------------- components

        /** One collapsible block used for reasoning and tool output. */
        function Disclosure({ summary, children, tone }) {
          const [open, setOpen] = React.useState(false)
          return h('div', { style: { margin: '6px 0' } },
            h('button', {
              type: 'button',
              onClick: () => setOpen(value => !value),
              style: {
                display: 'flex', alignItems: 'center', gap: '6px', width: '100%', textAlign: 'left',
                padding: '4px 8px', border: 'none', borderRadius: 'var(--dsw-radius-md, 8px)',
                background: 'transparent', color: tone === 'error' ? 'var(--dsw-alias-warning, #e0a030)' : 'inherit',
                font: 'inherit', cursor: 'pointer', opacity: 0.8,
              },
            }, h('span', { style: { fontSize: '11px' } }, open ? '▾' : '▸'), summary),
            open
              ? h('div', {
                style: {
                  padding: '4px 12px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontSize: 'var(--dsh-content-font-size-secondary, 13px)', opacity: 0.85,
                },
              }, children)
              : null,
          )
        }

        /** One image block, resolved through the conversation service. */
        function ImageBlock({ sessionId, block }) {
          const [url, setUrl] = React.useState(() => {
            try {
              return conversation?.peekImageUrl?.(sessionId, block) ?? undefined
            } catch (_unavailable) {
              return undefined
            }
          })
          React.useEffect(() => {
            if (url !== undefined) return undefined
            let cancelled = false
            Promise.resolve()
              .then(() => conversation?.imageUrl?.(sessionId, block))
              .then(value => { if (!cancelled && typeof value === 'string') setUrl(value) })
              .catch(() => {})
            return () => { cancelled = true }
          }, [sessionId, block, url])
          if (url === undefined) {
            return h('div', { style: { fontSize: '12px', opacity: 0.55, marginTop: '6px' } }, '图片加载中…')
          }
          return h('img', {
            src: url, alt: '附件',
            style: { display: 'block', maxWidth: '100%', maxHeight: '360px', borderRadius: '8px', marginTop: '6px' },
          })
        }

        /** One tool call with its result. */
        function ToolRow({ data }) {
          const failed = typeof data.result === 'string' && /^(Error|失败|error:)/u.test(data.result.trim())
          const firstLine = String(data.args ?? '').split('\n')[0].slice(0, 80)
          const body = `${formatJson(data.args)}${data.result === '' ? '' : `\n\n${truncate(data.result, 4000)}`}`
          return h(Disclosure, {
            summary: `工具调用 · ${data.name}${failed ? ' · 失败' : ''}${data.result === '' ? ' · 运行中' : ''}`,
            tone: failed ? 'error' : undefined,
          }, `${firstLine}${firstLine === '' ? '' : '\n\n'}${body}`)
        }

        /**
         * @param {unknown} value - JSON text.
         * @returns {string} pretty JSON, or the original text.
         */
        function formatJson(value) {
          if (typeof value !== 'string' || value.trim() === '') return ''
          try {
            return JSON.stringify(JSON.parse(value), null, 2)
          } catch (_notJson) {
            return value
          }
        }

        /**
         * @param {unknown} value - text.
         * @param {number} limit - characters to keep.
         * @returns {string} possibly truncated text.
         */
        function truncate(value, limit) {
          const text = String(value ?? '')
          return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断 ${text.length - limit} 字）`
        }

        /**
         * One node per renderable event. The fork boundary is cut in the builder, so the
         * inherited prefix never materializes as rows.
         * @returns {object[]} Definitions registered against the side target.
         */
        function sideDefinitions() {
          const seed = {
            kind: 'side-seed',
            target: SIDE_TARGET,
            match: event => (event?.type === 'session/end-seed' ? { id: 'seed', role: 'start' } : null),
            start: (_context, match) => ({ id: 'seed', seq: match.event.seq ?? 0 }),
            update: (_context, match) => ({ id: 'seed', seq: match.event.seq ?? 0 }),
            // The boundary must reach the builder as a node: returning null here drops the
            // only evidence of where the inherited prefix ends, and every inherited row
            // would render. The component skips this kind.
            buildViewNode: context => (context.state === undefined
              ? null
              : { key: 'side-seed:seed', kind: 'side-seed', id: 'seed', target: SIDE_TARGET, data: context.state }),
          }
          const user = {
            kind: 'side-user',
            target: SIDE_TARGET,
            match: event => (event?.type === 'user/message' && event.data?.source?.kind === 'user'
              ? { id: String(event.data?.id ?? event.seq), role: 'start' }
              : null),
            start: (_context, match) => ({
              id: String(match.event.data?.id ?? match.event.seq),
              seq: match.event.seq ?? 0,
              text: blockText(match.event.data?.content, 'text'),
              images: blockImages(match.event.data?.content),
            }),
            update: (_context, match) => ({
              id: String(match.event.data?.id ?? match.event.seq),
              seq: match.event.seq ?? 0,
              text: blockText(match.event.data?.content, 'text'),
              images: blockImages(match.event.data?.content),
            }),
            buildViewNode: context => (context.state === undefined
              || (context.state.text === '' && context.state.images.length === 0)
              ? null
              : { key: `side-user:${context.state.id}`, kind: 'side-user', id: context.state.id, target: SIDE_TARGET, data: context.state }),
          }
          const assistant = {
            kind: 'side-assistant',
            target: SIDE_TARGET,
            match: event => (event?.type === 'assistant/message'
              ? { id: String(event.seq), role: 'start' }
              : null),
            start: (_context, match) => assistantState(match.event),
            update: (_context, match) => assistantState(match.event),
            buildViewNode: context => (context.state === undefined
              ? null
              : { key: `side-assistant:${context.state.id}`, kind: 'side-assistant', id: context.state.id, target: SIDE_TARGET, data: context.state }),
          }
          const live = {
            kind: 'side-live',
            target: SIDE_TARGET,
            match: event => (event?.type === 'assistant/attempt'
              ? { id: liveId(event), role: 'start' }
              : null),
            start: (_context, match) => liveState(match.event),
            update: (_context, match) => liveState(match.event),
            buildViewNode: context => (context.state === undefined
              ? null
              : { key: `side-live:${context.state.id}`, kind: 'side-live', id: context.state.id, target: SIDE_TARGET, data: context.state }),
          }
          const tool = {
            kind: 'side-tool',
            target: SIDE_TARGET,
            match: event => {
              if (event?.type === 'tool/call') return { id: String(event.data?.callId ?? event.seq), role: 'start' }
              if (event?.type === 'tool/result') return { id: String(event.data?.toolCallId ?? event.data?.message?.toolCallId ?? event.seq), role: 'update' }
              return null
            },
            start: (_context, match) => ({
              id: String(match.event.data?.callId ?? match.event.seq),
              seq: match.event.seq ?? 0,
              name: String(match.event.data?.name ?? 'tool'),
              args: typeof match.event.data?.arguments === 'string' ? match.event.data.arguments : '',
              result: '',
            }),
            update: (context, match) => ({
              ...context.state,
              result: blockText(match.event.data?.message?.content, 'text'),
            }),
            buildViewNode: context => (context.state === undefined
              ? null
              : { key: `side-tool:${context.state.id}`, kind: 'side-tool', id: context.state.id, target: SIDE_TARGET, data: context.state }),
          }
          return [seed, user, assistant, live, tool]
        }

        /** @param {object} event - assistant/message event. @returns {object} node state. */
        function assistantState(event) {
          const message = event?.data?.message ?? {}
          return {
            id: String(event.seq),
            seq: event.seq ?? 0,
            turn: event?.data?.turn ?? 0,
            text: blockText(message.content, 'text'),
            reasoning: blockText(message.content, 'reasoning'),
            images: blockImages(message.content),
          }
        }

        /** @param {object} event - assistant/attempt event. @returns {string} stable id. */
        function liveId(event) {
          return `live:${event?.data?.turn ?? 0}:${event?.data?.step ?? 0}`
        }

        /** @param {object} event - assistant/attempt event. @returns {object} node state. */
        function liveState(event) {
          const { text, reasoning } = accumulateStream(event?.data?.stream)
          return {
            id: liveId(event),
            seq: Number.MAX_SAFE_INTEGER - 1,
            turn: event?.data?.turn ?? 0,
            text,
            reasoning,
            images: [],
          }
        }

        /**
         * Incremental builder for the side target: keeps the seed boundary, drops live
         * attempts once their message is committed, and publishes only nodes after the cut.
         * @returns {object} ConversationViewBuilder.
         */
        function createSideBuilder() {
          let nodes = []
          const publish = () => {
            let boundary = -1
            let committedTurn = -1
            for (const node of nodes) {
              if (node.kind === 'side-seed') boundary = Math.max(boundary, node.data?.seq ?? -1)
              if (node.kind === 'side-assistant') committedTurn = Math.max(committedTurn, node.data?.turn ?? -1)
            }
            const visible = nodes.filter(node => {
              if (boundary < 0) return true
              const seq = node.data?.seq ?? 0
              if (node.kind === 'side-seed') return false
              if (seq <= boundary) return false
              if (node.kind === 'side-live' && (node.data?.turn ?? 0) <= committedTurn) return false
              return true
            })
            return { nodes: visible, inherited: nodes.length - visible.length }
          }
          return {
            empty: { nodes: [], inherited: 0 },
            replace(input) {
              nodes = [...(input?.nodes ?? [])].sort((left, right) => (left.data?.seq ?? 0) - (right.data?.seq ?? 0))
              return publish()
            },
            apply(input) {
              const byKey = new Map(nodes.map(node => [node.key, node]))
              for (const node of input?.upserts ?? []) byKey.set(node.key, node)
              nodes = [...byKey.values()].sort((left, right) => (left.data?.seq ?? 0) - (right.data?.seq ?? 0))
              return publish()
            },
            isActive: () => false,
          }
        }

        /** Register the target once the Conversation service exists. */
        function registerConversationTarget(scope) {
          conversation = scope.uiConversation
          scope.effect(() => guardSlot('side conversation target', () => scope.uiConversation.views.register({
            target: SIDE_TARGET,
            create: () => createSideBuilder(),
          })), 'dsh-side: side conversation target')
          for (const definition of sideDefinitions()) {
            scope.effect(() => guardSlot(`side ${definition.kind} node`, () => scope.uiConversation.events.register(definition)),
              `dsh-side: ${definition.kind} node`)
          }
        }

        /** The side panel transcript: only what this session recorded after the fork cut. */
        function SideTranscript(props) {
          const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
          const source = React.useMemo(() => {
            if (conversation === undefined || sessionId === undefined) return undefined
            try {
              return conversation.binding(sessionId).target(SIDE_TARGET)
            } catch (error) {
              console.warn('[dsh-side] could not open the side transcript target:', error)
              return undefined
            }
          }, [sessionId])
          const snapshot = useObservable(source)
          const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
          const inherited = typeof snapshot?.inherited === 'number' ? snapshot.inherited : 0
          const body = React.useRef(null)
          const pinned = React.useRef(true)
          const streamLength = nodes.reduce((total, node) => total + String(node.data?.text ?? '').length, 0)

          React.useEffect(() => {
            const element = body.current
            const scroller = element?.closest?.('[data-conversation-scroll]') ?? null
            if (scroller === null) return undefined
            const onScroll = () => {
              pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
            }
            onScroll()
            scroller.addEventListener('scroll', onScroll, { passive: true })
            return () => scroller.removeEventListener('scroll', onScroll)
          }, [])

          React.useEffect(() => {
            const element = body.current
            const scroller = element?.closest?.('[data-conversation-scroll]') ?? null
            if (scroller === null) {
              element?.scrollIntoView?.({ block: 'end' })
              return
            }
            if (pinned.current) scroller.scrollTop = scroller.scrollHeight
          }, [nodes.length, streamLength])

          return h('div', {
            ref: body,
            style: {
              display: 'flex', flexDirection: 'column',
              width: '100%', maxWidth: 'var(--dsh-chat-content-width, 748px)',
              margin: '0 auto', boxSizing: 'border-box',
              padding: '12px 16px calc(var(--dsh-composer-height, 96px) + 20px)',
              fontSize: 'var(--dsh-content-font-size, 14px)', lineHeight: 1.65,
              gap: 'var(--dsh-assistant-block-gap, 16px)',
            },
          },
          h('style', { key: 'blink' }, '@keyframes dsh-side-blink{50%{opacity:0}}'),
          inherited > 0
            ? h('div', {
              style: {
                alignSelf: 'center', padding: '2px 10px', borderRadius: '999px',
                fontSize: 'var(--dsh-content-font-size-secondary, 13px)', opacity: 0.55,
                border: '1px dashed var(--dsw-alias-line, rgba(127,127,127,0.4))',
              },
            }, `已继承 ${inherited} 条历史`)
            : null,
          ...nodes.map(node => {
            const data = node.data ?? {}
            if (node.kind === 'side-user') {
              return h('div', { key: node.key, style: { display: 'flex', justifyContent: 'flex-end' } },
                h('div', {
                  style: {
                    maxWidth: '82%', padding: '8px 12px', borderRadius: '14px',
                    background: 'var(--dsw-specific-input-major, rgba(127,127,127,0.14))',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  },
                },
                data.text,
                ...(data.images ?? []).map((block, index) => h(ImageBlock, { key: `i${index}`, sessionId, block }))))
            }
            if (node.kind === 'side-assistant' || node.kind === 'side-live') {
              return h('div', { key: node.key, style: { display: 'flex', flexDirection: 'column' } },
                data.reasoning !== ''
                  ? h(Disclosure, { key: 'reasoning', summary: '思考过程' }, data.reasoning)
                  : null,
                data.text === '' && node.kind === 'side-live'
                  ? h('div', { key: 'waiting', style: { opacity: 0.55 } }, '思考中…')
                  : h(Markdown, { key: 'body', text: data.text ?? '' }),
                ...(data.images ?? []).map((block, index) => h(ImageBlock, { key: `i${index}`, sessionId, block })),
                node.kind === 'side-live'
                  ? h('span', {
                    key: 'caret',
                    style: {
                      display: 'inline-block', width: '7px', height: '1em', marginLeft: '2px',
                      background: 'currentColor', opacity: 0.6, animation: 'dsh-side-blink 1s steps(2) infinite',
                    },
                  })
                  : null)
            }
            if (node.kind === 'side-tool') {
              return h(ToolRow, { key: node.key, data })
            }
            return null
          }),
          )
        }

        /** The product's own conversation shell, with our transcript in its view position. */
        function OfficialChatPanel(props) {
          if (typeof props.renderFactorySlot !== 'function' || typeof props.useSession !== 'function') {
            return h(Unavailable, {
              sessionId: props.sessionId, note: t('fallback.note'), open: t('fallback.open'), onOpen: openInMain,
            })
          }
          return h(OfficialChatInner, props)
        }

        /** Official shell and composer; only the transcript position is ours. */
        function OfficialChatInner(props) {
          const { useSession, renderFactorySlot, sessionId } = props
          const session = useSession(value => value)
          const loading = session?.openState === 'loading'
          const blank = session?.blank !== false && session?.awaitingFirstTurn !== false
          const phase = loading && blank ? 'settling' : 'active'
          const views = React.useMemo(() => {
            const Views = viewProps => h(SideTranscript, { ...viewProps, sessionId })
            return Views
          }, [sessionId])
          return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: false }, {
            slots: { views },
          })
        }

        /** The Sidebar tab body: bind the resource's Session and render the product UI. */
        function SideTab(props) {
          const { useResource, useTabInfo, renderSlot, SessionProvider } = props
          const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
          const contentId = info?.tab?.contentId
          const sessionId = sessionIdOf(contentId)
          // The tab holds its own reference for the whole lifetime of the panel.
          // Reading the resource on every render handed SessionProvider a new identity
          // (or a released one) again and again, which showed up as flicker, collapsed
          // tool details and a stop button that never reached the live session.
          const [retained, setRetained] = React.useState(undefined)
          React.useEffect(() => {
            if (typeof sessionId !== 'string' || sessionId === '') return undefined
            let reference
            try {
              reference = ctx.sessions.retain(sessionId, { source: REFERENCE_SOURCE })
            } catch (error) {
              console.warn('[dsh-side] could not retain the side conversation for its panel:', error)
              return undefined
            }
            setRetained(reference)
            return () => {
              try {
                reference.release()
              } catch (_alreadyReleased) {
                // Releasing twice is harmless.
              }
            }
          }, [sessionId])
          if (typeof renderSlot !== 'function' || typeof SessionProvider !== 'function') {
            return h(Unavailable, {
              sessionId: sessionId ?? '', note: t('fallback.note'), open: t('fallback.open'), onOpen: openInMain,
            })
          }
          if (retained === undefined) return null
          return h('div', {
            'data-side-chat': '',
            style: { display: 'flex', width: '100%', height: '100%', minWidth: 0, minHeight: 0 },
          }, h(SessionProvider, { session: retained }, renderSlot(TRANSCRIPT_SEAT, { sessionId })))
        }

        /**
         * The tab chip mark: one closed speech-bubble path with a smooth tail, plus a
         * plus sign inside. A single path is what keeps the tail and the body fused —
         * a separate tail stroke would leave a seam across the bubble outline.
         */
        function SideMark(props) {
          const size = typeof props?.size === 'number' ? props.size : 16
          return h('svg', {
            width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
            className: typeof props?.className === 'string' ? props.className : undefined,
            'aria-hidden': 'true', focusable: 'false',
            style: { flex: '0 0 auto', display: 'block' },
          }, h('g', {
            // Mirror the canonical message-circle so the tail sits bottom-right.
            transform: 'translate(24 0) scale(-1 1)',
            stroke: 'currentColor', strokeWidth: 1.9,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }, [
            h('path', { key: 'bubble', d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' }),
            h('path', { key: 'plus-v', d: 'M12 8.6v7.2' }),
            h('path', { key: 'plus-h', d: 'M8.4 12.2h7.2' }),
          ]))
        }

        /** Chip content: the localized label with its mark and breathing room. */
        function SideTabTitle() {
          return h('span', {
            style: {
              display: 'inline-flex', alignItems: 'center', gap: '0.5em',
              minWidth: '8.5em', fontSize: 'inherit', lineHeight: 'inherit',
            },
          }, h(SideMark, { key: 'mark', size: 15 }), h('span', { key: 'label' }, t('tab.title')))
        }

        /** Register the resource owner, tab type, tab body, and title. */
        function registerTab(scope) {
          scope.effect(() => guardSlot('side conversation resource', () => scope.resources.register({
            protocol: PROTOCOL,
            async *open(resourceAddress, { signal }) {
              const sessionId = sessionIdOf(resourceAddress)
              if (sessionId === undefined) {
                throw new Error(`dsh-side: invalid side conversation address "${resourceAddress}"`)
              }
              if (signal.aborted) return
              const reference = scope.sessions.retain(sessionId, { source: REFERENCE_SOURCE, signal })
              try {
                yield { ok: true, value: { sessionId, reference } }
                await waitForAbort(signal)
              } finally {
                reference.release()
              }
            },
          })), 'dsh-side: side conversation resource')

          scope.effect(() => guardSlot('side conversation tab type', () => scope.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            patterns: [`${ADDRESS_PREFIX}**`],
            priority: 'extension',
            canOpen: address => sessionIdOf(address) !== undefined,
            title: () => t('tab.title'),
          })), 'dsh-side: side conversation tab type')

          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => guardSlot(
            'side conversation tab body',
            () => scope.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              children: { [TRANSCRIPT_SEAT]: { kind: 'single', scope: 'session' } },
            }, SideTab),
          )), 'dsh-side: side conversation tab body')

          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => guardSlot(
            'side conversation tab title',
            () => scope.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: TAB_ID,
            }, SideTabTitle),
          )), 'dsh-side: side conversation tab title')

          scope.effect(() => guardSlot('side conversation guide card', () => scope.sidebarRightTabs.register({
            id: PAGE_ID,
            kind: PAGE_KIND,
            multiple: true,
            title: () => t('tab.title'),
            guide: [{
              id: 'new',
              order: 10,
              title: () => t('tab.title'),
              description: () => t('guide.description'),
              icon: SideMark,
            }],
          })), 'dsh-side: side conversation guide card')

          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => guardSlot(
            'side conversation guide page',
            () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: PAGE_ID }, NewSideTab),
          )), 'dsh-side: side conversation guide page')

          scope.effect(() => scope.slots.inject(TRANSCRIPT_SEAT, () => guardSlot(
            'side conversation content',
            () => scope.slots.register({ name: TRANSCRIPT_SEAT }, OfficialChatPanel),
          )), 'dsh-side: side conversation content')
        }

        ctx.inject(['resources', 'sidebarRightTabs'], scope => registerTab(scope))
        ctx.inject(['uiConversation'], scope => registerConversationTarget(scope))

        // Closing the panel ends the side conversation: stop the run and archive it,
        // so it leaves the Session list instead of lingering as a running orphan.
        ctx.effect(() => {
          try {
            return ctx.sidebarRight.registerCloseHandler(KIND, (_sessionId, tab) => {
              const sideSessionId = sessionIdOf(tab?.contentId)
              if (sideSessionId === undefined) return
              void retire(sideSessionId)
            })
          } catch (error) {
            console.warn('[dsh-side] close handling is unavailable:', error)
            return () => {}
          }
        }, 'dsh-side: close cleanup')

        /**
         * Find the Workspace the parent conversation belongs to. A side session joins
         * it, so the composer shows the project and the workspace file page works.
         * @param {string} parentSessionId - the thread being sided.
         * @returns {string | undefined} Workspace id.
         */
        function workspaceIdOf(parentSessionId) {
          let service
          try {
            service = ctx.workspaces ?? ctx.get?.('workspaces')
          } catch (_noWorkspaces) {
            return undefined
          }
          try {
            const items = service?.list?.getSnapshot?.()?.items
            if (!Array.isArray(items)) return undefined
            const owning = items.find(item => Array.isArray(item?.sessionIds)
              && item.sessionIds.includes(parentSessionId))
            return typeof owning?.workspaceId === 'string' ? owning.workspaceId : undefined
          } catch (_unreadableWorkspaces) {
            return undefined
          }
        }

        /**
         * @returns {Record<string, number>} remembered session id → title number.
         */
        function sideNumbers() {
          try {
            const parsed = JSON.parse(window.localStorage.getItem(SIDE_TITLES_KEY) ?? '{}')
            return parsed !== null && typeof parsed === 'object' ? parsed : {}
          } catch (_unavailableStorage) {
            return {}
          }
        }

        /**
         * @param {Record<string, number>} numbers - map to persist.
         */
        function saveSideNumbers(numbers) {
          try {
            window.localStorage.setItem(SIDE_TITLES_KEY, JSON.stringify(numbers))
          } catch (_unavailableStorage) {
            // Losing the map at worst repeats a number; the panel still works.
          }
        }

        /**
         * Next free number, derived from the side sessions that still exist. Deleting a
         * side session frees its number, so a fresh panel reuses it instead of counting
         * up forever.
         * @returns {number} the number to use.
         */
        function nextSideNumber() {
          const known = ctx.sessions.list.getSnapshot().byId ?? {}
          let highest = 0
          for (const [sessionId, number] of Object.entries(sideNumbers())) {
            if (known[sessionId] === undefined) continue
            if (Number.isSafeInteger(number) && number > highest) highest = number
          }
          return highest + 1
        }

        /**
         * @param {number} number - the session's number.
         * @returns {string} 「侧边会话」 or 「侧边会话（n）」.
         */
        function sideTitle(number) {
          const base = t('session.title')
          return number === 1 ? base : `${base}（${number}）`
        }

        /**
         * Fork this thread at event zero and mark the child for the Host.
         *
         * Event zero of a Session is a configuration event (`permission/preset` or
         * `subagent/descriptor`), never a message, so the seed carries no transcript
         * row. The fork inherits the workspace, directory and agent preset from the
         * source, which is why nothing here resolves a workspace.
         *
         * @param {string} parentSessionId - the thread the user invoked `/side` from.
         * @returns {Promise<string | undefined>} the new Session id.
         */
        async function createSide(parentSessionId) {
          if (typeof parentSessionId !== 'string' || parentSessionId === '') return undefined
          let childId
          try {
            // A real fork: the child inherits the parent's events verbatim (roles, tool
            // calls, reasoning), so the model context is lossless. The transcript hides
            // that prefix instead of the context.
            childId = await ctx.sessions.fork({ sessionId: parentSessionId })
          } catch (error) {
            console.warn('[dsh-side] could not fork a side session:', error)
            return undefined
          }
          if (typeof childId !== 'string' || childId === '') {
            console.warn('[dsh-side] the Host returned no Session id')
            return undefined
          }
          remember(childId)
          const number = nextSideNumber()
          await renameSideSession(childId, sideTitle(number))
          saveSideNumbers({ ...sideNumbers(), [childId]: number })
          return childId
        }

        /**
         * Create the side Session and open it from the command surface.
         * @param {string} parentSessionId - the thread the command ran in.
         */
        async function openSide(parentSessionId) {
          const childId = await createSide(parentSessionId)
          if (childId === undefined) return
          try {
            ctx.sidebarRight.openResource(addressOf(childId), { kind: KIND, preferNewPane: true })
          } catch (error) {
            console.warn('[dsh-side] could not open the side conversation panel:', error)
            void retire(childId)
          }
        }

        /**
         * Body of the guide card's page: start a side conversation beside whatever
         * Session this Sidebar is showing, then replace this page with it.
         * @param {object} props - framework-injected slot props.
         */
        function NewSideTab(props) {
          const { useTabInfo } = props
          const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
          const started = React.useRef(false)
          const [parent, setParent] = React.useState(null)

          React.useEffect(() => {
            if (started.current) return
            started.current = true
            let sessionId
            try {
              sessionId = ctx.sidebarRight.mounted?.getSnapshot?.()
            } catch (_unreadableMount) {
              sessionId = undefined
            }
            if (typeof sessionId !== 'string') {
              setParent('')
              return
            }
            setParent(sessionId)
            void createSide(sessionId).then((childId) => {
              if (childId === undefined) return
              const address = addressOf(childId)
              try {
                const actions = info?.tab?.actions
                if (typeof actions?.openResource === 'function') {
                  actions.openResource(address, { replaceTab: true })
                  return
                }
                ctx.sidebarRight.openResource(address, { kind: KIND, replaceTab: true })
              } catch (error) {
                console.warn('[dsh-side] could not hand the guide card off to the panel:', error)
                void retire(childId)
              }
            })
          }, [info])

          if (parent === '') {
            return h('div', {
              style: {
                padding: '16px', opacity: 0.6,
                fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
                lineHeight: 'calc(18px + var(--dsh-content-font-delta-secondary, 0px))',
              },
            }, t('guide.noSession'))
          }
          return null
        }

        ctx.effect(() => guardSlot('the /side command', () => ctx.commandUi.register({
          name: 'side',
          icon: SideMark,
          label: () => t('command.label'),
          description: () => t('command.description'),
          available: () => true,
          ui: {
            kind: 'action',
            run(session) {
              void openSide(session.sessionId)
            },
          },
        })), 'dsh-side: /side command')

        // Reconcile leftovers from a crash or a page reload: a side Session with no
        // open panel would otherwise stay unarchived and visible in the Session list.
        const reconcileTimer = setTimeout(() => {
          const open = new Set()
          try {
            const tabs = ctx.sidebarRight.openTabs?.getSnapshot?.() ?? []
            const list = Array.isArray(tabs) ? tabs : Object.values(tabs ?? {})
            for (const tab of list) {
              const id = sessionIdOf(tab?.contentId ?? tab?.address)
              if (id !== undefined) open.add(id)
            }
          } catch (_unreadableTabs) {
            return
          }
          for (const sessionId of remembered()) {
            if (!open.has(sessionId)) void retire(sessionId)
          }
        }, RECONCILE_DELAY_MS)
        ctx.effect(() => () => { clearTimeout(reconcileTimer) }, 'dsh-side: orphan reconciliation')
      },
    }
  },
})
