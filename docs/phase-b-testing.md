# Phase B testing handoff

This document is a handoff checklist for verifying Phase B (auth + ownership +
sharing). It's structured as:

1. What's already been verified and signed off
2. What still needs to be tested (with concrete steps)
3. What work remains after testing is complete

Test against the hosted dev instance: <https://graphtask.dev.wafer.works>
(unless the developer points you somewhere else).

You'll need:
- A Clerk-authed account on the dev instance. Sign-in is email-OTP.
- A second email address (for the optional full claim test in T5c step 5).
- An incognito / private browser window (or a different browser) for
  the anonymous-viewer scenarios.

When a step says "hard reload" use Cmd-Shift-R / Ctrl-Shift-R — Express
isn't sending cache headers, so a plain reload can serve stale `app.js`.

---

## ✅ Already verified

These have been confirmed end-to-end by the lead. Don't re-test unless you
have time to spare — just skim the descriptions so you understand the
surface area.

### T5a — Sign-in chrome + Clerk JS bootstrap

- "Sign in" button at sidebar bottom-left
- Click → Clerk modal → email OTP → user pill replaces button
- Sign-out icon → reverts to "Sign in"

### T5d — Agent tokens (mint / use / revoke / 401)

- Key icon on user pill → modal
- Generate token with a label → plaintext shown once → copy
- Token works in `curl -H "Authorization: Bearer $TOKEN" ...`
- Trash icon → type label → red Revoke pill → revoke
- Re-curl returns `401 invalid or revoked agent token`

### T5f — Identity in presence

- Signed-in: top-right avatar shows your Clerk display name (not "Tapir JJ")
- Click your own avatar → rename modal → per-graph rename overrides Clerk
  identity and persists across reloads / sign-out
- Sign out → avatars revert to animal names on graphs without explicit
  rename

---

## 🟡 Still needs testing

### T5c — Access controls (Restricted / view / edit + add-by-email)

This is the biggest remaining scenario. Run it on a graph you own.

**Setup**
- Signed in. Either pick an existing graph from "My graphs" in your
  sidebar or create a new one. Note its URL (in the address bar).

**1. Default mode is "Anyone with invite can view"**
- Open the graph's ⋮ menu → graph-modal opens
- Scroll to the **Access** section (between the URL row and Appearance)
- The Mode picker should read "Anyone with invite can view"
- Copy the graph URL from the URL field
- Paste it into an **incognito window**
- Expected: the graph loads with the orange pinned banner
  **"Read-only — sign in to edit"**
- The "+ New task" affordance should NOT be available (read-only mode hides
  it)
- Drag-handles / inline editing should NOT work

**2. Switch to "Anyone with invite can edit"**
- Back in your normal tab, change the Mode picker → "Anyone with invite can edit"
- In the incognito tab, hard-reload
- Expected: banner disappears, you can create tasks and edit them
- (Tasks created here will be attributed as anonymous — animal-name avatar)

**3. Switch to "Invited members only"**
- Back in your normal tab, change the Mode picker → "Invited members only"
- The Access section should now show an extra block with:
  - An email input + role picker + "Add" button
  - A list area (says "Just you so far." if empty)
- In the incognito tab, hard-reload
- Expected: 403 / "forbidden" response. The SPA may show this as a blank
  page, an error, or auto-redirect — note exactly what you see.

**4. Add a pending invite (no second email required)**
- In your normal tab's Access section, type a unique email like
  `test-pending@example.com` into the email field, pick Editor role,
  click Add
- Expected: a row appears in the members list with that email in **italic**,
  with "Pending sign-in" as the sub-text, Editor as the role, and an ×
  cancel button on the right
- Click the × → in-app confirm modal asks "Cancel this invite?"
- Confirm → row disappears

**5. Optional — full claim test (requires a second email)**
- In your normal tab, add your second email as pending, role Editor
- In the incognito tab, click the "Sign in" button at bottom-left of the sidebar
- Complete the Clerk OTP flow with your second email
- After sign-in, hard-reload
- Expected: the graph appears in the incognito tab's sidebar under
  **"Shared with me"**
- The pending row should now be a real member (not italic anymore — should
  show the Clerk display name + role + × kick button)
- Back in your normal tab, click the × to kick → confirm → in the incognito
  tab, hard-reload → you should lose access (403)

**6. Legacy graph behavior**
- Legacy graphs (those created BEFORE Phase B, with no owner) should NOT
  show the Access section at all in their graph-modal — they're URL-bearer
  by design
- This is hard to test without a legacy graph on hand; skip unless the lead
  points you at one specifically

**Known sharp edge**: the 403 page in step 3 may be a generic
  blank/unstyled response — that's known and will be polished later. The
  important part is that the access is denied.

### T5b — Sidebar buckets + anon → authed claim

**1. Signed-in bucketing**
- Signed in, look at your sidebar
- Graphs you own should be under **My graphs**
- Graphs someone else added you to should be under **Shared with me**
- (If you don't have any "Shared with me" graphs, you can skip the verify
  here, OR complete T5c step 5 first which gives you one)
- Within each section, most recently visited graph should be at the top

**2. Sign-out → bucket from localStorage**
- Sign out
- Sidebar should still show your previously visited graphs (cached in
  localStorage)
- Graphs YOU created locally should be under **My graphs**
- Graphs you visited via someone else's link should be under
  **Shared with me**

**3. Create-as-anon, then sign in (auto-claim)**
- While signed out, click "New Graph" in the sidebar → name it something
  obvious like `anon-claim-test`
- Expected: it appears under **My graphs** (locally bucketed)
- Now sign back in via the bottom-left "Sign in" button
- After sign-in completes, hard-reload
- Expected: `anon-claim-test` is STILL under **My graphs** — but now it's
  server-owned by you (you can verify this by opening its ⋮ → the Access
  section should now appear, which only shows on owned graphs)

### T7 — Deployment-mode verification

Mostly happens against the hosted dev instance you've been using
(`AUTH_PROVIDER=clerk` with dev keys). Three modes the plan asked for:

| Mode | What | How to test |
|---|---|---|
| Local, no auth (`AUTH_PROVIDER=none`) | Should be pixel-identical to pre-Phase-B | Requires a developer to spin up a local instance with `AUTH_PROVIDER=none` in `.env`, restart server, hit `127.0.0.1:3000`. Confirm: no sign-in button, no agent tokens key icon, no Access section in any graph-modal. |
| Hosted, Clerk dev | The current `graphtask.dev.wafer.works` setup | Covered by everything in T5a-T5f above. |
| Hosted, Clerk prod | Same as Clerk dev but against `pk_live_*` keys | Only relevant when the team flips to prod keys. Not testable yet. |

Mark T7 done once T5a-T5f are all signed off + the local AUTH_PROVIDER=none
spot-check is done by a developer.

---

## 📝 What's left after testing

These are dev tasks owned by the lead, not the tester:

### T6 — Docs + deploy notes

- Update `README.md` with auth-on / auth-off setup instructions
- Write `docs/auth.md` with the access matrix (`canRead` / `canEdit` /
  `canManage`), the add-by-email pending flow, agent token flow,
  threat model summary
- Cross-link from `.env.example` to the new docs
- Add a Clerk setup walkthrough (key generation, dashboard config)

### Final canvas housekeeping

Currently tasks `T5a`, `T5b`, `T5c`, `T5d`, `T5f` are in `review` on the
phase-b graphtask graph. Each should be marked **done** by the lead after
the relevant tests above pass.

### Polish punchlist (deferred, not blocking)

These came up during development but were intentionally left for later:

- 403 page styling for "you don't have access to this graph"
- Sidebar privacy indicator (lock icon keyed on `anon_role`) — was dropped
  during the refactor
- Drop the dead `invite_tokens` table (now unused) in a future schema cleanup
- Cookie-cleanup migration for old `gt_invite_*` cookies in user browsers
  (harmless, will expire on their own)
- A "Claim this graph" button for users who didn't create the graph locally
  but want to claim a legacy graph they have the URL for
- Sidebar `created` flag for owned-by-me-but-anon-created graphs after sign-in
  edge case

---

## Where to leave feedback

When you finish a section, ping the lead with:
- A ✓ for each numbered step that passed
- For anything that failed: the exact step number, what you saw vs. what
  was expected, and a screenshot if it's a UI issue

If something is BLOCKING (e.g., a section completely doesn't work), stop
and ping immediately — don't try to work around it.
