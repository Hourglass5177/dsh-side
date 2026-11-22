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
    const CHAT_SLOT = 'side.chat.conversation'

    /** Parent-side reference source recorded by the resource provider. */
    const REFERENCE_SOURCE = 'sideChat'

    /** Title marker the Host half watches: `〔side〕<parentSessionId>`. */
    const SIDE_MARK = '〔side〕'

    /** Title a side session carries once its tab closed; the Host reaper deletes these. */
    const SIDE_CLOSED_MARK = '〔side-closed〕'

    /** Localized copy namespace. */
    const NS = 'dsh-side'

    /** Record of live side Sessions, so a crash or reload cannot leak them. */
    const STORAGE_KEY = 'dsh-side.sessions.v1'

    /** Wait before reconciling orphans; the Sidebar restores tabs during boot. */
    const RECONCILE_DELAY_MS = 2500

    const DICTIONARIES = {
      en: {
        'command.label': 'Side session',
        'command.description': 'Start a temporary side session that inherits the current context',
        'tab.title': 'Side session',
        'guide.description': 'Open a temporary session beside this one',
        'guide.noSession': 'No conversation is open in this panel.',
        'fallback.note': 'This panel could not load the conversation inline.',
        'fallback.open': 'Open in the main view',
      },
      zh: {
        'command.label': '侧边会话',
        'command.description': '发起临时侧边会话，继承当前上下文',
        'tab.title': '侧边会话',
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
          // Mark it closed first: the Host only reclaims storage for closed sessions,
          // so a live one stays hidden without being deleted underneath its tab.
          await renameSideSession(sessionId, SIDE_CLOSED_MARK)
          try {
            await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true })
          } catch (error) {
            console.warn('[dsh-side] could not archive the side conversation:', error)
          }
        }

        /**
         * Rename a side Session while it is retained. The title is the only durable
         * fact a browser can write that the Host observes without a slash command.
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

        /**
         * Title the side Session the way the Host expects to find it.
         * @param {string} sessionId - the new side Session.
         * @param {string} parentSessionId - the thread it inherits from.
         */
        async function markSideSession(sessionId, parentSessionId) {
          await renameSideSession(sessionId, `${SIDE_MARK}${parentSessionId}`)
        }

        /** @param {string} sessionId - side Session. */
        function openInMain(sessionId) {
          try {
            ctx.uiWorkspace.openSession(sessionId)
          } catch (error) {
            console.warn('[dsh-side] could not open the side conversation in the main view:', error)
          }
        }

        /** The product's own conversation content, hosted inside this tab. */
        function OfficialChatPanel(props) {
          if (typeof props.renderFactorySlot !== 'function' || typeof props.useSession !== 'function') {
            return h(Unavailable, {
              sessionId: props.sessionId, note: t('fallback.note'), open: t('fallback.open'), onOpen: openInMain,
            })
          }
          return h(OfficialChatInner, props)
        }

        /** Official presentation; receives the framework-injected hooks as props. */
        function OfficialChatInner(props) {
          const { sessionId, useSession, useConversation, useSessions, renderFactorySlot } = props
          const session = useSession(value => value)
          const conversation = useConversation(value => value)
          const summaryBlank = typeof useSessions === 'function'
            ? useSessions(state => state.byId?.[sessionId]?.blank)
            : undefined
          const active = (conversation?.activeTargets?.size ?? 0) > 0
            || (!session.blank && !session.awaitingFirstTurn)
            || session.running
          const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
          const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
          // This panel is a side chat, not a new-conversation screen: never render
          // the product's hero (brand mark + workspace picker) and never show the
          // blank-phase placeholder. The transcript stays empty and only the docked
          // composer shows, exactly like a side chat.
          const hero = false
          const phase = settling ? 'settling' : shellPhase === 'blank' ? 'active' : shellPhase
          const views = (viewProps) => h(React.Fragment, null, viewProps.renderSlot('conversation.session', { view: 'chat' }))
          return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
            slots: { views },
          })
        }

        /** The Sidebar tab body: bind the resource's Session and render the product UI. */
        function SideTab(props) {
          const { useResource, useTabInfo, renderSlot, SessionProvider } = props
          const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
          const contentId = info?.tab?.contentId
          const sessionId = sessionIdOf(contentId)
          const resource = typeof useResource === 'function' && typeof contentId === 'string'
            ? useResource(contentId)
            : undefined
          if (typeof renderSlot !== 'function' || typeof SessionProvider !== 'function') {
            return h(Unavailable, {
              sessionId: sessionId ?? '', note: t('fallback.note'), open: t('fallback.open'), onOpen: openInMain,
            })
          }
          if (resource?.value?.reference === undefined) return null
          return h('div', {
            'data-side-chat': '',
            style: { display: 'flex', width: '100%', height: '100%', minWidth: 0, minHeight: 0 },
          }, h(SessionProvider, { session: resource.value.reference }, renderSlot(CHAT_SLOT, {})))
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
              children: { [CHAT_SLOT]: { kind: 'single', scope: 'session' } },
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

          scope.effect(() => scope.slots.inject(CHAT_SLOT, () => guardSlot(
            'side conversation content',
            () => scope.slots.register({ name: CHAT_SLOT }, OfficialChatPanel),
          )), 'dsh-side: side conversation content')
        }

        ctx.inject(['resources', 'sidebarRightTabs'], scope => registerTab(scope))

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
            childId = await ctx.sessions.fork({ sessionId: parentSessionId, atSeq: 0 })
          } catch (error) {
            console.warn('[dsh-side] could not fork a side session:', error)
            return undefined
          }
          if (typeof childId !== 'string' || childId === '') {
            console.warn('[dsh-side] the Host returned no Session id')
            return undefined
          }
          remember(childId)
          await markSideSession(childId, parentSessionId)
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
