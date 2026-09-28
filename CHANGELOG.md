# Changelog

## 8.0.0 — capability, precision and speed

### Added — a real tool surface (20 → 45 tools)

- **MAIN-world bridge (`main.js`).** Runs at `document_start` in the page's own JS
  world, where the isolated content script cannot reach, and captures `console.*` and
  native `alert`/`confirm`/`prompt` into DOM slots the content script reads back. The
  dialog policy is `record` by default, so page behaviour is unchanged unless the agent
  asks for `accept`/`dismiss` because a dialog is blocking a run.
- **Reading tools.** `page_state` (cheap state plus a content hash), `query_elements`
  (structured list for any selector, with accessible names and rects), `get_table`
  (headers, rows, or objects keyed by header), `get_form` (labels, values, required
  flags, options, validation state), `find_in_page` (text with surrounding context),
  `get_selection`, `console_logs`, `dialog_log`, `network_log`, `styles_of` (computed
  styles plus the WCAG contrast ratio).
- **Deterministic audits.** `audit` with `kind: seo | a11y | perf | links | content | all`
  returns a 0–100 score with a severity-ranked issue list, instead of leaving the model
  to guess. The accessibility audit computes real contrast ratios against the effective
  (blended) background.
- **Action tools.** `clear_field`, `check`, `hover`, `focus`, `click_at`, `submit_form`
  (respects validation), `scroll_to`.
- **Smart waits.** `wait_for_element`, `wait_for_text`, `wait_for_dom_stable`,
  `wait_for_network_idle` — each returns as soon as the condition holds and reports a
  timeout honestly instead of hanging.
- **Change proofs.** `mark_page` / `diff_page` report the url, text delta, control delta
  and the added/removed content, so "it worked" is evidence rather than assumption.
- **Human-verification assist with automatic resume.** `detect_human_check` identifies
  the challenge and the vendor (reCAPTCHA, hCaptcha, Cloudflare Turnstile, Arkose,
  GeeTest, DataDome, PerimeterX, AWS WAF, MTCaptcha). The run pauses, shows the user the
  visible screen, and a watchdog polls the page — **the moment the user solves it, the
  run resumes from the same step**. The extension never solves, clicks or bypasses a
  challenge; detection and pausing is the whole feature.
- **Conversation export** as JSON (current chat, or every chat) with both the raw
  message array and a readable Markdown transcript.
- **A "Tools" settings tab** documenting all 45 tools, grouped by permission
  (read / act / wait / safety), translated into both languages.

### Added — speed and accuracy

- **Parallel read-only execution.** Consecutive read-only tool calls in one turn now run
  concurrently; any mutating call is a barrier, so the order the model asked for is the
  order the page sees. `mark_page`/`diff_page` are deliberately excluded so a diff can
  never race its own marker.
- **Auto-verification.** Every mutating action is followed by a cheap `page_state` read
  and the delta is attached to the tool result as an `after` block — "the page did NOT
  change after this action" is the single most useful signal a browser agent can get.
  The baseline is seeded at run start so even the first action is meaningful.
- **Snapshot caching** (invalidated by any mutating action) and **speed profiles**:
  `fast` (no verification, longer cache), `balanced` (default), `thorough` (never cache,
  re-read after every action).
- **Smarter element location**: loose matching folds case, punctuation, curly quotes and
  diacritics, and falls back through `elementId` → selector → role → text → index.
- **A broken selector now fails loudly.** `querySelectorAll` swallows `SyntaxError` and
  returns an empty list, which reads to the model as "that element does not exist"
  instead of "your selector is wrong".

### Fixed — found while building 8.0.0

- **`document.readyState` in the change token.** The token answered "did the page content
  change?" but included the load lifecycle, so a page simply finishing its load looked
  like a change. Caught by a test that read the state twice.
- **`<thead>` rows leaked into table data.** Headers were read correctly but the header
  row was also emitted as the first data row.
- **Prototype pollution in the content-script dispatcher.** `HANDLERS["constructor"]`
  resolved to `Object` through the prototype chain and returned
  `{ok:true,data:{}}` — a fabricated successful tool result. The map is now built with
  `Object.create(null)`.
- **Accessible names were wrong.** The label lookup fell back to the `name` attribute and
  the tag name, which are not accessible-name sources; genuinely unlabelled fields were
  therefore reported as labelled. It now follows the HTML-AAM precedence order.
- **Watchdog edge case**: an unreachable frame (navigation, removed iframe) is no longer
  mistaken for a solved challenge.

### Verification

- Suite grown from **342 to 648 assertions** plus 12 static checks; still fully green.
- Four new cross-file static guards, each validated by injecting the bug it exists to
  catch: worker dispatch ↔ content-script handler, declared tool ↔ `act()` branch,
  declared tool ↔ panel tool catalogue, and the MAIN-world manifest registration.
- New harness findings recorded in the verification skill (see `README`).

## 7.0.0 — interface and reliability overhaul

### Fixed — real defects found in 6.0.0

- **Quick actions vanished after "New chat".** `newSession()` rebuilt only part of the
  welcome block, so the four capability buttons and the three capability chips were
  destroyed and their click handlers (bound to the removed nodes) went with them.
  The welcome markup is now captured once at boot and restored verbatim; clicks are
  handled by delegation on the message container, so they survive any re-render.
- **Message trimming could break the API contract.** `compactMessages()` sliced a fixed
  tail, which could keep an `assistant` message carrying `tool_calls` while dropping its
  `tool` replies, or keep a `tool` reply whose parent had been cut away. Both shapes are
  rejected by OpenAI-compatible endpoints. Trimming now keeps assistant/tool pairs
  together, drops unanswered calls (keeping their text), and drops orphan replies.
  This is reachable in practice: a run cancelled mid-turn leaves a dangling tool call.
- **Non-deterministic frame targeting.** `chrome.tabs.sendMessage` without `frameId`
  reaches every frame and the first responder wins, so an action could be answered by
  the wrong frame. Actions now target the main frame and fall back to locating the
  frame that actually holds the element.
- **`type` failed on contenteditable elements.** The check used `isContentEditable`
  alone, which is `false` for offscreen or hidden nodes. It now also honours the
  `contenteditable` attribute and raises a clear error for non-editable targets.
- **Shadow DOM content was invisible.** The deep query short-circuited as soon as the
  light DOM had any match, so snapshots missed controls inside web components.
  Snapshots and diagnostics now merge light and shadow DOM; element location keeps the
  fast light-DOM-first path.
- **A stray stream delta could silently swallow the answer.** If a delta arrived while
  streaming was disabled it was appended to the "already streamed" buffer, and the
  final message was then discarded as a duplicate.
- **Empty session orphaning.** Selecting an empty conversation created a new session id
  and left the old entry stranded in history.
- **Quick action labels never translated**, `window.confirm` blocked the panel, and
  `#statusModel` showed a stale model.

### Added

- **Live streaming answers** (SSE) with automatic fallback to a non-streaming request
  when a provider rejects `stream: true`.
- **Plan mode that cannot mutate the page.** The first turn's tool calls are discarded,
  so a plan is always a plan; an "Execute plan" card then runs it in Agent mode.
- **Research mode** constrained to read-only tools.
- **`press_key` tool** for submitting search boxes and dismissing dialogs.
- **Stable `elementId`s** on every snapshot control, so the model re-targets elements
  reliably instead of guessing CSS selectors.
- **`extract` formats**: `text`, `html`, `links`.
- **Settings drawer with four tabs** — Connection, Agent, Appearance, About.
- **Appearance controls**: dark / light / system theme, four accent colours, three text
  sizes, all persisted.
- **Markdown rendering** in answers: headings, lists, quotes, inline code and fenced
  code blocks with a per-block copy button.
- **Copy action** on every message; **toast notifications**; a real **modal** replacing
  `window.confirm`, including per-conversation delete confirmation.
- **Keyboard support**: Enter sends (configurable), Shift+Enter newline, `Esc` closes
  overlays, `Ctrl/Cmd+K` focuses the composer, `Alt+1/2/3` switch mode. IME-safe.
- **Desktop notification** when a task finishes in the background (opt-in).
- **Scroll-to-latest button**, auto-growing composer, live step counter and elapsed timer.
- **Accessibility**: labelled icon buttons, `aria-pressed` modes, `role="log"` timeline,
  visible focus rings, `prefers-reduced-motion` support.
- **Full RTL** via logical CSS properties.
- **Verification suite** (`/.workbuddy-ai/tools/run-suite.mjs`) — 342 assertions plus
  static reference checks. Every guard was validated by injecting the bug it exists to
  catch.

### Changed

- Settings are no longer re-discovered on every panel open; the stored connection state
  is shown and can be re-tested on demand.
- Model chatter (`request 1/2`) is reported in the status bar instead of the timeline.
- Storage writes are throttled; agent state is persisted on transitions only.
- Unused SVG symbols and the unused `speedMode` setting were removed.
- Manifest version bumped to 7.0.0.

## 6.0.0
- Resilient agent loop, parallel model health checks, resume from persisted state,
  human-verification pause flow.

## 5.0.0
- Fixed the Chat Completions request that sent an undefined `messages` variable.
- Deterministic 4xx failures fail over immediately instead of consuming retries.
