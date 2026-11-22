# Contributing

Thanks for taking a look. This is a small plugin, and small contributions are
welcome.

## Run the tests

```bash
npm test
```

It runs two dependency-free Node scripts:

- `test/client.test.mjs` — loads `client.js` in a fake module loader with a fake
  Cordis context and checks the browser half: session creation, title marker, tab
  registration, close/archive, and failure containment.
- `test/host.test.mjs` — loads `index.js` with a fake Host context and a real
  temporary storage root, then checks context injection and transcript cleanup.

No dependencies, no build step. Node 22+.

## What lives where

- `client.js` — browser half: `/side` command, start-page card, tab body and chip,
  close handling. It must not render chat UI of its own.
- `index.js` — Host half: reads the title marker, injects the parent conversation,
  and reaps archived side sessions from disk.

## House rules

1. **Do not reimplement product UI.** The panel renders the product's
   `conversation.content`; the composer is the product's `conversation.composer.bar`.
   Anything hand-drawn there will rot the moment the product changes.
2. **Stay dependency-free.** No packages, no bundler, no compile step.
3. **Contain failures.** Every registration goes through `guardSlot()`; a rejected
   slot must cost that seat only, never the command.
4. **Be honest in the README.** If something is best-effort (transcript deletion,
   context injection), say so.

## Pull requests

Keep the change focused, run `npm test`, and describe what you verified in the app.
Screenshots help for anything visual.
