# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0]

### Added

- Repository scaffolding: test suites under `test/`, `npm test`, CI workflow,
  issue template, changelog and contributing guide.

### Changed

- README rewritten around three real screenshots and a plain-language explanation
  of the mechanism.

## [3.1.2]

### Changed

- The `/side` command description is now "发起临时侧边会话，继承当前上下文"
  (`Start a temporary side session that inherits the current context`).

## [3.1.1]

### Added

- The same bubble mark now appears in three places: the tab chip, the slash-command
  row, and the start-page card.
- The tab chip reserves more horizontal room.

## [3.1.0]

### Added

- A **Side session** card on the right Sidebar's start page, backed by a page tab
  type that hands the card over to the real conversation tab.

### Changed

- Chinese copy standardised on 「侧边会话」.
- New single-path speech-bubble icon with a seamless tail.

## [3.0.1]

### Fixed

- The panel no longer renders the product's new-conversation hero (brand mark and
  workspace picker). The side session joins the parent's workspace automatically, so
  only the docked composer shows.

## [3.0.0]

### Changed

- **Rewritten around `sessions.create()` + `agent.inject()` instead of a fork seed.**
  A fork copies the parent's turns into the child log, and the product's chat renders
  that log, so a forked side panel could never start clean. The Host half now injects
  the parent's model-visible messages as one durable context record, which keeps the
  transcript empty while the model still reads the thread.
- The panel renders the product's own `conversation.content`, so the bundle ships no
  hand-written chat UI: official rows, official composer, official shortcuts, and any
  future composer contribution from other plugins.

### Removed

- The custom Conversation target, message rows, Markdown renderer and built-in
  composer from the earlier filtered-panel design.

## [2.5.x]

### Fixed

- Late-service registration: the filtered renderer now waits for `ui-conversation`
  and falls back to the official panel when it cannot register.
- Slot registration failures are contained per seat, so a rejected slot can no longer
  disable the `/side` command.

## [2.2.0]

### Added

- Internal reaper that deletes a closed side session's stored transcript, driven by a
  title marker written by the browser half (`〔side〕<parentSessionId>`).

## [2.1.0]

### Added

- First release: `/side` forks the current thread into an independent session shown in
  the right Sidebar, archived with `stopActivity` when its tab closes.
