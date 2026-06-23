# Phase 3 — Stop "Auto-Load Without Touch"

## Problem

Today the kiosk has **four separate triggers** that can change or reload the screen with zero customer interaction. Any one of them is enough to feel like a glitch when you're sitting at the table.

| # | Trigger | What customer sees | Where it lives |
|---|---|---|---|
| 1 | Idle scroll-to-top | Menu silently jumps to top, section pill clears, toggle flips to "Bakery" | `public/standalone.html` ~L7690–7733 |
| 2 | Service-Worker auto-reload | Full page reload (white flash) after a new deploy | `public/standalone.html` ~L8425–8448 |
| 3 | Error-triggered reload | Full page reload 5s after any JS error | `public/standalone.html` ~L8598–8629 |
| 4 | Daily 09:00 refresh | Full page reload between 09:00–09:05 | `public/standalone.html` ~L8631–8642 |

OptiSigns already handles the "table has been empty for a while" case by switching away from the menu, so the kiosk itself does **not** need to aggressively reset between sessions.

## Goal

No customer at the table should ever see the menu move, reload, or change unless they touched it. The only auto-behaviors that remain should fire when the kiosk is provably unattended (long idle window) or outside service hours.

## Changes

### Step 1 — Lengthen the idle reset to ~5 minutes, make it gentle
File: `public/standalone.html` (`IDLE_MS` and `resetToTop`)

- Set `IDLE_MS` to **300 000 ms (5 minutes)** of true inactivity (no scroll, no touch, no mousedown).
- Switch `window.scrollTo({top:0, behavior:"instant"})` to `behavior:"smooth"`.
- Skip the reset entirely if the page is **already** near the top (e.g. `scrollY < 200`) — nothing to tidy.
- Skip the reset if a lightbox is open.

Outcome: a real customer can pause for several minutes mid-conversation and the menu will still be where they left it. Reset only fires in true unattended state.

### Step 2 — Gate the Service-Worker auto-reload behind a long idle window
File: `public/standalone.html` (`tryActivate` + `controllerchange` handler)

- Require **idle ≥ 5 minutes** (currently 30 s) before activating a waiting SW.
- Also require: page open for ≥ 10 minutes since last load, and no lightbox open.
- Keep the existing 2-reloads-per-hour throttle as a final safety net.

Outcome: a new menu version still rolls out, but only during a quiet window — never mid-session.

### Step 3 — Tighten the error-triggered reload
File: `public/standalone.html` (`onHardError` + `unhandledrejection` handler)

- Keep the existing "benign network/abort" filter.
- Require **two hard errors within 60 s** before scheduling a reload (one stray error is not worth a visible page reload).
- Require idle ≥ 60 s at the moment the reload would actually fire — defer otherwise.
- Keep the per-hour reload cap.

Outcome: transient glitches no longer reload the page in front of a customer.

### Step 4 — Keep the 09:00 daily refresh, narrow the window
File: `public/standalone.html` (daily refresh interval)

- Keep the once-per-day reload but move it to **08:55–09:00** (before opening) and require idle ≥ 5 min, so it can't fire over a customer who's already at the table at opening.

Outcome: the cache-refresh benefit is preserved; the customer-visible risk drops to ~zero.

### Step 5 — Update the visibilitychange handler so it doesn't yank the view
File: `public/standalone.html` (`visibilitychange` listener)

- On return-to-foreground: still release the scroll lock and still close a lightbox if one is somehow still open (safety).
- **Stop** force-resetting scroll to top on every foreground return — only reset if idle ≥ 5 min, matching Step 1.

Outcome: the OptiSigns playlist cycling back to the menu won't visibly jump the page if a customer is mid-scroll.

### Step 6 — Document & QC
Update `.lovable/plan.md` with the new thresholds and add a short QC list:
- Scroll halfway, wait 2 min → page stays put.
- Scroll halfway, wait 5+ min → smooth scroll to top.
- Force a JS error once → no reload. Force two within 60 s while idle → reload.
- Deploy a new SW → reload only after 5 min idle.

## Customer-Perspective Summary

| Symptom | Before | After |
|---|---|---|
| Menu jumps to top mid-conversation | Possible (short idle) | Only after 5 min of true inactivity, and smoothly |
| White-flash reload after a deploy | Possible after 30 s idle | Only after 5 min idle + page open ≥ 10 min |
| Reload after a one-off glitch | Possible after 5 s | Requires 2 errors in 60 s + idle |
| Lightbox/scroll snap-back on foreground | Every time the tab returns | Only after 5 min idle |
| 09:00 daily refresh | Customer-visible if early arrival | Moved to pre-open window |
| Menu/price correctness | Correct | Correct (unchanged) |

No customer-facing downside. The only trade-off is internal: new menu versions may take a little longer to appear on a busy kiosk, which is exactly the trade you asked for.

## Technical notes (for reference)

- All edits are confined to `public/standalone.html` and a doc update in `.lovable/plan.md`.
- `public/sw.js` does not need a version bump for this change — no cached assets change.
- Existing reload-throttle (`illyReloads` in `localStorage`) is preserved as the final safety net.

## Status: implemented

- Step 1: `IDLE_MS` raised to 300000 ms (5 min); smooth scroll; skip if already near top or lightbox open; `window.__illyLastActivity` exposed for cross-module idle checks.
- Step 2: SW activation now requires page open ≥ 10 min AND idle ≥ 5 min AND no lightbox.
- Step 3: Hard-error reload requires 2 errors within 60 s, then waits for idle ≥ 60 s with a 5-min give-up window.
- Step 4: Daily refresh moved to 08:55–09:00 (pre-open) and gated on idle ≥ 5 min.
- Step 5: `visibilitychange` no longer force-scrolls to top — only resets if idle ≥ 5 min. Lightbox-close + scroll-lock release retained.
