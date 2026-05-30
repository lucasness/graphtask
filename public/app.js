let cy;
let editingTaskId = null;
let richEditor = null;

// --- Per-graph identity (presence + writer headers) ---
// Each graph gets its own {id, name} stored in localStorage. The id is a
// random uuid; the name starts as a random animal and is user-renameable.
// Sent on every write so the server can attribute conflicts (see
// src/writerType.js) AND surface live presence (see src/presence.js).
const IDENTITY_KEY_PREFIX = 'graphtask:identity:';
const PRESENCE_ANIMALS = [
  'Otter', 'Heron', 'Fox', 'Bison', 'Lynx', 'Owl', 'Quokka', 'Hare',
  'Falcon', 'Newt', 'Badger', 'Pangolin', 'Salamander', 'Tapir', 'Wren',
  'Marten', 'Capybara', 'Civet', 'Dormouse', 'Caracal', 'Mongoose',
];
const PRESENCE_ADJECTIVES = [
  'Quiet', 'Bright', 'Swift', 'Clever', 'Bold', 'Gentle', 'Brave', 'Wise',
  'Calm', 'Eager', 'Sharp', 'Nimble', 'Steady', 'Hopeful', 'Witty', 'Vivid',
  'Daring', 'Curious', 'Lively', 'Mellow', 'Kind', 'Keen',
];
function randomAnimalName() {
  // Two-word default: "<Adjective> <Animal>". Pairing yields distinguishable
  // initials (e.g. "QO" for Quiet Otter) and a friendlier read than a bare
  // animal name. initialsFromName() already takes the first letter of the
  // first and last word, so this just works downstream.
  const adj = PRESENCE_ADJECTIVES[Math.floor(Math.random() * PRESENCE_ADJECTIVES.length)];
  const animal = PRESENCE_ANIMALS[Math.floor(Math.random() * PRESENCE_ANIMALS.length)];
  return `${adj} ${animal}`;
}
function newWriterId() {
  try { return crypto.randomUUID(); } catch {}
  return 'w-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function getOrCreateIdentity(gid) {
  if (!gid) return null;
  const key = IDENTITY_KEY_PREFIX + gid;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string') {
        return parsed;
      }
    }
  } catch {}
  // Fresh identity defaults to `chosen: false` — i.e. the random animal name
  // is a fallback, not a deliberate user choice. The rename modal flips this
  // flag so a per-graph rename always wins over Clerk's display name.
  const fresh = { id: newWriterId(), name: randomAnimalName(), chosen: false };
  try { localStorage.setItem(key, JSON.stringify(fresh)); } catch {}
  return fresh;
}
function setIdentityName(gid, name) {
  const trimmed = (name || '').trim().slice(0, 64);
  if (!trimmed) return null;
  const existing = getOrCreateIdentity(gid);
  if (!existing) return null;
  // chosen: true means "user explicitly set this name on this graph" — gets
  // priority over the signed-in Clerk identity in effectiveIdentity below.
  const updated = { ...existing, name: trimmed, chosen: true };
  try { localStorage.setItem(IDENTITY_KEY_PREFIX + gid, JSON.stringify(updated)); } catch {}
  return updated;
}
// effectiveIdentity layers Clerk on top of the stored per-graph identity:
//   per-graph rename (chosen: true) > Clerk display name > stored animal.
// The writer `id` always comes from storage so presence stays stable across
// sign-in / sign-out — only the display name changes.
function effectiveIdentity(gid) {
  const stored = getOrCreateIdentity(gid);
  if (!stored) return null;
  if (stored.chosen) return stored;
  if (window.gtUser) {
    return {
      id: stored.id,
      name: window.gtUser.displayName || window.gtUser.email || stored.name,
      chosen: false,
    };
  }
  return stored;
}
// 64-color palette: 16 well-spaced hues × 4 lightness/saturation variants.
// Pure `hue % 360` hashing produced near-identical hues for unrelated ids
// (e.g. two writers landing 16° apart on the wheel both look "green") which
// surfaced the moment multi-peer presence highlights shipped. Discrete
// buckets give wider perceptual spacing for the realistic peer-count range.
//
// Determinism is preserved: same id → same color across reloads/devices/
// incognito. Past 64 ids the birthday paradox kicks back in (~50% collision
// at 10 peers, ~5% at 4) but the colliding pairs stay perceptually distant
// rather than landing in the same hue band, and the cursor name pill carries
// the disambiguation load.
const PEER_COLOR_HUES = [
  11, 34, 56, 79, 101, 124, 146, 169,
  191, 214, 236, 259, 281, 304, 326, 349,
];
const PEER_COLOR_VARIANTS = [
  { s: 70, l: 58 },   // base — vivid (the historical params)
  { s: 60, l: 72 },   // lighter pastel
  { s: 80, l: 44 },   // deep saturated
  { s: 45, l: 55 },   // muted
];
function colorForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  // Murmur3 finalizer — without it, the polynomial hash leaks structure
  // into the low bits and `% 64` clusters (e.g. two real writer_ids
  // landing in the same bucket because their trailing chars line up).
  // The finalizer's avalanche guarantee gives healthy mod-N distribution
  // even for small N, so the 64-bucket palette stays well-spread.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  h = h >>> 0;  // bitops yield int32; coerce back to uint32 before mod
  const bucket = h % (PEER_COLOR_HUES.length * PEER_COLOR_VARIANTS.length);
  const hue = PEER_COLOR_HUES[bucket % PEER_COLOR_HUES.length];
  const v = PEER_COLOR_VARIANTS[Math.floor(bucket / PEER_COLOR_HUES.length)];
  return `hsl(${hue}, ${v.s}%, ${v.l}%)`;
}
function initialsFromName(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- Auth bootstrap (Phase B) -----------------------------------------------
//
// On boot we GET /api/config. If `auth_enabled` is false (AUTH_PROVIDER=none)
// nothing in the sidebar changes — Phase A behavior preserved. If true, we
// dynamic-load @clerk/clerk-js, init with the publishable key, render
// sign-in chrome at the bottom of the sidebar, and publish auth state via
// `window.gtUser` + a `gtuserchange` event for other slices to consume.
const gtAuth = {
  enabled: false,
  provider: null,
  publishableKey: null,
  clerk: null,
  user: null,
  ready: false,
};
window.gtUser = null;

async function bootAuth() {
  let cfg;
  try {
    cfg = await fetch('/api/config').then((r) => r.json());
  } catch (err) {
    console.error('failed to load /api/config:', err);
    gtAuth.ready = true;
    return;
  }
  gtAuth.enabled = !!cfg.auth_enabled;
  gtAuth.provider = cfg.provider || 'none';
  gtAuth.publishableKey = cfg.publishable_key || null;

  if (!gtAuth.enabled || !gtAuth.publishableKey) {
    gtAuth.ready = true;
    return;
  }

  try {
    // Clerk's browser SDK auto-initializes from a `data-clerk-publishable-key`
    // attribute on its own script tag and exposes the resulting instance as
    // `window.Clerk` once loaded. We don't construct it ourselves — calling
    // `new Clerk(...)` on the already-initialized instance throws.
    await loadClerkScript();
    gtAuth.clerk = window.Clerk;
    if (!gtAuth.clerk.loaded) {
      await gtAuth.clerk.load();
    }
    syncUserFromClerk();
    gtAuth.clerk.addListener(syncUserFromClerk);
  } catch (err) {
    console.error('Clerk init failed — auth chrome disabled:', err);
  }
  gtAuth.ready = true;
  renderAuthChrome();
}

function loadClerkScript() {
  return new Promise((resolve, reject) => {
    // Clerk's CDN path is the per-instance hostname embedded in the
    // publishable key (e.g. `discrete-mouse-59.clerk.accounts.dev`). Per
    // Clerk's docs, the loader bootstraps itself from a
    // `data-clerk-publishable-key` attribute on its own script tag and
    // assigns the resulting instance to `window.Clerk` once everything is
    // wired. We mirror that recommended pattern exactly.
    const host = decodeFrontendHost(gtAuth.publishableKey);
    const src = host
      ? `https://${host}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`
      : 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.setAttribute('data-clerk-publishable-key', gtAuth.publishableKey);
    s.onload = () => waitForClerkGlobal().then(resolve).catch(reject);
    s.onerror = () => reject(new Error(`failed to load Clerk JS from ${src}`));
    document.head.appendChild(s);
  });
}

function waitForClerkGlobal(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      // After auto-init, `window.Clerk` is the instance — has methods like
      // `openSignIn`, `signOut`, `addListener`. Wait for one of those to
      // exist before declaring ready.
      if (window.Clerk && typeof window.Clerk.addListener === 'function') {
        return resolve();
      }
      if (Date.now() > deadline) {
        return reject(new Error('Clerk JS loaded but window.Clerk never appeared'));
      }
      setTimeout(poll, 50);
    })();
  });
}

// pk_test_<base64>$  — the base64 chunk encodes "<host>$" where host is the
// frontend API hostname. We decode it once at boot to pick the per-instance
// CDN path. Failure falls back to the generic CDN.
function decodeFrontendHost(pk) {
  try {
    const b64 = pk.replace(/^pk_(test|live)_/, '');
    const decoded = atob(b64);
    const host = decoded.replace(/\$$/, '').trim();
    return /^[a-z0-9.-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function syncUserFromClerk() {
  const u = gtAuth.clerk?.user;
  if (u) {
    gtAuth.user = {
      // Clerk's user_xxx id — used only for display + chrome. The internal
      // users.id UUID needed for matching graph.owner_user_id is fetched
      // separately via /api/config in refreshViewerUserId().
      providerUserId: u.id,
      id: gtAuth.viewerUserId || null,
      email: u.primaryEmailAddress?.emailAddress ?? null,
      displayName: u.fullName || u.username || u.primaryEmailAddress?.emailAddress || null,
    };
  } else {
    gtAuth.user = null;
    gtAuth.viewerUserId = null;
  }
  window.gtUser = gtAuth.user;
  window.dispatchEvent(new CustomEvent('gtuserchange', { detail: gtAuth.user }));
  renderAuthChrome();
}

// Re-fetch /api/config with the Clerk session attached so the server resolves
// `req.user` and returns our internal `viewer_user_id`. Called after every
// sign-in (gtuserchange) so the sidebar can partition by owner correctly.
async function refreshViewerUserId() {
  try {
    const res = await authedFetch('/api/config');
    if (!res.ok) return;
    const cfg = await res.json();
    gtAuth.viewerUserId = cfg.viewer_user_id || null;
    if (gtAuth.user) {
      gtAuth.user = { ...gtAuth.user, id: gtAuth.viewerUserId };
      window.gtUser = gtAuth.user;
    }
  } catch (err) {
    console.error('refreshViewerUserId failed', err);
  }
}

// Toggle read-only mode based on the active graph's `viewer_can_edit` flag
// (set by GET /api/graphs/:id on the server using canEdit). Body class
// `readonly` drives the CSS that hides edit affordances; the banner offers
// a sign-in shortcut when auth is enabled and the viewer is anonymous.
// Per-tab, per-graph: once the user clicks "Dismiss" on the read-only
// banner, suppress it for that gid until the tab closes. Hard reloads
// keep the dismissal (sessionStorage); a fresh tab brings the banner back.
function readonlyBannerDismissKey(gid) {
  return `graphtask:readonly-banner-dismissed:${gid}`;
}
function isReadOnlyBannerDismissed(gid) {
  if (!gid) return false;
  try { return sessionStorage.getItem(readonlyBannerDismissKey(gid)) === '1'; }
  catch { return false; }
}
function setReadOnlyBannerDismissed(gid) {
  if (!gid) return;
  try { sessionStorage.setItem(readonlyBannerDismissKey(gid), '1'); } catch {}
}

function applyReadOnlyState() {
  const banner = document.getElementById('readonly-banner');
  const signinBtn = document.getElementById('readonly-signin-btn');
  const canEdit = !accessDenied && currentGraph?.viewer_can_edit !== false; // null/undefined → allow (back-compat)
  document.body.classList.toggle('forbidden', accessDenied);
  document.body.classList.toggle('readonly', !accessDenied && !canEdit);
  const dismissed = isReadOnlyBannerDismissed(activeGraphId);
  if (banner) banner.classList.toggle('hidden', accessDenied || canEdit || dismissed);
  if (signinBtn) {
    // Only show "Sign in to edit" when auth is on AND the user isn't already
    // signed in. If they're signed in and can't edit, the answer isn't
    // signing in again.
    const wantSignIn = gtAuth.enabled && !gtAuth.user;
    signinBtn.classList.toggle('hidden', !wantSignIn);
  }
  // Disable node grabbing in read-only / forbidden mode — turns the canvas
  // into a true viewer instead of one that drags freely then fails on save.
  if (typeof cy !== 'undefined' && cy) {
    cy.autoungrabify(!canEdit);
  }
}

// Wire the sign-in + dismiss buttons in the read-only banner exactly once.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('readonly-signin-btn')?.addEventListener('click', () => {
    gtAuth.clerk?.openSignIn();
  });
  document.getElementById('readonly-dismiss-btn')?.addEventListener('click', () => {
    setReadOnlyBannerDismissed(activeGraphId);
    document.getElementById('readonly-banner')?.classList.add('hidden');
  });
  // Click outside the color palette closes it (same behaviour as Esc + X).
  // Capture phase + ignoring clicks that landed inside the palette OR on the
  // trigger button that just opened it (synthetic order of click events).
  document.addEventListener('mousedown', (e) => {
    const palette = document.getElementById('color-palette');
    if (!palette || palette.classList.contains('hidden')) return;
    if (palette.contains(e.target)) return;
    closeColorPalette();
  });
});

// When the Clerk session changes (sign-in or sign-out), re-announce presence
// on the active graph so collaborators see the new display name immediately,
// and re-render our own avatar bar. The stored writer id stays the same —
// presence rows keyed on it just get their `name` field updated.
window.addEventListener('gtuserchange', async () => {
  // Pull the internal viewer_user_id first so the sidebar partition can
  // match graph.owner_user_id correctly.
  await refreshViewerUserId();
  if (typeof activeGraphId !== 'undefined' && activeGraphId) {
    presenceAnnounce(activeGraphId);
    renderPresenceBar();
  }
  applyReadOnlyState();
  // Reconcile locally-created graphs (created while anon, marked
  // `created: true` in recents) with server ownership. Best-effort: each
  // claim is independent. Errors silently skip the entry.
  if (window.gtUser) {
    await claimLocalCreatedGraphs();
  }
  try { await fetchGraphsList(); } catch (err) { console.error('refresh after auth change', err); }
});

// Walk localStorage recents and POST /api/graphs/:id/claim for every entry
// the user locally marked as created. Server enforces "legacy only" — owned
// graphs return 403 and we move on. Once successful, the graph appears in
// the sidebar under "My graphs" on the next fetchGraphsList.
async function claimLocalCreatedGraphs() {
  const candidates = recentsRead().filter((r) => r.created === true);
  for (const r of candidates) {
    try {
      await authedFetch(`/api/graphs/${encodeURIComponent(r.id)}/claim`, { method: 'POST' });
      // Don't care about the response shape: success, already-owner, or 403
      // (someone else claimed it first). All resolved by the next list fetch.
    } catch (err) {
      // Network/transient — skip; the next sign-in will retry.
    }
  }
}

// Generic in-app confirm. Replaces window.confirm() so prompts match the
// rest of the app's modal styling instead of the browser's chrome.
// Returns Promise<boolean> — resolves true on OK, false on Cancel/Escape/backdrop.
function showConfirm({ title = 'Confirm', body = '', okText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('app-confirm-modal');
    const titleEl = document.getElementById('app-confirm-title');
    const bodyEl = document.getElementById('app-confirm-body');
    const okBtn = document.getElementById('app-confirm-ok');
    const cancelBtn = document.getElementById('app-confirm-cancel');
    if (!modal) {
      // Defensive fallback if the modal HTML didn't load — fall back to the
      // native confirm rather than silently failing.
      return resolve(window.confirm(body || title));
    }
    titleEl.textContent = title;
    bodyEl.textContent = body;
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    okBtn.classList.toggle('danger', danger);
    okBtn.classList.toggle('primary', !danger);
    modal.classList.remove('hidden');

    function cleanup(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === modal) cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    // Give the OK button focus so Enter/Esc work immediately without forcing
    // the user to tab in. Done in a microtask so the modal is paint-visible.
    setTimeout(() => okBtn.focus(), 0);
  });
}

// Authed fetch: same shape as global fetch, but attaches the Clerk session
// JWT as a Bearer header when one is available. Use this for any `/api/*`
// call from the browser that needs to be attributed to the signed-in user.
// For now we call it from the agent-tokens UI (B5d) — later slices route
// through here too. On auth-off deployments it's a passthrough.
async function authedFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (gtAuth.clerk?.session) {
    try {
      const token = await gtAuth.clerk.session.getToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    } catch (err) {
      console.error('failed to fetch Clerk session token', err);
    }
  }
  return fetch(url, { ...init, headers, credentials: 'same-origin' });
}

function renderAuthChrome() {
  const host = document.getElementById('sidebar-auth');
  if (!host) return;
  if (!gtAuth.enabled) {
    host.innerHTML = '';
    return;
  }
  // Toggle the separate Settings button: signed-in users use the combined
  // account-and-settings row, so the lower Settings button is redundant
  // and gets hidden.
  const appSettingsBtn = document.getElementById('app-settings-btn');
  if (appSettingsBtn) appSettingsBtn.classList.toggle('hidden', !!gtAuth.user);

  if (gtAuth.user) {
    const name = gtAuth.user.displayName || gtAuth.user.email || 'You';
    host.innerHTML = `
      <button type="button" class="sb-account-row" id="sb-account-row" title="${escapeHtml(gtAuth.user.email || '')}">
        <i class="ph ph-gear" aria-hidden="true"></i>
        <span class="sb-user-name">${escapeHtml(name)}</span>
      </button>
    `;
    // Mount the hover popover on <body> so it isn't clipped by the sidebar's
    // overflow:hidden in collapsed mode. Positioned with JS off the row's
    // bounding rect — fixed positioning means viewport coordinates, no
    // parent-clipping.
    let pop = document.getElementById('sb-user-popover');
    if (pop) pop.remove();
    pop = document.createElement('div');
    pop.id = 'sb-user-popover';
    pop.className = 'sb-user-popover hidden';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = `<button type="button" class="sb-user-popover-btn danger" id="sb-signout-btn">Sign out</button>`;
    document.body.appendChild(pop);

    const row = document.getElementById('sb-account-row');
    let hideTimer = null;
    function positionPop() {
      const r = row.getBoundingClientRect();
      const collapsed = document.getElementById('sidebar')?.classList.contains('collapsed');
      if (collapsed) {
        // To the right of the gear, vertically centered with it. translateY
        // self-centers regardless of the popover's actual height.
        pop.style.left = `${Math.round(r.right + 8)}px`;
        pop.style.top = `${Math.round(r.top + r.height / 2)}px`;
        pop.style.transform = 'translateY(-50%)';
      } else {
        // Centered above the row. translate(-50%, -100%) anchors the
        // popover's bottom-center to the row's top-center + 8px gap.
        pop.style.left = `${Math.round(r.left + r.width / 2)}px`;
        pop.style.top = `${Math.round(r.top - 8)}px`;
        pop.style.transform = 'translate(-50%, -100%)';
      }
    }
    function showPop() {
      positionPop();
      pop.classList.remove('hidden');
      clearTimeout(hideTimer);
    }
    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => pop.classList.add('hidden'), 200);
    }
    row.addEventListener('mouseenter', showPop);
    row.addEventListener('mouseleave', scheduleHide);
    pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    pop.addEventListener('mouseleave', scheduleHide);
    row.addEventListener('click', () => {
      pop.classList.add('hidden');
      openSettings();
    });
    document.getElementById('sb-signout-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      pop.classList.add('hidden');
      try { await gtAuth.clerk.signOut(); } catch (err) { console.error('sign out failed', err); }
    });
  } else {
    document.getElementById('sb-user-popover')?.remove();
    host.innerHTML = `
      <button type="button" class="sb-bottom-btn sb-signin-btn" id="sb-signin-btn" title="Sign in" aria-label="Sign in">
        <i class="ph ph-sign-in" aria-hidden="true"></i>
        <span class="sb-bottom-label">Sign in</span>
      </button>
    `;
    document.getElementById('sb-signin-btn')?.addEventListener('click', () => {
      gtAuth.clerk?.openSignIn();
    });
  }
}

// ---- Agent tokens panel (Phase B5d) ----------------------------------------
//
// Opens from the key-icon button on the user pill. Talks to /api/me/agent_tokens.
// The mint response is the only place the plaintext token is ever shown — kept
// visible inside the modal until the modal closes, then never re-displayed.

let agentTokensModalWired = false;
// When the agent-tokens modal is opened from the app-settings modal, set
// this so closing it (X, Esc, or backdrop) re-opens settings instead of
// dropping the user back to the canvas.
let _agentTokensReturnToSettings = false;

async function openAgentTokensModal(opts = {}) {
  if (!gtAuth.user) return;
  const modal = document.getElementById('agent-tokens-modal');
  if (!modal) return;
  _agentTokensReturnToSettings = !!opts.fromSettings;
  if (!agentTokensModalWired) wireAgentTokensModal();
  // Clear any previously-displayed plaintext from a prior mint.
  document.getElementById('agent-tokens-just-minted')?.classList.add('hidden');
  document.getElementById('agent-tokens-label').value = '';
  modal.classList.remove('hidden');
  await refreshAgentTokensList();
}

function closeAgentTokensModal() {
  const modal = document.getElementById('agent-tokens-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  // Drop focus off whatever opened us so Escape doesn't leave a
  // focus-visible outline on the trigger.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  // Clear the plaintext block on close — it should never linger after the
  // modal is dismissed.
  document.getElementById('agent-tokens-plaintext').value = '';
  document.getElementById('agent-tokens-just-minted')?.classList.add('hidden');
  // Collapse any open per-row confirm expansion + tear down the
  // outside-click listener so it doesn't leak across modal opens.
  document
    .querySelectorAll('#agent-tokens-list .agent-token-row')
    .forEach((row) => {
      const trash = row.querySelector('.agent-token-trash');
      if (trash?.dataset.state === 'confirming') cancelRowRevoke(row);
    });
  if (_agentTokensReturnToSettings) {
    _agentTokensReturnToSettings = false;
    openSettings();
  }
}

function wireAgentTokensModal() {
  agentTokensModalWired = true;
  // Backdrop click (target is the .modal element itself, not a child) closes the modal.
  document.getElementById('agent-tokens-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'agent-tokens-modal') closeAgentTokensModal();
  });
  // Esc handler — capture phase so we beat any other listener that might
  // also bind Esc on the body.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('agent-tokens-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    e.stopPropagation();
    closeAgentTokensModal();
  }, true);
  document.getElementById('agent-tokens-mint')?.addEventListener('click', mintAgentToken);
  document.getElementById('agent-tokens-copy')?.addEventListener('click', () => {
    const input = document.getElementById('agent-tokens-plaintext');
    if (!input) return;
    input.select();
    try { navigator.clipboard.writeText(input.value); } catch {}
  });
  // Allow Enter in the label field to submit a mint.
  document.getElementById('agent-tokens-label')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); mintAgentToken(); }
  });
}

async function refreshAgentTokensList() {
  const listEl = document.getElementById('agent-tokens-list');
  if (!listEl) return;
  try {
    const res = await authedFetch('/api/me/agent_tokens');
    if (!res.ok) throw new Error(`status ${res.status}`);
    const tokens = await res.json();
    // The API returns the full audit trail (active + revoked) so a future
    // "history" toggle can surface revoked tokens. The active panel shows
    // only unrevoked ones to keep the list clean.
    const active = Array.isArray(tokens) ? tokens.filter((t) => !t.revoked_at) : [];
    if (active.length === 0) {
      // No tokens → drop the bordered list framing entirely; just show a
      // muted "No tokens" hint under the eyebrow label.
      listEl.classList.add('is-empty');
      listEl.innerHTML = '<p class="agent-tokens-empty-hint">No tokens</p>';
      return;
    }
    listEl.classList.remove('is-empty');
    listEl.innerHTML = active.map((t) => renderTokenRow(t)).join('');
    wireTokenRowEvents(listEl);
  } catch (err) {
    console.error('failed to load agent tokens', err);
    listEl.innerHTML = '<p class="modal-hint">Failed to load tokens.</p>';
  }
}

function formatUtcStamp(iso) {
  return new Date(iso).toISOString().replace('T', ' ').replace(/\..+Z$/, ' UTC');
}

function renderTokenRow(t) {
  // Confirm phrase: the user types the token's label (or 'revoke' if there's
  // no label) to arm the destructive action. Matches GitHub's repo-delete
  // pattern — typing forces a deliberate beat between intent and effect.
  const label = t.label || '(unlabeled)';
  const expected = (t.label || 'revoke').trim();
  const usedLine = t.last_used_at
    ? `Last used ${formatUtcStamp(t.last_used_at)}`
    : 'Never used';
  const createdLine = `Created ${formatUtcStamp(t.created_at)}`;
  return `
    <div class="agent-token-row" data-token-id="${escapeHtml(t.id)}" data-expected="${escapeHtml(expected)}">
      <div class="agent-token-row-top">
        <div class="agent-token-meta">
          <div class="agent-token-label">${escapeHtml(label)}</div>
          <div class="agent-token-times">
            <div>${escapeHtml(createdLine)}</div>
            <div>${escapeHtml(usedLine)}</div>
          </div>
        </div>
        <button type="button" class="agent-token-trash" data-state="idle" title="Revoke" aria-label="Revoke">
          <i class="ph ph-trash" aria-hidden="true"></i>
        </button>
      </div>
      <div class="agent-token-confirm hidden">
        <p class="agent-token-warning">
          <i class="ph ph-warning-circle" aria-hidden="true"></i>
          Revoking will cause errors for agents using this token.
        </p>
        <div class="agent-token-confirm-row">
          <input type="text" class="agent-token-confirm-input"
                 placeholder='Type "${escapeHtml(expected)}" to confirm'
                 autocomplete="off" spellcheck="false">
          <button type="button" class="agent-token-confirm-btn danger" disabled data-state="pending">Revoke</button>
        </div>
      </div>
    </div>
  `;
}

function wireTokenRowEvents(listEl) {
  // Event-delegated handlers so we don't re-wire per row on every list refresh.
  listEl.addEventListener('click', onTokenRowClick);
  listEl.addEventListener('input', onTokenRowInput);
  listEl.addEventListener('keydown', onTokenRowKeydown);
}

function onTokenRowClick(e) {
  const row = e.target.closest('.agent-token-row');
  if (!row) return;
  const trash = e.target.closest('.agent-token-trash');
  if (trash) {
    // Trash icon toggles the confirm expansion. Idle → open. Confirming → cancel.
    if (trash.dataset.state === 'idle') startRowRevoke(row);
    else cancelRowRevoke(row);
    return;
  }
  if (e.target.closest('.agent-token-confirm-btn')) {
    const btn = e.target.closest('.agent-token-confirm-btn');
    if (btn.dataset.state === 'armed') doRowRevoke(row);
  }
}

// Cancel any open confirm expansion when the user clicks outside its row.
// Registered lazily — only attached to document while a row is confirming,
// torn down when none are.
let _tokenConfirmOutsideHandler = null;
function ensureOutsideClickHandler() {
  if (_tokenConfirmOutsideHandler) return;
  _tokenConfirmOutsideHandler = (e) => {
    const listEl = document.getElementById('agent-tokens-list');
    if (!listEl) return;
    listEl.querySelectorAll('.agent-token-row').forEach((r) => {
      const trash = r.querySelector('.agent-token-trash');
      if (trash?.dataset.state === 'confirming' && !r.contains(e.target)) {
        cancelRowRevoke(r);
      }
    });
  };
  document.addEventListener('mousedown', _tokenConfirmOutsideHandler, true);
}
function teardownOutsideClickHandlerIfIdle() {
  const stillConfirming = document.querySelector(
    '#agent-tokens-list .agent-token-trash[data-state="confirming"]',
  );
  if (!stillConfirming && _tokenConfirmOutsideHandler) {
    document.removeEventListener('mousedown', _tokenConfirmOutsideHandler, true);
    _tokenConfirmOutsideHandler = null;
  }
}

function onTokenRowInput(e) {
  if (!e.target.classList.contains('agent-token-confirm-input')) return;
  const row = e.target.closest('.agent-token-row');
  if (row) updateRowArmedState(row);
}

function onTokenRowKeydown(e) {
  if (!e.target.classList.contains('agent-token-confirm-input')) return;
  const row = e.target.closest('.agent-token-row');
  if (!row) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelRowRevoke(row);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const btn = row.querySelector('.agent-token-confirm-btn');
    if (btn?.dataset.state === 'armed') doRowRevoke(row);
  }
}

function startRowRevoke(row) {
  const trash = row.querySelector('.agent-token-trash');
  const confirmBtn = row.querySelector('.agent-token-confirm-btn');
  const confirmEl = row.querySelector('.agent-token-confirm');
  const input = row.querySelector('.agent-token-confirm-input');
  trash.dataset.state = 'confirming';
  trash.classList.add('is-confirming');
  confirmBtn.dataset.state = 'pending';
  confirmBtn.disabled = true;
  confirmEl.classList.remove('hidden');
  input.value = '';
  ensureOutsideClickHandler();
  setTimeout(() => input.focus(), 0);
}

function cancelRowRevoke(row) {
  const trash = row.querySelector('.agent-token-trash');
  const confirmEl = row.querySelector('.agent-token-confirm');
  trash.dataset.state = 'idle';
  trash.classList.remove('is-confirming');
  confirmEl.classList.add('hidden');
  row.querySelector('.agent-token-confirm-input').value = '';
  teardownOutsideClickHandlerIfIdle();
}

function updateRowArmedState(row) {
  const btn = row.querySelector('.agent-token-confirm-btn');
  const expected = row.dataset.expected;
  const typed = row.querySelector('.agent-token-confirm-input').value.trim();
  if (typed === expected) {
    btn.dataset.state = 'armed';
    btn.disabled = false;
  } else {
    btn.dataset.state = 'pending';
    btn.disabled = true;
  }
}

async function doRowRevoke(row) {
  const id = row.dataset.tokenId;
  if (!id) return;
  try {
    const res = await authedFetch(`/api/me/agent_tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
    await refreshAgentTokensList();
  } catch (err) {
    console.error('revoke failed', err);
    showHint('Failed to revoke — see console.', 'page');
  }
}

async function mintAgentToken() {
  const labelEl = document.getElementById('agent-tokens-label');
  const label = labelEl ? labelEl.value.trim() : '';
  try {
    const res = await authedFetch('/api/me/agent_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || null }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    document.getElementById('agent-tokens-plaintext').value = body.token;
    document.getElementById('agent-tokens-just-minted')?.classList.remove('hidden');
    labelEl.value = '';
    await refreshAgentTokensList();
  } catch (err) {
    console.error('mint failed', err);
    showHint('Failed to mint token — see console.', 'page');
  }
}

// Reusable picker — same trigger/menu shape as the font-picker but driven by
// `data-value` per option and a callback. Returns a teardown function that
// removes the bound listeners. Use this to replace ugly native <select>
// dropdowns inside modals.
function wirePicker(rootEl, options) {
  const trigger = rootEl.querySelector('.font-picker-trigger');
  const valueEl = rootEl.querySelector('.font-picker-value');
  const menu = rootEl.querySelector('.font-picker-menu');
  const optionEls = Array.from(menu.querySelectorAll('.font-picker-option'));
  let current = options.initial;
  const labelOf = (v) => optionEls.find((o) => o.dataset.value === v)?.textContent?.trim() || v;
  function setActive(v) {
    optionEls.forEach((o) => o.classList.toggle('active', o.dataset.value === v));
    valueEl.textContent = labelOf(v);
    current = v;
  }
  setActive(current);
  function openMenu() {
    menu.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onDocKey, true);
  }
  function closeMenu() {
    menu.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('keydown', onDocKey, true);
  }
  function onTriggerClick() {
    if (menu.classList.contains('hidden')) openMenu();
    else closeMenu();
  }
  function onDocClick(e) { if (!rootEl.contains(e.target)) closeMenu(); }
  function onDocKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }
  function onOptionClick(e) {
    const v = e.currentTarget.dataset.value;
    setActive(v);
    closeMenu();
    options.onChange?.(v);
  }
  trigger.addEventListener('click', onTriggerClick);
  optionEls.forEach((o) => o.addEventListener('click', onOptionClick));
  const teardown = () => {
    trigger.removeEventListener('click', onTriggerClick);
    optionEls.forEach((o) => o.removeEventListener('click', onOptionClick));
    closeMenu();
  };
  // Attach setValue to the teardown so callers can revert the picker UI
  // without firing onChange (e.g. when a confirm dialog is cancelled).
  // Function-as-object pattern keeps backward compat with existing callers
  // that use the return value purely as a teardown fn.
  teardown.setValue = (v) => setActive(v);
  return teardown;
}

// Wires up the inline Access section. Returns a cleanup function.
function wireAccessSection(graph) {
  const anonRolePicker = document.getElementById('graph-modal-anon-picker');
  const inviteRolePicker = document.getElementById('graph-modal-invite-role-picker');
  const membersSection = document.getElementById('graph-modal-members-section');
  const inviteEmail = document.getElementById('graph-modal-invite-email');
  const inviteSubmit = document.getElementById('graph-modal-invite-submit');
  const inviteError = document.getElementById('graph-modal-invite-error');

  let currentMode = graph.anon_role || 'viewer';
  let currentInviteRole = 'editor';

  function applyMode(mode) {
    currentMode = mode;
    // Members section is only meaningful in restricted mode — it's where you
    // grant per-person access. The other two modes broadcast access via the
    // URL so explicit per-user adds would be confusing.
    membersSection.classList.toggle('hidden', mode !== 'none');
    if (mode === 'none') {
      loadAccessMembers(graph.id);
    }
  }

  const modeTeardown = wirePicker(anonRolePicker, {
    initial: currentMode,
    onChange: async (v) => {
      // Special-case: flipping from "Invited members only" to "Anyone
      // with invite can view" leaves existing editor-members with their
      // explicit editor role on top of the more permissive anon tier.
      // Confirm so the owner doesn't think the flip downgrades them.
      if (currentMode === 'none' && v === 'viewer') {
        const ok = await showConfirm({
          title: 'Invited members can edit, continue?',
          body: 'Remove members first if you want to revoke their edit access.',
          okText: 'Continue',
          cancelText: 'Cancel',
        });
        if (!ok) {
          modeTeardown.setValue(currentMode);
          return;
        }
      }
      try {
        await setGraphAnonRole(graph.id, v);
        graph.anon_role = v;
        applyMode(v);
        showHint('Access updated', 'page');
      } catch (err) {
        console.error('anon_role change failed', err);
        showHint('Failed to update access — see console.', 'page');
        modeTeardown.setValue(currentMode);
      }
    },
  });

  const inviteRoleTeardown = wirePicker(inviteRolePicker, {
    initial: currentInviteRole,
    onChange: (v) => { currentInviteRole = v; },
  });

  inviteEmail.value = '';
  inviteError.classList.add('hidden');

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  async function submitInvite() {
    // Inline-below error pattern is gone — feedback is on the icon itself.
    inviteError.classList.add('hidden');
    const email = inviteEmail.value.trim();
    if (!email || !EMAIL_RE.test(email)) {
      flashInviteResult('error', 'No valid address');
      return;
    }
    try {
      const res = await authedFetch(
        `/api/graphs/${encodeURIComponent(graph.id)}/members`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, role: currentInviteRole }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        flashInviteResult('error', body.error || 'Request failed');
        return;
      }
      inviteEmail.value = '';
      flashInviteResult('sent');
      await loadAccessMembers(graph.id);
    } catch (err) {
      console.error('invite failed', err);
      flashInviteResult('error', 'Network error');
    }
  }
  // Visual confirmation on the icon itself:
  //   - kind='sent'  → green check-circle for ~1.1s, then restore.
  //   - kind='error' → red x-circle + a small floating message (set on a
  //     data attribute so the ::before pseudo can show it) for ~1.6s.
  // Either way: returns to the paper-plane so the user can send the next
  // invite without thinking about state.
  let _inviteFlashTimer = null;
  function flashInviteResult(kind, message) {
    const icon = inviteSubmit.querySelector('i');
    if (!icon) return;
    inviteSubmit.classList.remove('sent', 'error');
    delete inviteSubmit.dataset.flashMessage;
    if (kind === 'sent') {
      inviteSubmit.classList.add('sent');
      icon.className = 'ph ph-check-circle';
    } else {
      inviteSubmit.classList.add('error');
      icon.className = 'ph ph-x-circle';
      if (message) inviteSubmit.dataset.flashMessage = message;
    }
    clearTimeout(_inviteFlashTimer);
    _inviteFlashTimer = setTimeout(() => {
      inviteSubmit.classList.remove('sent', 'error');
      delete inviteSubmit.dataset.flashMessage;
      icon.className = 'ph ph-paper-plane-tilt';
    }, kind === 'error' ? 1600 : 1100);
  }
  function onInviteKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); submitInvite(); }
  }
  inviteSubmit.addEventListener('click', submitInvite);
  inviteEmail.addEventListener('keydown', onInviteKey);

  applyMode(currentMode);

  return () => {
    modeTeardown();
    inviteRoleTeardown();
    inviteSubmit.removeEventListener('click', submitInvite);
    inviteEmail.removeEventListener('keydown', onInviteKey);
  };
}

// ---- Access controls inside the graph-modal (Phase B5c) ---------------------
//
// One URL = the graph URL (already shown in the graph-modal). Two layers of
// access control, both inlined into the graph-modal's Access section:
//   - General access dropdown → PATCH graph.anon_role
//   - Add by email → POST /api/graphs/:gid/members (creates member or pending row)
// Owner-only; hidden entirely for legacy un-owned graphs and for non-owners.

async function setGraphAnonRole(gid, anonRole) {
  const res = await authedFetch(`/api/graphs/${encodeURIComponent(gid)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anon_role: anonRole }),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const updated = await res.json();
  if (typeof currentGraph !== 'undefined' && currentGraph?.id === gid) {
    currentGraph = { ...currentGraph, anon_role: updated.anon_role };
    if (typeof applyReadOnlyState === 'function') applyReadOnlyState();
  }
  return updated;
}

async function loadAccessMembers(gid) {
  const listEl = document.getElementById('graph-modal-members-list');
  if (!listEl) return;
  try {
    const res = await authedFetch(`/api/graphs/${encodeURIComponent(gid)}/members`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { members = [], pending = [] } = await res.json();
    const rows = [
      ...members.map(renderAccessMemberRow),
      ...pending.map(renderAccessPendingRow),
    ];
    if (rows.length === 0) {
      // Empty list — don't show a "Just you so far" placeholder; just hide
      // the list area entirely so the section reads as "nothing to manage".
      listEl.innerHTML = '';
      listEl.classList.add('hidden');
      return;
    }
    listEl.classList.remove('hidden');
    listEl.innerHTML = rows.join('');
    listEl.querySelectorAll('[data-kick-user-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const emailEl = btn.closest('.access-member-row')?.querySelector('.access-member-email');
        const email = emailEl ? emailEl.textContent.trim() : '';
        kickMember(gid, btn.dataset.kickUserId, email);
      });
    });
    listEl.querySelectorAll('[data-cancel-pending-email]').forEach((btn) => {
      btn.addEventListener('click', () => cancelPending(gid, btn.dataset.cancelPendingEmail));
    });
  } catch (err) {
    console.error('failed to load members', err);
    listEl.innerHTML = '<p class="modal-hint">Failed to load members.</p>';
  }
}

function renderAccessMemberRow(m) {
  const name = m.display_name || m.email || 'Unknown';
  const initials = initialsFromName(name);
  return `
    <div class="access-member-row">
      <span class="access-member-avatar" style="background: ${colorForId(m.user_id)};">${escapeHtml(initials)}</span>
      <span class="access-member-email" title="${escapeHtml(name)}">${escapeHtml(m.email || name)}</span>
      <span class="access-member-tag access-member-role">${escapeHtml(m.role)}</span>
      <button type="button" class="access-member-kick" data-kick-user-id="${escapeHtml(m.user_id)}" title="Remove" aria-label="Remove member"><i class="ph ph-x" aria-hidden="true"></i></button>
    </div>
  `;
}

function renderAccessPendingRow(p) {
  const initials = initialsFromName(p.email);
  return `
    <div class="access-member-row access-member-row-pending">
      <span class="access-member-avatar" style="background: ${colorForId(p.email)};">${escapeHtml(initials)}</span>
      <span class="access-member-email">${escapeHtml(p.email)}</span>
      <span class="access-member-tag access-member-tag-pending" title="Pending sign-in">Pending</span>
      <span class="access-member-tag access-member-role">${escapeHtml(p.role)}</span>
      <button type="button" class="access-member-kick" data-cancel-pending-email="${escapeHtml(p.email)}" title="Cancel invite" aria-label="Cancel invite"><i class="ph ph-x" aria-hidden="true"></i></button>
    </div>
  `;
}

async function kickMember(gid, userId, email) {
  if (!gid || !userId) return;
  const ok = await showConfirm({
    title: 'Revoke access',
    body: email
      ? `${email} will no longer have access.`
      : 'This member will no longer have access.',
    okText: 'Revoke',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await authedFetch(
      `/api/graphs/${encodeURIComponent(gid)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
    await loadAccessMembers(gid);
  } catch (err) {
    console.error('kick failed', err);
    showHint('Failed to remove member — see console.', 'page');
  }
}

async function cancelPending(gid, email) {
  if (!gid || !email) return;
  const ok = await showConfirm({
    title: 'Revoke access',
    body: `${email} will no longer have access.`,
    okText: 'Revoke',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await authedFetch(
      `/api/graphs/${encodeURIComponent(gid)}/members/pending/${encodeURIComponent(email)}`,
      { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
    await loadAccessMembers(gid);
  } catch (err) {
    console.error('cancel pending failed', err);
    showHint('Failed to cancel invite — see console.', 'page');
  }
}

function writeHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'X-Writer-Type': 'human',
  };
  const id = (typeof activeGraphId === 'string' || typeof activeGraphId === 'number') ? activeGraphId : null;
  if (id) {
    const identity = effectiveIdentity(id);
    if (identity) {
      h['X-Writer-Id'] = identity.id;
      h['X-Writer-Name'] = identity.name;
    }
  }
  return h;
}

// --- Active graph (multi-graph support) ---
let activeGraphId = null;
// The full row for the active graph (name, description, is_public, settings,
// timestamps). Populated by switchActiveGraph; null when no graph is active.
// Used by getEffectiveSettings to compute per-graph overrides.
let currentGraph = null;
// Set when the active graph's `/graph` fetch returns 403 — drives the
// access-denied empty state and locks edit affordances. Reset on every
// graph switch and on successful fetchGraph.
let accessDenied = false;
// While accessDenied is true the EventSource is also being rejected by the
// server's read gate, so there's no live channel for the owner's "I just
// re-granted you access" event to arrive on. Poll every 10s as a safety
// net — fetchGraph clears the flag the moment access flips back. The poll
// is cheap (one GET per viewer per 10s) and stops itself.
let _accessDeniedPollTimer = null;
function startAccessDeniedPoll() {
  if (_accessDeniedPollTimer) return;
  _accessDeniedPollTimer = setInterval(() => {
    if (!accessDenied || activeGraphId == null) {
      stopAccessDeniedPoll();
      return;
    }
    fetchGraph().catch(() => {});
  }, 10000);
}
function stopAccessDeniedPoll() {
  if (_accessDeniedPollTimer) {
    clearInterval(_accessDeniedPollTimer);
    _accessDeniedPollTimer = null;
  }
}
// Read-only mode mirror — viewer has read but not edit/manage. Used to
// gate edit-path event handlers so they early-out instead of producing
// "Save failed" toasts on every interaction.
function isReadOnly() {
  return !accessDenied && currentGraph?.viewer_can_edit === false;
}

// Reactive fallback: if any write returns 403 on the active graph (e.g.
// SSE is wedged and the kick frame never landed), re-probe the graph so
// fetchGraph's 403 branch downgrades us into the access-denied state.
function maybeForbid(res) {
  if (res && res.status === 403 && activeGraphId != null && !accessDenied) {
    fetchGraph().catch(() => {});
    return true;
  }
  return false;
}
const ACTIVE_GRAPH_STORAGE_KEY = 'graphtask:lastGraphId';
const RECENT_GRAPHS_STORAGE_KEY = 'graphtask:recent';
const RECENTS_CAP = 20;
const PRIVATE_WARN_SUPPRESS_KEY = 'graphtask:hide-private-warn';
const SIDEBAR_COLLAPSED_KEY = 'graphtask:sidebarCollapsed';
const VIEW_KEY_PREFIX = 'graphtask:view:';
// Per-user, per-graph view preference. Values: 'graph' (default) | 'kanban'.
// Client-only — never synced via SSE — so two collaborators on the same
// graph can pick different views independently.
function getViewPref(gid) {
  if (!gid) return 'graph';
  try {
    const v = localStorage.getItem(VIEW_KEY_PREFIX + gid);
    return v === 'kanban' ? 'kanban' : 'graph';
  } catch { return 'graph'; }
}
function setViewPref(gid, mode) {
  if (!gid) return;
  if (mode !== 'graph' && mode !== 'kanban') return;
  try { localStorage.setItem(VIEW_KEY_PREFIX + gid, mode); } catch {}
}
let currentView = 'graph';
// Toggle which container fills the canvas region. Idempotent. Cytoscape
// stays mounted under the hidden #cy so view-flips don't pay the re-init
// cost; per-view DOM (kanban columns, etc.) renders into #kanban lazily.
function applyView(mode) {
  const prev = currentView;
  const next = mode === 'kanban' ? 'kanban' : 'graph';
  currentView = next;
  const cyEl = document.getElementById('cy');
  const kbEl = document.getElementById('kanban');
  if (cyEl) cyEl.classList.toggle('hidden', next !== 'graph');
  if (kbEl) kbEl.classList.toggle('hidden', next !== 'kanban');
  document.body.classList.toggle('view-graph', next === 'graph');
  document.body.classList.toggle('view-kanban', next === 'kanban');
  // Switching INTO kanban needs an explicit render — fetchGraph may not run
  // again on its own, and the columns would otherwise look empty.
  if (next === 'kanban' && prev !== 'kanban') {
    renderKanban();
  }
  // Sync the bottom toolbar to the new view (hides cy-only slots when
  // entering kanban, hides tb-kanban-selection when leaving).
  updateToolbar();
  // Reset any shift accumulated in the previous view, then recompute for the
  // current view (handles "panel is already open while user switches views").
  adjustKanbanForPanel();
}

// When the side panel opens on a kanban card, the panel may visually cover
// the card's own column. Shift the whole kanban left by just enough that the
// column's right edge sits a margin to the left of the panel. Tracks current
// shift in a module var so successive recomputes (panel resize, window
// resize) work against the un-shifted baseline. No-op when not in kanban, no
// selected card, or panel is closed — in which case the transform clears.
let _kanbanCurrentShift = 0;
const KANBAN_PANEL_MARGIN = 16;
function adjustKanbanForPanel() {
  const kanban = document.getElementById('kanban');
  if (!kanban) return;
  const clear = () => {
    if (_kanbanCurrentShift !== 0) {
      _kanbanCurrentShift = 0;
      kanban.style.transform = '';
    }
  };
  if (currentView !== 'kanban') return clear();
  // Skip on narrow viewports — mobile uses horizontal scroll inside #kanban
  // and the panel will become a bottom-sheet in the responsive roadmap, so
  // shifting doesn't apply.
  if (window.innerWidth < 768) return clear();
  const panel = document.getElementById('panel');
  if (!panel || panel.classList.contains('hidden')) return clear();
  const selectedCard = document.querySelector('.kb-card.selected');
  if (!selectedCard) return clear();
  const column = selectedCard.closest('.kb-column');
  if (!column) return clear();
  // getBoundingClientRect reflects the current transform; un-shift to get the
  // baseline so the next shift is computed correctly when panel width grows.
  const colRect = column.getBoundingClientRect();
  const baselineColRight = colRect.right + _kanbanCurrentShift;
  // The panel slides in via translateX(100%) → 0 over 700ms. Its bounding
  // rect during the slide reports its OFF-SCREEN position (left ≈ viewport
  // width), so reading it would tell us there's no overlap. Use offsetWidth
  // + the panel's pinned right:0 to compute its INTENDED left edge.
  const panelLeft = window.innerWidth - panel.offsetWidth;
  const desiredRight = panelLeft - KANBAN_PANEL_MARGIN;
  const overlap = baselineColRight - desiredRight;
  const newShift = Math.max(0, overlap);
  if (newShift === _kanbanCurrentShift) return;
  _kanbanCurrentShift = newShift;
  kanban.style.transform = newShift > 0 ? `translateX(-${newShift}px)` : '';
}

function apiBase() {
  if (activeGraphId == null) {
    throw new Error('no active graph');
  }
  return `/api/graphs/${activeGraphId}`;
}

let editorMode = 'rich'; // 'rich' | 'raw'
let lastSavedContent = '';
let saveTimer = null;
// Timestamp until which scheduleSave should ignore editor change events.
// Set by loadIntoEditor to swallow the synthetic 'change' that
// richEditor.setMarkdown fires — without this we round-trip-PATCH the task,
// which fires a fresh SSE event, which calls loadIntoEditor again, etc.
let _editorSaveSuppressedUntil = 0;
let saveInFlight = false;
let pendingSave = false;
let savedFadeTimer = null;

// Pending node state for click-to-create flow
let pendingNode = null;       // ghost cy node before first save
let pendingPosition = null;   // {x, y} world coords for the new node
let pendingEdgesForNewNode = null;
let pendingViewportBeforeCreate = null;

// Cytoscape's modifier key (Mac uses cmd/meta, others ctrl)
function isCmd(e) {
  return e && (e.metaKey || e.ctrlKey);
}

// --- Node overlap prevention ---
// Pushes `node` out of any overlap with other nodes, leaving at least
// NODE_GAP world-units of space between bounding boxes. Iterates because a
// push that resolves one collision can create another. Returns true if the
// node was moved.
const NODE_GAP = 12;
const STATUS_ORDER = ['todo', 'in_progress', 'review', 'done'];
const STATUS_LABELS = {
  todo: 'Todo',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};
// Theme-scoped defaults. The two values below are mutable because the
// active theme drives them — applyThemeDefaults() rewrites them when the
// user toggles between light and dark via Settings → Theme.
//   light → mymind reference (pre-cron design)
//   dark  → Cron Calendar reference (current design)
const THEME_DEFAULTS = {
  light: {
    font: 'inter',
    fontColor: '#3a475a',
    bgColor: '#f7f7f7',
    defaultNodeColor: '#ffffff',
    defaultEdgeColor: '#afb5c1',
  },
  dark: {
    font: 'helvetica',
    fontColor: '#ffffff',
    bgColor: '#0f0d0a',
    defaultNodeColor: '#161412',
    defaultEdgeColor: '#cccccc',
  },
};
let DEFAULT_NODE_COLOR = THEME_DEFAULTS.light.defaultNodeColor;
let DEFAULT_EDGE_COLOR = THEME_DEFAULTS.light.defaultEdgeColor;
function applyThemeDefaults(theme) {
  const t = THEME_DEFAULTS[theme] || THEME_DEFAULTS.light;
  DEFAULT_NODE_COLOR = t.defaultNodeColor;
  DEFAULT_EDGE_COLOR = t.defaultEdgeColor;
  return t;
}
const COLOR_PALETTE_COLUMNS = 5;
// User-pickable node BACKGROUND colors. Default tier is LIGHT per the tier
// rule, but family-light values for adjacent hues (red-light + orange-light,
// purple-light + purple-medium) are too visually similar at swatch size, so
// we substitute the family-medium where needed. Each swatch has a clearly
// different hue / saturation so the picker reads at a glance.
const COLOR_PALETTE = [
  { name: 'Base',     value: '#ffffff' }, // neutral-white
  { name: 'Peach',    value: '#ffd6c4' }, // red-light    (pale pinkish-peach)
  { name: 'Coral',    value: '#e27f6e' }, // red-medium   (saturated coral)
  { name: 'Orange',   value: '#fead81' }, // orange-medium (warm peach)
  { name: 'Yellow',   value: '#fef0bf' }, // yellow-light
  { name: 'Green',    value: '#deffe3' }, // green-light
  { name: 'Blue',     value: '#e2f9ff' }, // blue-light   (icy)
  { name: 'Sky',      value: '#95daf5' }, // blue-medium  (sky)
  { name: 'Lavender', value: '#efd6ff' }, // purple-medium
  { name: 'Muted',    value: '#e5e5e5' }, // neutral-grey
];

// User-pickable FONT colors. Font sits on top of bg, so it needs strong-tier
// saturation for legibility. Strong family colors + slate/black neutrals.
const FONT_COLOR_PALETTE = [
  { name: 'Slate',    value: '#3a475a' }, // deep-slate (default text)
  { name: 'Red',      value: '#ef3230' }, // red-strong
  { name: 'Orange',   value: '#fb5305' }, // main-orange (theme accent)
  { name: 'Amber',    value: '#fe7233' }, // orange-strong
  { name: 'Yellow',   value: '#f6c53e' }, // yellow-strong
  { name: 'Green',    value: '#49ca80' }, // green-strong
  { name: 'Blue',     value: '#43ace6' }, // blue-strong
  { name: 'Purple',   value: '#a45fff' }, // purple-strong
  { name: 'Coral',    value: '#e27f6e' }, // red-medium (warm mid-tone)
  { name: 'Black',    value: '#000000' },
];
const EDGE_CURVE_LIMIT = 500;
const EDGE_WEIGHT_MIN = 0.10;
const EDGE_WEIGHT_MAX = 0.90;
// Below this perpendicular distance, the curve is visually a straight line
// and weight has no perceptible effect — snap it to 0.5 to keep the data
// canonical.
const CURVE_SNAP_DISTANCE = 3;

function resolveNodeOverlap(node) {
  if (!node || node.empty()) return false;
  const MAX_ITER = 30;
  let pushed = false;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let any = false;
    const myBB = node.boundingBox();
    const others = cy.nodes().filter((n) => n.id() !== node.id() && n.id() !== '__edge_target__');
    for (let i = 0; i < others.length; i++) {
      const other = others[i];
      const oBB = other.boundingBox();
      const ovX = Math.min(myBB.x2, oBB.x2) - Math.max(myBB.x1, oBB.x1);
      const ovY = Math.min(myBB.y2, oBB.y2) - Math.max(myBB.y1, oBB.y1);
      // Already separated by at least NODE_GAP on one axis → no overlap
      if (ovX <= -NODE_GAP || ovY <= -NODE_GAP) continue;
      const myPos = node.position();
      const oPos = other.position();
      const pushX = ovX + NODE_GAP;
      const pushY = ovY + NODE_GAP;
      // Push along whichever axis needs less movement
      if (pushX <= pushY) {
        const sign = (myPos.x - oPos.x) >= 0 ? 1 : -1;
        node.position({ x: myPos.x + sign * pushX, y: myPos.y });
      } else {
        const sign = (myPos.y - oPos.y) >= 0 ? 1 : -1;
        node.position({ x: myPos.x, y: myPos.y + sign * pushY });
      }
      any = true;
      pushed = true;
      break;
    }
    if (!any) return pushed;
  }
  return pushed;
}

function resolveAllOverlaps() {
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    cy.nodes().forEach((n) => {
      if (n.id() === '__pending__' || n.id() === '__edge_target__') return;
      if (resolveNodeOverlap(n)) changed = true;
    });
    if (!changed) break;
  }
}

// --- Markdown frontmatter helpers ---
const FENCE = '---';

function parseFrontmatter(text) {
  if (!text || !text.startsWith(FENCE + '\n')) {
    return { meta: {}, body: text || '' };
  }
  const end = text.indexOf('\n' + FENCE, FENCE.length);
  if (end === -1) return { meta: {}, body: text };
  const yamlStr = text.slice(FENCE.length + 1, end);
  const body = text.slice(end + FENCE.length + 2);
  const meta = {};
  for (const line of yamlStr.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        v = v.slice(1, -1);
      }
      meta[m[1]] = v;
    }
  }
  return { meta, body };
}

function buildContent(meta, body) {
  const lines = [FENCE];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null || v === '') continue;
    const needsQuote = /[:#&*!|>'"%@`]/.test(String(v)) || /^\s|\s$/.test(String(v));
    lines.push(`${k}: ${needsQuote ? `'${String(v).replace(/'/g, "''")}'` : v}`);
  }
  lines.push(FENCE);
  lines.push(body || '');
  return lines.join('\n');
}

function roundPosition(value) {
  return Math.round(value * 100) / 100;
}

function roundCurve(value) {
  return Math.round(value * 100) / 100;
}

// Canonical {distance, weight} for an edge or link. Tolerates the legacy
// number form (perpendicular offset only, weight implicitly 0.5) so old
// data and any in-flight requests keep working.
function getEdgeCurveData(edgeOrLink) {
  const meta = typeof edgeOrLink.data === 'function'
    ? edgeOrLink.data('meta')
    : edgeOrLink.meta;
  const c = meta && meta.curve;
  if (c == null) return { distance: 0, weight: 0.5 };
  if (typeof c === 'number') {
    return { distance: Number.isFinite(c) ? c : 0, weight: 0.5 };
  }
  const distance = Number(c.distance);
  const weight = Number(c.weight);
  return {
    distance: Number.isFinite(distance) ? distance : 0,
    weight: Number.isFinite(weight) ? weight : 0.5,
  };
}

// In-place updates so autosave doesn't re-run cytoscape layout
function updateGraphNode(task) {
  if (!cy) return;
  const node = cy.getElementById(String(task.id));
  if (!node || node.empty()) return;
  const meta = task.meta || {};
  node.data('title', meta.title || 'Untitled');
  node.data('description', meta.description || '');
  node.data('status', meta.status || 'todo');
  node.data('color', meta.color || DEFAULT_NODE_COLOR);
  // background-image is optional. Set only when present so the cy
  // `[backgroundImage]` selector matches image-bearing nodes and leaves
  // image-less nodes on their default label-sized geometry. Explicitly
  // remove on absence so a PATCH that clears the image clears the data too.
  if (meta['background-image']) {
    setBgImageData(node, meta['background-image']);
  } else {
    clearBgImageData(node);
  }
  node.data('meta', meta);
  if (typeof task.version === 'number') node.data('version', task.version);
  // Last writer's user id, used by the multi-agent follow filter to decide
  // whether THIS event came from the agent owned by me.
  node.data('lastModifiedByUser', task.last_modified_by_user ?? null);
}

// Default-render dimensions used while the image's actual size is loading.
// 124 ≈ 220 × 9/16 (a 16:9 image at width 220), so the initial paint matches
// the most common screenshot shape and the post-load swap is usually invisible.
const BG_DEFAULT_IMAGE_H = 124;
const BG_TEXT_BOTTOM_PADDING = 16; // matches base node padding (top)
// Cap the rendered image height so a phone screenshot doesn't make one node
// dwarf the rest of the graph. ~280 fits a typical portrait-ish photo cleanly.
const BG_MAX_IMAGE_H = 280;

// Apply the per-node style overrides that cytoscape DOES honor (verified
// in-browser): height, background-height, text-margin-y. padding-bottom
// can't be made asymmetric from padding-top — even individual side
// overrides propagate to all four sides — so we set `height` directly
// and let the symmetric `padding: 16px` shorthand from the stylesheet
// provide consistent visual padding above and below the label.
//
// The visual structure we're aiming for matches what a normal label-sized
// node would look like, with the image area glued to the bottom:
//   outer padding-top (16) → label → 16 gap → image → outer padding-bottom (16)
//
// Inner height = label_h + image_h. With text-margin-y = -image_h/2 and
// text-valign center, the label lands at the top of the inner area
// (matching label-sized geometry). The outer 16 padding handles both the
// visual top padding and the visual gap between label bottom and image
// top — same paddings as a normal node.
function applyBgDimensions(node, imageH) {
  const h = Math.max(1, Math.min(BG_MAX_IMAGE_H, Math.round(imageH)));
  node.data('bgImageH', h);
  const labelH = measureLabelHeight(node.data('title') || ' ');
  node.style({
    'height': `${labelH + h}px`,
    'background-height': `${h}px`,
    'text-margin-y': -h / 2,
  });
  // Presence pills are anchored to each node's rendered bounding box. A height
  // change here (image load / replace) doesn't fire cy's 'position' event, so
  // re-place them explicitly or the "(You)" tag floats off the resized node.
  if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
}

// Hidden DOM probe matching cytoscape's label font + wrap width so we know
// the rendered label height per title. Cytoscape doesn't expose this
// directly, but we need it to size image nodes so visual padding around
// the title matches normal label-sized nodes.
let _labelProbe = null;
function measureLabelHeight(text) {
  if (!_labelProbe) {
    _labelProbe = document.createElement('div');
    _labelProbe.style.cssText = [
      'position: absolute',
      'visibility: hidden',
      'top: -9999px',
      'left: -9999px',
      'font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'font-size: 13px',
      'line-height: 1',
      'width: 188px',
      'word-wrap: break-word',
      'white-space: normal',
    ].join(';');
    document.body.appendChild(_labelProbe);
  }
  _labelProbe.textContent = text || ' ';
  return _labelProbe.offsetHeight || 13;
}

function setBgImageData(node, url) {
  const prevUrl = node.data('backgroundImage');
  if (url === prevUrl && node.data('bgImageH')) {
    // Same image, but the title (or something else) may have changed —
    // re-run the height calc against the cached image dimensions instead
    // of re-fetching the image bytes.
    applyBgDimensions(node, node.data('bgImageH'));
    return;
  }
  if (prevUrl && url !== prevUrl) {
    // Replacing an image that's already on screen. Don't swap the URL yet:
    // cytoscape would paint the new (still-loading) URL as a blank frame at
    // the old height, then jump when the bytes arrive. Decode off-canvas first
    // and keep the old image visible until the new one is ready — see below.
    swapBgImageData(node, url);
    return;
  }
  node.data('backgroundImage', url);
  loadBgImageDimensions(node, url);
}

// Atomic image replace: decode `url` off-canvas, then write the new
// background-image and its measured height in the same frame so the node never
// flashes blank or changes size mid-load. The bgPendingUrl marker lets a newer
// replace supersede one that's still decoding (last write wins).
function swapBgImageData(node, url) {
  node.data('bgPendingUrl', url);
  const img = new Image();
  img.onload = () => {
    if (!node || node.empty() || node.data('bgPendingUrl') !== url) return;
    node.removeData('bgPendingUrl');
    node.data('backgroundImage', url);
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const NODE_W = 220;
    if (nw && nh) applyBgDimensions(node, NODE_W * (nh / nw));
  };
  img.onerror = () => {
    if (!node || node.empty() || node.data('bgPendingUrl') !== url) return;
    node.removeData('bgPendingUrl');
    // Decode failed — swap anyway so the user isn't stuck on the old image;
    // the broken-image canvas renders at the node's existing dimensions.
    node.data('backgroundImage', url);
  };
  img.src = url;
}

function clearBgImageData(node) {
  node.removeData('backgroundImage');
  node.removeData('bgImageH');
  // Drop the per-node overrides so the node returns to base label-sized
  // geometry.
  node.style({
    'height': '',
    'background-height': '',
    'text-margin-y': '',
  });
}

// Measure the image's natural dimensions, scale to the node's render width
// (220), cap, and write back to node data. Cytoscape re-renders on data
// changes so the node resizes itself.
function loadBgImageDimensions(node, url) {
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    if (!node || node.empty()) return;
    // Re-check the URL in case it changed (replace flow) before this onload.
    if (node.data('backgroundImage') !== url) return;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;
    const NODE_W = 220;
    applyBgDimensions(node, NODE_W * (nh / nw));
  };
  img.onerror = () => {
    // Leave the defaults in place; the broken-image canvas will show at
    // default-sized dimensions, which is the same UX as before.
  };
  img.src = url;
}

function addGraphNode(task) {
  if (!cy) return;
  const meta = task.meta || {};
  const bgUrl = meta['background-image'];
  const data = {
    id: String(task.id),
    taskId: task.id,
    title: meta.title || 'Untitled',
    description: meta.description || '',
    status: meta.status || 'todo',
    color: meta.color || DEFAULT_NODE_COLOR,
    meta,
    version: typeof task.version === 'number' ? task.version : 0,
    lastModifiedByUser: task.last_modified_by_user ?? null,
  };
  if (bgUrl) data.backgroundImage = bgUrl;
  cy.add({ group: 'nodes', data });
  if (bgUrl) {
    const node = cy.getElementById(String(task.id));
    if (node && !node.empty()) loadBgImageDimensions(node, bgUrl);
  }
}

function addGraphEdge(edge) {
  if (!cy || !edge) return;
  const meta = edge.meta || {};
  cy.add({
    group: 'edges',
    data: {
      id: `e${edge.id}`,
      source: String(edge.source_id),
      target: String(edge.target_id),
      edgeType: edge.type,
      color: meta.color || DEFAULT_EDGE_COLOR,
      curveDistance: getEdgeCurveData({ meta }).distance,
      curveWeight: getEdgeCurveData({ meta }).weight,
      meta,
      version: typeof edge.version === 'number' ? edge.version : 0,
    },
  });
}

async function fetchGraph() {
  const wasAccessDenied = accessDenied;
  const res = await fetch(`${apiBase()}/graph`);
  if (!res.ok) {
    if (res.status === 403) {
      accessDenied = true;
      startAccessDeniedPoll();
      if (cy) cy.elements().remove();
      updateEmptyState();
      applyReadOnlyState();
      return;
    }
    throw new Error(`failed to load graph: ${res.status}`);
  }
  accessDenied = false;
  stopAccessDeniedPoll();
  // Leaving the accessDenied state: the graph-row metadata (viewer_can_edit,
  // settings, name) is stale because the original /api/graphs/:id 403'd at
  // boot. Refetch it before applyReadOnlyState so readonly/forbidden body
  // classes + autoungrabify recompute against the real permissions.
  if (wasAccessDenied) {
    try {
      const r = await fetch(`/api/graphs/${encodeURIComponent(activeGraphId)}`);
      if (r.ok) {
        currentGraph = await r.json();
        applySettings();
        renderSidebar();
      }
    } catch {}
    applyReadOnlyState();
  }
  const data = await res.json();

  const elements = [];

  for (const node of data.nodes) {
    const bgUrl = node.meta && node.meta['background-image'];
    const nodeData = {
      id: String(node.id),
      taskId: node.id,
      title: node.title || 'Untitled',
      description: node.description || '',
      status: node.status || 'todo',
      color: (node.meta && node.meta.color) || DEFAULT_NODE_COLOR,
      meta: node.meta || {},
      version: typeof node.version === 'number' ? node.version : 0,
    };
    if (bgUrl) nodeData.backgroundImage = bgUrl;
    elements.push({ group: 'nodes', data: nodeData });
  }

  for (const link of data.links) {
    elements.push({
      group: 'edges',
      data: {
        id: `e${link.id}`,
        source: String(link.source),
        target: String(link.target),
        edgeType: link.type,
        color: (link.meta && link.meta.color) || DEFAULT_EDGE_COLOR,
        curveDistance: getEdgeCurveData(link).distance,
        curveWeight: getEdgeCurveData(link).weight,
        meta: link.meta || {},
        version: typeof link.version === 'number' ? link.version : 0,
      },
    });
  }

  const isFirstLoad = cy.elements().length === 0;
  const savedZoom = cy.zoom();
  const savedPan = { ...cy.pan() };

  hideCurveHandle();
  cy.elements().remove();
  cy.add(elements);
  // After the rebuild, kick off image-dimension loads for every node that
  // has a background image. Each onload writes back to node data and
  // cytoscape re-renders that single node — no re-fetch needed.
  cy.nodes().forEach((n) => {
    const url = n.data('backgroundImage');
    if (url) loadBgImageDimensions(n, url);
  });

  let hasPositions = false;
  cy.nodes().forEach((n) => {
    const meta = n.data('meta');
    if (meta && meta.x !== undefined && meta.y !== undefined) {
      n.position({ x: meta.x, y: meta.y });
      hasPositions = true;
    }
  });

  if (!hasPositions && elements.length > 0) {
    cy.layout({
      name: 'breadthfirst',
      directed: true,
      spacingFactor: 1.0,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
    }).run();
  }

  resolveAllOverlaps();

  if (isFirstLoad && elements.length > 0) {
    cy.fit(undefined, 50);
  } else if (!isFirstLoad) {
    cy.zoom(savedZoom);
    cy.pan(savedPan);
  }

  updateEmptyState();
  updateLeafHighlights();
  // fetchGraph wipes element classes (incl. .selected) — resync the toolbar
  updateToolbar();
  // Kanban renderer is a no-op when not in kanban view.
  renderKanban();
}

async function updateLeafHighlights() {
  const res = await fetch(`${apiBase()}/tasks/leaves`);
  const leaves = await res.json();
  const leafIds = new Set(leaves.map((t) => String(t.id)));

  cy.nodes().forEach((n) => {
    if (leafIds.has(n.id())) {
      n.addClass('leaf');
    } else {
      n.removeClass('leaf');
    }
  });
}

function updateEmptyState() {
  const el = document.getElementById('empty-state');
  const p = el.querySelector('p');
  if (accessDenied) {
    p.textContent = 'Access denied. Contact graph owner.';
    el.classList.remove('hidden');
    return;
  }
  const noGraph = activeGraphId == null;
  const noNodes = cy && cy.nodes().length === 0;
  if (noGraph || noNodes) {
    p.textContent = noGraph
      ? 'Click here for a new task'
      : 'Click anywhere to create your first task';
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// --- Selection-driven toolbar ---
function getSelectionCounts() {
  if (!cy) return { nodes: 0, edges: 0, total: 0 };
  const nodes = cy.nodes('.selected').length;
  const edges = cy.edges('.selected').length;
  return { nodes, edges, total: nodes + edges };
}

function getSelectionMode() {
  if (!cy) return 'neutral';
  if (edgeCreation) return 'edge-creating';
  const { nodes, edges } = getSelectionCounts();
  if (nodes > 0 && edges === 0) return 'node';
  if (edges > 0 && nodes === 0) return 'edge';
  if (nodes > 0 && edges > 0) return 'mixed';
  return 'neutral';
}

function selectionSummaryHtml(showSave = false) {
  const { total } = getSelectionCounts();
  return `
    <span class="tb-selection-summary">
      <span>${total}</span>
      ${showSave ? '<span class="tb-save-hint"><span>Save</span><kbd>Enter</kbd></span>' : ''}
    </span>
  `;
}

function directionIconSvg(direction) {
  const common = 'width="16" height="16" viewBox="0 0 256 256" fill="currentColor"';
  if (direction === 'backward') {
    return `<svg ${common} aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z"/></svg>`;
  }
  if (direction === 'related') {
    return `<svg ${common} aria-hidden="true"><path d="M237.66,133.66l-32,32a8,8,0,0,1-11.32-11.32L212.69,136H43.31l18.35,18.34a8,8,0,0,1-11.32,11.32l-32-32a8,8,0,0,1,0-11.32l32-32a8,8,0,0,1,11.32,11.32L43.31,120H212.69l-18.35-18.34a8,8,0,0,1,11.32-11.32l32,32A8,8,0,0,1,237.66,133.66Z"/></svg>`;
  }
  return `<svg ${common} aria-hidden="true"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z"/></svg>`;
}

function getSelectedEdgeDirection() {
  const selectedEdges = cy.edges('.selected').filter((edge) => !edge.id().startsWith('__'));
  if (selectedEdges.length !== 1) return 'forward';
  const edge = selectedEdges[0];
  if (edgeTypeEditing && edgeTypeEditing.edgeId === edge.id()) {
    return edgeTypeEditing.currentDirection;
  }
  return edge.data('edgeType') === 'related' ? 'related' : 'forward';
}

function directionLabel(direction) {
  if (direction === 'backward') return 'Backward dependency';
  if (direction === 'related') return 'Related';
  return 'Forward dependency';
}

function isStatusEditSelected() {
  const nodes = cy.nodes('.selected');
  return !!statusEditing && nodes.length === 1 && statusEditing.nodeId === nodes[0].id();
}

function isEdgeEditSelected() {
  const edges = cy.edges('.selected');
  return !!edgeTypeEditing && edges.length === 1 && edgeTypeEditing.edgeId === edges[0].id();
}

// Measure the bottom toolbar's natural width and scale it down with a CSS
// transform if it would otherwise extend past the canvas (sidebar-right →
// viewport-right). Keeps the toolbar inside the canvas region at narrow
// viewports while preserving its centered position and aspect at wide
// ones. Combines with the CSS `translateX(-50%)` centering — the final
// transform is `translateX(-50%) scale(N)`.
function fitBottomBar() {
  const bar = document.getElementById('bottom-bar');
  if (!bar || bar.classList.contains('hidden')) return;
  const sidebarW = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'),
  ) || 0;
  const TOOLBAR_MARGIN = 16; // visual breathing room inside the canvas
  const canvasW = Math.max(0, window.innerWidth - sidebarW - 2 * TOOLBAR_MARGIN);
  // Reset to the unscaled centering transform so getBoundingClientRect
  // reports the natural width.
  bar.style.transform = 'translateX(-50%)';
  const natural = bar.getBoundingClientRect().width;
  if (natural <= canvasW || canvasW <= 0) return;
  // Floor at 0.4 — past that the buttons become illegible; the user
  // accepted "small viewport looks bad" as the tradeoff.
  const scale = Math.max(0.4, canvasW / natural);
  bar.style.transform = `translateX(-50%) scale(${scale})`;
}

function updateToolbar() {
  if (currentView === 'kanban') {
    updateKanbanToolbar();
    return;
  }
  // Graph-view path. Make sure the kanban slot is hidden after a view flip.
  const kanbanSlot = document.getElementById('tb-kanban-selection');
  if (kanbanSlot) kanbanSlot.classList.add('hidden');
  const mode = getSelectionMode();
  const tbNeutral = document.getElementById('tb-neutral');
  const tbMixed = document.getElementById('tb-mixed');
  const tbNode = document.getElementById('tb-node');
  const tbEdge = document.getElementById('tb-edge');
  const tbCreating = document.getElementById('tb-edge-creating');
  tbNeutral.classList.toggle('hidden', mode !== 'neutral');
  tbMixed.classList.toggle('hidden', mode !== 'mixed');
  tbNode.classList.toggle('hidden', mode !== 'node');
  tbEdge.classList.toggle('hidden', mode !== 'edge');
  tbCreating.classList.toggle('hidden', mode !== 'edge-creating');

  if (mode === 'node') {
    const labelEl = document.getElementById('tb-node-status-label');
    const editingThis = isStatusEditSelected();
    document.getElementById('tb-node-count').innerHTML = selectionSummaryHtml(editingThis);
    labelEl.textContent = editingThis
      ? STATUS_LABELS[statusEditing.currentStatus]
      : 'Status';
    document.getElementById('btn-status').title = editingThis
      ? 'Cycle status. Enter to confirm. Esc to cancel.'
      : 'Cycle status';
  } else if (mode === 'mixed') {
    document.getElementById('tb-mixed-count').innerHTML = selectionSummaryHtml(false);
  } else if (mode === 'edge') {
    const dirEl = document.getElementById('tb-edge-direction');
    const btnDirection = document.getElementById('btn-direction-edge');
    const iconEl = document.getElementById('tb-edge-direction-icon');
    const editingThis = isEdgeEditSelected();
    const direction = getSelectedEdgeDirection();
    dirEl.innerHTML = selectionSummaryHtml(editingThis);
    iconEl.innerHTML = directionIconSvg(direction);
    btnDirection.title = editingThis
      ? `${directionLabel(direction)}. Enter to confirm. Esc to cancel.`
      : `${directionLabel(direction)}. Press E to change.`;
  } else if (mode === 'edge-creating') {
    const { direction } = edgeCreation;
    const sources = edgeCreation.sources || [edgeCreation.source].filter(Boolean);
    const rawTitle = sources.length === 1
      ? (sources[0].data('title') || '?')
      : `${sources.length} nodes`;
    const srcTitle = rawTitle.length > 12
      ? `${rawTitle.slice(0, 12).trimEnd()}..`
      : rawTitle;
    const arrow = direction === 'related' ? '↔'
      : direction === 'backward' ? '←' : '→';
    const previewText = direction === 'backward'
      ? `? → ${srcTitle}`
      : `${srcTitle} ${arrow} ?`;
    document.getElementById('tb-edge-creating-count').innerHTML = selectionSummaryHtml(false);
    document.getElementById('tb-edge-creating-preview').textContent =
      previewText;
    document.getElementById('tb-edge-creating-direction-icon').innerHTML = directionIconSvg(direction);
  }
  // Buttons appear/disappear depending on selection — re-measure & re-scale.
  if (typeof fitBottomBar === 'function') fitBottomBar();
}

// --- App settings (Cmd+K) ---
const SETTINGS_KEY = 'graphtask:settings';
const FONTS = [
  { id: 'helvetica', name: 'Helvetica Neue', stack: '"Helvetica Neue", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { id: 'inter',     name: 'Inter',          stack: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { id: 'garamond',  name: 'EB Garamond',    stack: '"EB Garamond", Garamond, "Times New Roman", serif' },
  { id: 'roboto',    name: 'Roboto',         stack: '"Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
];
const DEFAULT_SETTINGS = Object.freeze({
  // Dark theme is intentionally not selectable from the UI yet — it's still
  // a work-in-progress. Users default to (and are pinned to) light. The
  // dark code paths remain so we can re-enable the toggle later.
  theme: 'light',
  font: 'inter',
  fontColor: '#3a475a', // deep-slate (light-theme default)
  bgColor: '#f7f7f7',   // neutral-light-grey canvas
});
let appSettings = { ...DEFAULT_SETTINGS };

function getFontStack(id) {
  return (FONTS.find((f) => f.id === id) || FONTS[0]).stack;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      appSettings = { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (err) {
    appSettings = { ...DEFAULT_SETTINGS };
  }
  // Dark theme is currently disabled — pin everyone to light, even users
  // whose localStorage carries a stale `theme: 'dark'` from earlier testing.
  if (appSettings.theme !== 'light') {
    appSettings.theme = 'light';
    appSettings.font = THEME_DEFAULTS.light.font;
    appSettings.fontColor = THEME_DEFAULTS.light.fontColor;
    appSettings.bgColor = THEME_DEFAULTS.light.bgColor;
  }
  applyThemeDefaults(appSettings.theme);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
  } catch (err) { /* storage unavailable; settings won't persist */ }
}

// Effective settings = active graph's per-graph overrides ∘ app-level Defaults.
// Missing keys on the graph fall back to the user's defaults so a graph never
// "snapshots" the current default — it tracks whatever default is current
// until the user customizes that key explicitly.
function getEffectiveSettings() {
  const gs = (currentGraph && currentGraph.settings) || {};
  return {
    font: gs.font || appSettings.font,
    fontColor: gs.font_color || appSettings.fontColor,
    bgColor: gs.bg_color || appSettings.bgColor,
  };
}

function applySettings() {
  document.documentElement.dataset.theme = appSettings.theme;
  const eff = getEffectiveSettings();
  const fontStack = getFontStack(eff.font);
  document.documentElement.style.setProperty('--app-font', fontStack);
  document.documentElement.style.setProperty('--app-font-color', eff.fontColor);
  const cyEl = document.getElementById('cy');
  if (cyEl) cyEl.style.background = eff.bgColor;
  if (cy) {
    // Re-seat the full theme-scoped style array (the cron and mymind
    // arrays differ in many selectors — selection underlay, status borders,
    // editing colour, etc.), then re-apply per-graph font/colour overrides.
    cy.style().fromJson(cytoscapeStyle(appSettings.theme)).update();
    cy.style().selector('node').style({
      'font-family': fontStack,
      'color': eff.fontColor,
    }).update();
    // The theme styles use historical orange for node.selected/edge.selected
    // underlays. Override with the local user's deterministic color so own
    // selection visually matches the user's avatar — and matches the
    // colored outline peers see on the same node.
    if (typeof applyOwnSelectionColor === 'function') applyOwnSelectionColor();
  }
}

// Override the underlay color for node.selected and edge.selected so the
// local user's own selection renders in their avatar color (purple for
// Lucas, etc.) instead of the historical orange. Cytoscape doesn't read
// CSS variables for canvas rendering, so we patch the style at runtime —
// once after cy init and after every full re-style (theme switch).
function applyOwnSelectionColor() {
  const ownId = presenceCurrentOwnId();
  if (!ownId) return;
  const color = colorForId(ownId);
  // Expose the local user's avatar color as a CSS var so non-cy surfaces
  // (kanban cards, future views) can paint their selection state in the
  // same color the avatar bar shows.
  document.documentElement.style.setProperty('--own-selection-color', color);
  if (!cy) return;
  cy.style()
    .selector('node.selected').style('underlay-color', color)
    .selector('edge.selected').style('underlay-color', color)
    .update();
}

function setSettingTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  if (appSettings.theme === theme) return;
  // Each theme has its own canvas/font defaults; switching resets these to
  // the new theme's reference values. Per-graph appearance overrides are
  // untouched (they live on currentGraph.settings, not appSettings).
  const t = applyThemeDefaults(theme);
  appSettings.theme = theme;
  appSettings.font = t.font;
  appSettings.fontColor = t.fontColor;
  appSettings.bgColor = t.bgColor;
  applySettings();
  saveSettings();
  // Toast UI Editor theme is baked in at construction; recreate it so the
  // markdown editor's surface matches the new theme.
  recreateRichEditorForTheme();
}

// Toast UI's addImageBlobHook callback. Receives a Blob (the pasted /
// dropped image) and a callback(url, alt) that inserts a `![alt](url)`
// markdown reference at the cursor. We round-trip through our uploads
// endpoint so bytes land in Postgres and the editor's save stays small —
// otherwise Toast UI would embed a base64 data URI and the next save would
// 413 against express.json's 100KB default body limit.
async function uploadEditorImage(blob, callback) {
  try {
    const { url } = await uploadImageFile(blob);
    callback(url, '');
  } catch (e) {
    console.error('image upload failed', e);
    showHint(e.message || 'Image upload failed');
  }
}

// Toast UI Editor instance — built once at startup, recreated on theme switch.
function createRichEditor() {
  const editor = new toastui.Editor({
    el: document.getElementById('rich-editor'),
    height: '100%',
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    hideModeSwitch: true,
    usageStatistics: false,
    theme: appSettings.theme === 'dark' ? 'dark' : 'default',
    toolbarItems: [
      ['heading'],
      ['bold', 'italic'],
      ['ul', 'ol'],
    ],
    // Intercept pasted / dropped images. Without this, Toast UI embeds them
    // as `![](data:image/png;base64,...)` which trips Express's 100KB JSON
    // body limit on the next save. We upload through /api/graphs/:gid/uploads
    // and let Toast UI insert the returned URL instead — same UX, persisted
    // bytes, save fits comfortably under the JSON limit.
    hooks: {
      addImageBlobHook: uploadEditorImage,
    },
  });
  // Toast UI only adds `.active` to toolbar buttons when the cursor sits
  // inside text that already carries the mark. It doesn't reflect
  // "armed" state — when you click Bold without a selection, ProseMirror
  // records bold in `storedMarks` (apply to next char), but the toolbar
  // stays visually idle. Sync the class ourselves from the underlying
  // ProseMirror state so the visual cue reflects what will happen if the
  // user starts typing.
  editor.on('caretChange', () => syncToolbarActiveMarks(editor));
  return editor;
}
function syncToolbarActiveMarks(editor) {
  const inner = editor.getCurrentModeEditor && editor.getCurrentModeEditor();
  if (!inner || !inner.view) return;
  const state = inner.view.state;
  const marks = state.storedMarks || state.selection.$from.marks();
  const names = new Set(marks.map((m) => m.type.name));
  const tb = document.querySelector('.toastui-editor-defaultUI-toolbar');
  if (!tb) return;
  const toggle = (cls, on) => {
    const btn = tb.querySelector(`.${cls}.toastui-editor-toolbar-icons`);
    if (btn) btn.classList.toggle('active', on);
  };
  toggle('bold', names.has('strong'));
  toggle('italic', names.has('emph') || names.has('em'));
}

function recreateRichEditorForTheme() {
  if (!richEditor) return;
  const md = richEditor.getMarkdown();
  try { richEditor.destroy(); } catch {}
  richEditor = createRichEditor();
  richEditor.setMarkdown(md, false);
  richEditor.on('change', scheduleSave);
}
function setSettingFont(id) {
  if (!FONTS.find((f) => f.id === id)) return;
  appSettings.font = id;
  applySettings();
  saveSettings();
}
function setSettingFontColor(value) {
  appSettings.fontColor = value;
  applySettings();
  saveSettings();
}
function setSettingBgColor(value) {
  appSettings.bgColor = value;
  applySettings();
  saveSettings();
}

// --- Selection color palette ---
let colorPaletteState = {
  open: false,
  activeIndex: 0,
  target: 'selection', // 'selection' | 'settings-bg' | 'settings-font-color'
};

// Font color picker uses a strong-tier palette; everything else (node bg,
// canvas bg) uses the light-tier COLOR_PALETTE.
function getActivePalette() {
  return colorPaletteState.target === 'settings-font-color' ? FONT_COLOR_PALETTE : COLOR_PALETTE;
}

function findPaletteIndexForColor(value) {
  const target = normalizeColor(value);
  const idx = getActivePalette().findIndex((c) => normalizeColor(c.value) === target);
  return idx >= 0 ? idx : 0;
}

function normalizeColor(value) {
  return String(value || '').trim().toUpperCase();
}

function getColorableSelection() {
  const nodes = [];
  const edges = [];
  if (!cy) return { nodes, edges };

  cy.nodes('.selected').forEach((node) => {
    if (node.id() === '__edge_target__') return;
    nodes.push(node);
  });
  cy.edges('.selected').forEach((edge) => {
    if (edge.id().startsWith('__')) return;
    edges.push(edge);
  });
  return { nodes, edges };
}

function hasColorableSelection() {
  const { nodes, edges } = getColorableSelection();
  return nodes.length > 0 || edges.length > 0;
}

function getSelectionColorIndex() {
  const { nodes, edges } = getColorableSelection();
  const colors = [
    ...nodes.map((node) => node.data('color') || DEFAULT_NODE_COLOR),
    ...edges.map((edge) => edge.data('color') || DEFAULT_EDGE_COLOR),
  ];
  if (colors.length === 0) return 0;
  const first = normalizeColor(colors[0]);
  const allMatch = colors.every((color) => normalizeColor(color) === first);
  if (!allMatch) return 0;
  const idx = COLOR_PALETTE.findIndex((color) => normalizeColor(color.value) === first);
  return idx >= 0 ? idx : 0;
}

function getColorPaletteAnchor() {
  const mode = getSelectionMode();
  const id = mode === 'mixed'
    ? 'btn-color-selection'
    : mode === 'edge'
      ? 'btn-color-edge'
      : 'btn-color-node';
  return document.getElementById(id);
}

function renderColorPalette() {
  const palette = document.getElementById('color-palette');
  const grid = document.getElementById('color-palette-grid');
  if (!palette || !grid) return;
  const active = getActivePalette();
  // Skip re-render if the same palette is already laid out — keyed by target
  // so swapping between bg-picker and font-picker correctly rebuilds.
  const paletteKey = colorPaletteState.target === 'settings-font-color' ? 'font' : 'bg';
  if (palette.dataset.rendered === paletteKey) return;
  grid.innerHTML = '';
  active.forEach((color, index) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = color.value;
    swatch.setAttribute('role', 'option');
    swatch.setAttribute('aria-label', color.name);
    swatch.dataset.index = String(index);
    swatch.addEventListener('click', () => commitColorPalette(index));
    grid.appendChild(swatch);
  });
  palette.dataset.rendered = paletteKey;
}

function setActiveColorSwatch(index, focus = false) {
  const palette = document.getElementById('color-palette');
  if (!palette) return;
  const len = getActivePalette().length;
  const nextIndex = (index + len) % len;
  colorPaletteState.activeIndex = nextIndex;
  palette.querySelectorAll('.color-swatch').forEach((swatch) => {
    const active = Number(swatch.dataset.index) === nextIndex;
    swatch.classList.toggle('active', active);
    swatch.setAttribute('aria-selected', active ? 'true' : 'false');
    swatch.tabIndex = active ? 0 : -1;
    if (active && focus) swatch.focus();
  });
}

function moveActiveColorSwatch(rowDelta, colDelta) {
  const len = getActivePalette().length;
  const rows = Math.ceil(len / COLOR_PALETTE_COLUMNS);
  const currentRow = Math.floor(colorPaletteState.activeIndex / COLOR_PALETTE_COLUMNS);
  const currentCol = colorPaletteState.activeIndex % COLOR_PALETTE_COLUMNS;
  let nextRow = (currentRow + rowDelta + rows) % rows;
  let nextCol = (currentCol + colDelta + COLOR_PALETTE_COLUMNS) % COLOR_PALETTE_COLUMNS;
  let nextIndex = nextRow * COLOR_PALETTE_COLUMNS + nextCol;

  while (nextIndex >= len) {
    nextRow = (nextRow + (rowDelta >= 0 ? 1 : -1) + rows) % rows;
    nextIndex = nextRow * COLOR_PALETTE_COLUMNS + nextCol;
  }

  setActiveColorSwatch(nextIndex, true);
}

function positionColorPalette(anchor) {
  const palette = document.getElementById('color-palette');
  if (!palette) return;
  const paletteRect = palette.getBoundingClientRect();
  const anchorRect = anchor && anchor.getBoundingClientRect();
  let left = (window.innerWidth - paletteRect.width) / 2;
  let top = window.innerHeight - paletteRect.height - 72;

  if (anchorRect) {
    left = anchorRect.left + (anchorRect.width / 2) - (paletteRect.width / 2);
    // Settings palette pops down from the Cmd+K search bar (which sits high on
    // screen); selection palette pops up from a toolbar button at the bottom.
    const preferBelow = colorPaletteState.target !== 'selection';
    if (preferBelow) {
      top = anchorRect.bottom + 10;
      if (top + paletteRect.height > window.innerHeight - 8) {
        top = anchorRect.top - paletteRect.height - 10;
      }
    } else {
      top = anchorRect.top - paletteRect.height - 10;
      if (top < 8) top = anchorRect.bottom + 10;
    }
  }

  left = Math.min(window.innerWidth - paletteRect.width - 8, Math.max(8, left));
  top = Math.min(window.innerHeight - paletteRect.height - 8, Math.max(8, top));
  palette.style.left = `${left}px`;
  palette.style.top = `${top}px`;
}

// When the color palette was opened from the app-settings modal, set this
// so that closing it (X, Esc) re-opens settings instead of dropping back
// to the canvas.
let _colorPaletteReturnToSettings = false;

function openColorPalette(anchor, target = 'selection') {
  if (target === 'selection') {
    if (edgeCreation || !hasColorableSelection()) return false;
    if (anchor === undefined) anchor = getColorPaletteAnchor();
  }
  if (edgeTypeEditing) cancelEdgeTypeEdit();
  if (statusEditing) cancelStatusEdit();

  // Set the target BEFORE rendering so renderColorPalette picks the right
  // palette (font vs bg). If we render first, we'd render with the previous
  // target's palette and the swatches wouldn't match the picker's purpose.
  colorPaletteState.target = target;
  renderColorPalette();
  const palette = document.getElementById('color-palette');
  if (!palette) return false;
  // Set the section title so the picker isn't a context-free grid of swatches.
  const titleEl = document.getElementById('color-palette-title');
  if (titleEl) {
    if (target === 'settings-font-color') titleEl.textContent = 'Font color';
    else if (target === 'settings-bg') titleEl.textContent = 'Background color';
    else titleEl.textContent = 'Color';
  }
  // Track whether this open came from app-settings so close can return there.
  _colorPaletteReturnToSettings = (target === 'settings-bg' || target === 'settings-font-color');

  colorPaletteState.open = true;
  palette.classList.remove('hidden');
  let initialIndex;
  if (target === 'settings-bg') initialIndex = findPaletteIndexForColor(appSettings.bgColor);
  else if (target === 'settings-font-color') initialIndex = findPaletteIndexForColor(appSettings.fontColor);
  else initialIndex = getSelectionColorIndex();
  setActiveColorSwatch(initialIndex);
  positionColorPalette(anchor);
  setActiveColorSwatch(colorPaletteState.activeIndex, true);
  return true;
}

function closeColorPalette(opts = {}) {
  const palette = document.getElementById('color-palette');
  if (palette) palette.classList.add('hidden');
  colorPaletteState.open = false;
  colorPaletteState.target = 'selection';
  // Drop focus off whatever triggered us (toolbar color button or the
  // Settings entry) so Escape doesn't leave a focus-visible outline.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  // Esc / X return to the parent settings modal when that's where the
  // palette was opened from. Committing a swatch (`skipReturn: true`)
  // closes everything so the user can see the change land on the canvas.
  if (_colorPaletteReturnToSettings) {
    const shouldReturn = !opts.skipReturn;
    _colorPaletteReturnToSettings = false;
    if (shouldReturn) openSettings();
  }
}

function handleColorPaletteKey(e) {
  if (!colorPaletteState.open) return false;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    moveActiveColorSwatch(0, 1);
    return true;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    moveActiveColorSwatch(0, -1);
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveActiveColorSwatch(1, 0);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveActiveColorSwatch(-1, 0);
    return true;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    setActiveColorSwatch(0, true);
    return true;
  }
  if (e.key === 'End') {
    e.preventDefault();
    setActiveColorSwatch(getActivePalette().length - 1, true);
    return true;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    commitColorPalette(colorPaletteState.activeIndex);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeColorPalette();
    return true;
  }
  return false;
}

function setNodeColorData(node, color) {
  const meta = { ...(node.data('meta') || {}), color };
  node.data('meta', meta);
  node.data('color', color);
  if (!node.data('taskId') && pendingNode && node.id() === pendingNode.id()) {
    panelLoadedMeta = { ...panelLoadedMeta, color };
  }
}

function setEdgeColorData(edge, color) {
  const meta = { ...(edge.data('meta') || {}), color };
  edge.data('meta', meta);
  edge.data('color', color);
}

async function persistNodeColor(node, color) {
  const taskId = node.data('taskId');
  if (!taskId) return;

  let content;
  let base = null;
  if (String(editingTaskId) === String(taskId)) {
    const titleVal = document.getElementById('field-title').value.trim();
    if (!titleVal) throw new Error('Title required');
    const statusVal = document.getElementById('field-status').value;
    content = buildContent({ ...panelLoadedMeta, title: titleVal, status: statusVal, color }, readEditorBody());
    if (panelLoadedVersion !== null && panelLoadedContent !== null) {
      base = { version: panelLoadedVersion, content: panelLoadedContent };
    }
  } else {
    const taskRes = await fetch(`${apiBase()}/tasks/${taskId}`);
    if (!taskRes.ok) throw new Error('load failed');
    const task = await taskRes.json();
    const parsed = parseFrontmatter(task.content);
    content = buildContent({ ...(parsed.meta || {}), color }, parsed.body);
    base = task;
  }

  const res = await updateTask(taskId, content, base);
  if (!res.ok) {
    if (handleConflictStatus(res, 'task')) {
      await fetchGraph();
      return;
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Could not update color');
  }
  const saved = await res.json();
  updateGraphNode(saved);
  if (String(editingTaskId) === String(taskId)) {
    panelLoadedMeta = { ...panelLoadedMeta, color };
    panelLoadedVersion = saved.version ?? panelLoadedVersion;
    panelLoadedContent = saved.content ?? panelLoadedContent;
    lastSavedContent = content;
  }
}

// Upload a Blob/File via the graph-scoped uploads endpoint. Returns the
// parsed JSON ({id, url, content_type, byte_size}) on success, throws
// otherwise. Used by drag-drop on the canvas and by the Toast UI paste hook.
async function uploadImageFile(file) {
  if (!activeGraphId) throw new Error('no active graph');
  const r = await fetch(`/api/graphs/${encodeURIComponent(activeGraphId)}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.error || `upload failed (${r.status})`);
  }
  return r.json();
}

// Mirror of persistNodeColor for the background-image frontmatter key.
// Reads the panel's loaded base when the node is open (cheap, no extra GET)
// or fetches the task fresh otherwise. OCC fields are sent so a concurrent
// drag-position or color edit by anyone else still merges. Pass url=null
// to clear the image — the key is omitted from the new frontmatter so the
// human-write path (no agent protection) reads it as a removal.
async function persistNodeBackgroundImage(node, url) {
  const taskId = node.data('taskId');
  if (!taskId) return;
  const applyKey = (meta) => {
    const next = { ...meta };
    if (url === null) delete next['background-image'];
    else next['background-image'] = url;
    return next;
  };
  let content;
  let base = null;
  if (String(editingTaskId) === String(taskId)) {
    const titleVal = document.getElementById('field-title').value.trim();
    if (!titleVal) throw new Error('Title required');
    const statusVal = document.getElementById('field-status').value;
    content = buildContent(
      applyKey({ ...panelLoadedMeta, title: titleVal, status: statusVal }),
      readEditorBody(),
    );
    if (panelLoadedVersion !== null && panelLoadedContent !== null) {
      base = { version: panelLoadedVersion, content: panelLoadedContent };
    }
  } else {
    const taskRes = await fetch(`${apiBase()}/tasks/${taskId}`);
    if (!taskRes.ok) throw new Error('load failed');
    const task = await taskRes.json();
    const parsed = parseFrontmatter(task.content);
    content = buildContent(applyKey(parsed.meta || {}), parsed.body);
    base = task;
  }
  const res = await updateTask(taskId, content, base);
  if (!res.ok) {
    if (handleConflictStatus(res, 'task')) {
      await fetchGraph();
      return;
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Could not save image');
  }
  const saved = await res.json();
  updateGraphNode(saved);
  if (String(editingTaskId) === String(taskId)) {
    panelLoadedMeta = applyKey(panelLoadedMeta);
    panelLoadedVersion = saved.version ?? panelLoadedVersion;
    panelLoadedContent = saved.content ?? panelLoadedContent;
    lastSavedContent = content;
    syncBackgroundImageRow();
  }
}

async function persistEdgeColor(edge, color) {
  const res = await updateEdgeMeta(edge, { color });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Could not update color');
  }
  const saved = await res.json();
  const meta = saved.meta || {};
  edge.data('meta', meta);
  edge.data('color', meta.color || DEFAULT_EDGE_COLOR);
  if (typeof saved.version === 'number') edge.data('version', saved.version);
}

async function applySelectionColor(color) {
  const { nodes, edges } = getColorableSelection();
  if (nodes.length === 0 && edges.length === 0) return;

  nodes.forEach((node) => setNodeColorData(node, color));
  edges.forEach((edge) => setEdgeColorData(edge, color));

  try {
    for (const node of nodes) {
      await persistNodeColor(node, color);
    }
    for (const edge of edges) {
      await persistEdgeColor(edge, color);
    }
    showHint('Color updated');
  } catch (err) {
    showHint(err.message || 'Could not update color');
    await fetchGraph();
  } finally {
    updateToolbar();
  }
}

function commitColorPalette(index) {
  const color = getActivePalette()[index];
  if (!color) return;
  const target = colorPaletteState.target;
  closeColorPalette({ skipReturn: true });
  if (target === 'settings-bg') setSettingBgColor(color.value);
  else if (target === 'settings-font-color') setSettingFontColor(color.value);
  else applySelectionColor(color.value);
}

// --- Settings overlay (Cmd+K) ---
let settingsState = {
  open: false,
  mode: 'menu', // 'menu' | 'font'
  activeIndex: 0,
};

function settingsAnchorFromCmdBar() {
  // Capture the search bar's current rect so the palette can anchor to where
  // the cmd+K bar was, even after we close the settings overlay (which would
  // otherwise hide the element and zero out its rect).
  const search = document.getElementById('settings-search');
  if (!search) return null;
  const rect = search.getBoundingClientRect();
  return { getBoundingClientRect: () => rect };
}

function getSettingsItems() {
  if (settingsState.mode === 'font') {
    return [
      ...FONTS.map((f) => ({
        label: f.name,
        kbd: null,
        active: appSettings.font === f.id,
        previewStack: f.stack,
        onSelect: () => { setSettingFont(f.id); closeSettings(); },
      })),
      {
        label: 'Text color',
        kbd: 'C',
        colorDot: appSettings.fontColor,
        onSelect: () => {
          const anchor = settingsAnchorFromCmdBar();
          closeSettings();
          openColorPalette(anchor, 'settings-font-color');
        },
      },
    ];
  }
  // Theme sub-mode is intentionally unreachable from the menu while dark is
  // a work-in-progress. The case is kept so re-enabling the entry below is
  // a one-line change.
  if (settingsState.mode === 'theme') {
    return [
      { label: 'Light', kbd: null, active: appSettings.theme === 'light', onSelect: () => { setSettingTheme('light'); closeSettings(); } },
      { label: 'Dark',  kbd: null, active: appSettings.theme === 'dark',  onSelect: () => { setSettingTheme('dark');  closeSettings(); } },
    ];
  }
  const items = [
    // To re-enable theme switching, restore this entry:
    //   { label: 'Theme', kbd: 'T', onSelect: () => { settingsState.mode = 'theme'; settingsState.activeIndex = 0; clearSettingsSearch(); renderSettings(); } },
    {
      label: 'Font',
      kbd: 'F',
      previewStack: getFontStack(appSettings.font),
      onSelect: () => { settingsState.mode = 'font'; settingsState.activeIndex = 0; clearSettingsSearch(); renderSettings(); },
    },
    {
      label: 'Background',
      kbd: 'B',
      colorDot: appSettings.bgColor,
      onSelect: () => {
        const anchor = settingsAnchorFromCmdBar();
        closeSettings();
        openColorPalette(anchor, 'settings-bg');
      },
    },
  ];
  // Agent tokens are account-level — only show the entry when a user is
  // signed in. Anon viewers and AUTH_PROVIDER=none deployments don't have a
  // user row to attach tokens to.
  if (gtAuth.enabled && gtAuth.user) {
    items.push({
      label: 'Agents',
      kbd: 'A',
      onSelect: () => { closeSettings(); openAgentTokensModal({ fromSettings: true }); },
    });
    items.push({
      label: 'Sign out',
      kbd: null,
      danger: true,
      onSelect: async () => {
        closeSettings();
        try { await gtAuth.clerk.signOut(); } catch (err) { console.error('sign out failed', err); }
      },
    });
  }
  return items;
}

function getFilteredSettingsItems() {
  const search = document.getElementById('settings-search');
  const q = (search ? search.value : '').trim().toLowerCase();
  const items = getSettingsItems();
  if (!q) return items;
  return items.filter((it) => it.label.toLowerCase().includes(q));
}

function clearSettingsSearch() {
  const search = document.getElementById('settings-search');
  if (search) search.value = '';
}

function renderSettings() {
  const list = document.getElementById('settings-results');
  if (!list) return;
  list.innerHTML = '';
  const items = getFilteredSettingsItems();
  if (items.length === 0) {
    settingsState.activeIndex = 0;
    return;
  }
  if (settingsState.activeIndex >= items.length) settingsState.activeIndex = items.length - 1;
  if (settingsState.activeIndex < 0) settingsState.activeIndex = 0;
  items.forEach((it, idx) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-item'
      + (idx === settingsState.activeIndex ? ' active' : '')
      + (it.danger ? ' danger' : '');
    if (it.previewStack) row.style.fontFamily = it.previewStack;
    const label = document.createElement('span');
    label.textContent = it.label + (it.active ? ' ✓' : '');
    row.appendChild(label);
    const right = document.createElement('span');
    right.style.display = 'inline-flex';
    right.style.alignItems = 'center';
    right.style.gap = '8px';
    if (it.colorDot) {
      const dot = document.createElement('span');
      dot.className = 'settings-color-dot';
      dot.style.background = it.colorDot;
      right.appendChild(dot);
    }
    if (it.kbd) {
      const kbd = document.createElement('kbd');
      kbd.textContent = it.kbd;
      right.appendChild(kbd);
    }
    row.appendChild(right);
    row.addEventListener('click', () => it.onSelect());
    list.appendChild(row);
  });
}

function openSettings() {
  if (settingsState.open) return;
  closeColorPalette();
  settingsState.open = true;
  settingsState.mode = 'menu';
  settingsState.activeIndex = 0;
  document.getElementById('settings-overlay').classList.remove('hidden');
  clearSettingsSearch();
  renderSettings();
  // Default to hotkey mode: blur whatever was focused (panel input, gear
  // button, etc.) so document-level keydown captures hotkeys cleanly. The
  // search input stays unfocused until the user clicks it or presses '/'.
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
}

function closeSettings() {
  if (!settingsState.open) return;
  settingsState.open = false;
  document.getElementById('settings-overlay').classList.add('hidden');
  // Drop focus off whatever toolbar button triggered us (or off the search
  // input) so Escape doesn't leave a focus-visible outline behind.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function handleSettingsKey(e) {
  if (!settingsState.open) return false;
  const search = document.getElementById('settings-search');
  // Search mode = the input itself is focused. In that mode hotkey letters
  // type into the box (so the user can search for "Font") instead of jumping.
  const isSearching = e.target === search;
  const items = getFilteredSettingsItems();

  // Esc always closes the whole overlay, regardless of submode or focus —
  // matches how Esc behaves everywhere else in the app.
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSettings();
    return true;
  }
  // '/' toggles search mode in either direction so the user is never trapped
  // inside the input.
  if (e.key === '/') {
    e.preventDefault();
    if (isSearching) {
      search.blur();
      clearSettingsSearch();
      settingsState.activeIndex = 0;
      renderSettings();
    } else {
      search.focus();
    }
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length > 0) {
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      settingsState.activeIndex = (settingsState.activeIndex + delta + items.length) % items.length;
      renderSettings();
    }
    return true;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (items[settingsState.activeIndex]) items[settingsState.activeIndex].onSelect();
    return true;
  }
  // Hotkey jump (F/B/C) only when not in search mode.
  if (!isSearching && e.key.length === 1) {
    const k = e.key.toLowerCase();
    const match = items.find((it) => it.kbd && it.kbd.toLowerCase() === k);
    if (match) {
      e.preventDefault();
      match.onSelect();
      return true;
    }
  }
  return false;
}

// --- Panel ---
let panelLoadedMeta = {};
// Base for OCC three-way merge on PATCH: the version + content the panel
// last loaded from the server. Sent as `base_version` / `base_content` so
// the server can reconcile a concurrent edit instead of clobbering it.
// Refreshed on every load and after every successful save.
let panelLoadedVersion = null;
let panelLoadedContent = null;

function loadIntoEditor(content, task = null) {
  // richEditor.setMarkdown below fires a synthetic 'change' event, which
  // would normally schedule a save. That save would PATCH the task with
  // editor-roundtripped content (lossy whitespace), which fires a fresh
  // SSE event back to us — infinite loop / "double focus" bug. Suppress
  // scheduleSave for a brief window so the synthetic change is ignored
  // but real user edits a moment later still save normally.
  _editorSaveSuppressedUntil = Date.now() + 200;
  const { meta, body } = parseFrontmatter(content);
  panelLoadedMeta = meta;
  panelLoadedVersion = task && typeof task.version === 'number' ? task.version : null;
  panelLoadedContent = task && typeof task.content === 'string' ? task.content : null;
  document.getElementById('field-title').value = meta.title || '';
  document.getElementById('field-status').value = meta.status || 'todo';
  document.getElementById('raw-editor').value = body;
  if (richEditor) richEditor.setMarkdown(body, false);
  lastSavedContent = content;
  syncBackgroundImageRow();
}

// Reflect the current panelLoadedMeta['background-image'] in the panel's
// Background image row. Hides the row entirely until the task has a stable
// id (i.e. you've at least committed the new node) so we don't dangle an
// upload that the never-saved node won't reference.
function syncBackgroundImageRow() {
  const row = document.getElementById('bg-image-row');
  if (!row) return;
  if (editingTaskId == null) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  const fieldText = document.getElementById('bg-image-field-text');
  const clearBtn = document.getElementById('bg-image-clear');
  const url = panelLoadedMeta && panelLoadedMeta['background-image'];
  // The upload icon stays put in both states — it's a standing cue that you
  // can drag an image into this field, not a placeholder that an image replaces.
  if (url) {
    fieldText.textContent = displayNameFromBgUrl(url);
    fieldText.classList.remove('placeholder');
    clearBtn.classList.remove('hidden');
  } else {
    fieldText.textContent = 'Click or drag image here';
    fieldText.classList.add('placeholder');
    clearBtn.classList.add('hidden');
  }
}

// Pull the filename we stashed on the upload URL when it was set. The server
// ignores the `?name=` query string but it gives the panel something to show
// without persisting the filename in a separate frontmatter key. Falls back
// to a generic label for legacy or query-less URLs.
function displayNameFromBgUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url, window.location.origin);
    const name = u.searchParams.get('name');
    if (name) return name;
  } catch {}
  return 'Image';
}

function readEditorBody() {
  if (editorMode === 'raw') return document.getElementById('raw-editor').value;
  return richEditor ? richEditor.getMarkdown() : '';
}

function setEditorMode(next) {
  if (next === editorMode) return;
  const rich = document.getElementById('rich-editor');
  const raw = document.getElementById('raw-editor');
  const btnRich = document.getElementById('mode-rich');
  const btnRaw = document.getElementById('mode-raw');

  if (next === 'raw') {
    raw.value = richEditor ? richEditor.getMarkdown() : raw.value;
    rich.classList.add('hidden');
    raw.classList.remove('hidden');
    btnRich.classList.remove('active');
    btnRaw.classList.add('active');
    btnRich.setAttribute('aria-selected', 'false');
    btnRaw.setAttribute('aria-selected', 'true');
  } else {
    if (richEditor) richEditor.setMarkdown(raw.value);
    raw.classList.add('hidden');
    rich.classList.remove('hidden');
    btnRaw.classList.remove('active');
    btnRich.classList.add('active');
    btnRaw.setAttribute('aria-selected', 'false');
    btnRich.setAttribute('aria-selected', 'true');
  }
  editorMode = next;
}

// Pan the canvas so `node` lands at the center of the visible area
// (the part of the viewport NOT covered by the side panel).
function centerNodeInVisibleArea(node) {
  if (!node || node.empty()) return;
  const panel = document.getElementById('panel');
  const panelWidth = panel.classList.contains('hidden')
    ? 0
    : panel.getBoundingClientRect().width;
  // Use cy.width()/height() (cy container) rather than window.innerWidth so
  // the sidebar's width is excluded — node.renderedPosition() is also in
  // cy-container coords.
  const targetX = (cy.width() - panelWidth) / 2;
  const targetY = cy.height() / 2;
  const pos = node.renderedPosition();
  const dx = targetX - pos.x;
  const dy = targetY - pos.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  cy.animate({ panBy: { x: dx, y: dy } }, { duration: 220, easing: 'ease-out' });
}

function captureViewport() {
  if (!cy) return null;
  return {
    pan: { ...cy.pan() },
    zoom: cy.zoom(),
  };
}

function restoreViewport(snapshot) {
  if (!cy || !snapshot) return;
  cy.stop();
  cy.animate(
    { pan: snapshot.pan, zoom: snapshot.zoom },
    { duration: 220, easing: 'ease-out' }
  );
}

// Tracks whether the side panel was opened programmatically (by
// followAgentEdit, for example). When true, postLocalSelection treats the
// user as NOT actively editing — opening the panel passively to view an
// agent's edit shouldn't broadcast the local user as "selecting" that
// node. Reset on any user-initiated panel open or close.
let _panelOpenedProgrammatically = false;

function showPanel(task, opts = {}) {
  _panelOpenedProgrammatically = !!opts.programmatic;
  // `task` may be a Cytoscape node (graph view) OR a plain { taskId } object
  // (kanban view) — extract the id from whichever shape we got.
  const isCyNode = task && typeof task.data === 'function';
  const taskId = task ? (isCyNode ? task.data('taskId') : task.taskId) : null;
  editingTaskId = taskId;
  const panel = document.getElementById('panel');
  const title = document.getElementById('panel-title');
  const status = document.getElementById('save-status');
  if (status) { status.textContent = ''; status.dataset.kind = ''; status.classList.remove('saved-fade'); }

  if (task) {
    title.textContent = 'Edit Task';
    // `opts.preloaded` short-circuits the fetch when the caller already has
    // the task row in hand (kanban's "create + open" path) — avoids a stale
    // empty field-title flash before the fetch resolves.
    if (opts.preloaded) {
      loadIntoEditor(opts.preloaded.content, opts.preloaded);
    } else {
      fetch(`${apiBase()}/tasks/${editingTaskId}`)
        .then((r) => r.json())
        .then((full) => { loadIntoEditor(full.content, full); });
    }
  } else {
    title.textContent = 'New Task';
    loadIntoEditor('---\ntitle: \nstatus: todo\n---\n');
  }
  // Show the Delete footer only for existing tasks. A brand-new pending
  // node has nothing to delete server-side — backing out of the panel
  // discards it.
  const footer = panel.querySelector('.panel-footer');
  if (footer) footer.classList.toggle('hidden', !task);

  setEditorMode('rich');
  panel.classList.remove('hidden');
  if (typeof adjustPresenceBarOffset === 'function') adjustPresenceBarOffset();
  // Camera pan is graph-view only — kanban cards are already visible in their column.
  if (isCyNode) centerNodeInVisibleArea(task);
  // Kanban: shift the board left so the panel doesn't cover the selected
  // card's column. No-op for graph view, no-op if no overlap.
  if (typeof adjustKanbanForPanel === 'function') adjustKanbanForPanel();
  if (typeof postLocalSelection === 'function') postLocalSelection();
  // postLocalSelection is debounced 120ms; refresh the local "(You)" pill
  // immediately so opening the panel doesn't lag the editing-target swap.
  if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
  // Do NOT auto-focus a panel field — selection alone shouldn't redirect keystrokes.
  // The user enters edit mode by clicking into a field, or by double-clicking the node.
}

function hidePanel() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (typeof window.__flushSave === 'function') window.__flushSave();
  }
  const panel = document.getElementById('panel');
  const wasOpen = !panel.classList.contains('hidden');
  const panelWidth = wasOpen ? panel.getBoundingClientRect().width : 0;
  panel.classList.add('hidden');
  if (typeof adjustPresenceBarOffset === 'function') adjustPresenceBarOffset();
  // Note: deliberately does NOT clear .kb-card.selected. Mid-flight panel
  // hides (e.g. cmd-click that transitions 1→2 selected) would otherwise
  // wipe the multi-select. Esc-with-panel-open clears selection itself.
  // Reset the kanban shift now that the panel is gone.
  if (typeof adjustKanbanForPanel === 'function') adjustKanbanForPanel();
  if (typeof updateKanbanToolbar === 'function') updateKanbanToolbar();
  editingTaskId = null;
  _panelOpenedProgrammatically = false;
  if (typeof postLocalSelection === 'function') postLocalSelection();
  if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
  hideTitleOverlay();
  // If a ghost was never saved (no title), drop it now
  const hadGhost = !!(pendingNode && pendingNode.id() === '__pending__' && !pendingNode.removed());
  const viewportToRestore = hadGhost ? pendingViewportBeforeCreate : null;
  clearPendingEdgesForNewNode();
  if (hadGhost) pendingNode.remove();
  pendingNode = null;
  pendingPosition = null;
  pendingViewportBeforeCreate = null;
  if (hadGhost) updateToolbar();
  // Keep what was at the old visible-area center still at the new
  // (now-wider) visible-area center after the panel disappears.
  if (viewportToRestore) {
    restoreViewport(viewportToRestore);
  } else if (wasOpen && panelWidth > 0 && cy) {
    cy.animate({ panBy: { x: panelWidth / 2, y: 0 } }, { duration: 220, easing: 'ease-out' });
  }
}

function isPanelOpen() {
  return !document.getElementById('panel').classList.contains('hidden');
}

// --- Click-to-create flow ---
function getActiveNode() {
  if (pendingNode && !pendingNode.removed()) return pendingNode;
  if (editingTaskId) {
    const n = cy.getElementById(String(editingTaskId));
    if (n && !n.empty()) return n;
  }
  return null;
}

function showTitleOverlay() {
  const input = document.getElementById('node-title-overlay');
  const node = getActiveNode();
  if (!node) return;
  input.textContent = node.data('title') || '';
  input.classList.remove('hidden');
  node.addClass('editing');
  node.addClass('inline-title-edit');
  syncNodeToOverlay();
  positionTitleOverlay();
  // Defer focus so layout settles
  setTimeout(() => {
    input.focus();
    placeCaretAtEnd(input);
  }, 0);
}

function hideTitleOverlay() {
  const input = document.getElementById('node-title-overlay');
  input.classList.add('hidden');
  cy.nodes('.editing').forEach((n) => {
    n.removeClass('editing');
    n.removeClass('inline-title-edit');
    n.removeStyle('width');
    n.removeStyle('height');
  });
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Resize the active cytoscape node so its frame wraps the overlay content.
// Cytoscape only applies the stylesheet `padding` when width/height are
// 'label'-driven; explicit numeric width/height are taken as the total frame
// size. We add the padding manually so the node has the same breathing room
// it would have when not in edit mode.
//
// The overlay is HTML and lives in screen-pixel space; the cytoscape node
// lives in world-unit space. We scale the overlay's font-size and max-width
// with cy.zoom() so the overlay visually matches cytoscape's own label
// (which uses world-unit font-size and so scales naturally with zoom).
const NODE_EDIT_PAD = 28;        // matches cytoscape `padding: '14px'` × 2
const OVERLAY_BASE_FONT = 13;    // matches cytoscape node `font-size`
const OVERLAY_BASE_MAX_W = 140;  // matches cytoscape node `text-max-width`

function syncNodeToOverlay() {
  const input = document.getElementById('node-title-overlay');
  if (input.classList.contains('hidden')) return;
  const node = getActiveNode();
  if (!node) return;
  const z = cy.zoom();
  input.style.fontSize = (OVERLAY_BASE_FONT * z) + 'px';
  input.style.maxWidth = (OVERLAY_BASE_MAX_W * z) + 'px';
  const w = Math.max(60, input.offsetWidth / z) + NODE_EDIT_PAD;
  const h = Math.max(20, input.offsetHeight / z) + NODE_EDIT_PAD;
  node.style({ width: w, height: h });
}

function positionTitleOverlay() {
  const input = document.getElementById('node-title-overlay');
  if (input.classList.contains('hidden')) return;
  const node = getActiveNode();
  if (!node) return;
  const pos = node.renderedPosition();
  const rect = document.getElementById('cy').getBoundingClientRect();
  input.style.left = (rect.left + pos.x) + 'px';
  input.style.top = (rect.top + pos.y) + 'px';
}

function removePendingEdgePreviews(intent = pendingEdgesForNewNode) {
  if (!intent || !intent.previewEdges) return;
  intent.previewEdges.forEach((edge) => {
    if (edge && !edge.removed()) edge.remove();
  });
  intent.previewEdges = [];
}

function clearPendingEdgesForNewNode() {
  removePendingEdgePreviews();
  pendingEdgesForNewNode = null;
}

function cancelPendingNode() {
  const hadGhost = !!(pendingNode && pendingNode.id() === '__pending__' && !pendingNode.removed());
  const viewportToRestore = hadGhost ? pendingViewportBeforeCreate : null;
  clearPendingEdgesForNewNode();
  if (hadGhost) pendingNode.remove();
  pendingNode = null;
  pendingPosition = null;
  pendingViewportBeforeCreate = null;
  hideTitleOverlay();
  if (isPanelOpen() && !editingTaskId) {
    document.getElementById('panel').classList.add('hidden');
    if (typeof adjustPresenceBarOffset === 'function') adjustPresenceBarOffset();
  }
  if (viewportToRestore) restoreViewport(viewportToRestore);
  if (hadGhost) updateToolbar();
}

async function startEditingNode(node) {
  cancelPendingNode();
  cy.nodes().not(node).removeClass('selected');
  cy.edges().removeClass('selected');
  node.addClass('selected');

  pendingNode = node;
  pendingPosition = node.position();
  editingTaskId = node.data('taskId');

  // Always refetch so panelLoadedMeta and the body editor have current content
  // (autosave reconstructs the full markdown on every keystroke).
  try {
    const res = await fetch(`${apiBase()}/tasks/${editingTaskId}`);
    const full = await res.json();
    loadIntoEditor(full.content, full);
  } catch (err) {
    console.error('Failed to load task for editing:', err);
    return;
  }

  showTitleOverlay();
  updateToolbar();
}

async function createNodeAt(pos, options = {}) {
  // First click on a fresh install lazily creates a graph so the user
  // can start sketching tasks immediately.
  await ensureActiveGraph();
  cancelPendingNode();
  pendingViewportBeforeCreate = captureViewport();
  // Clear any prior selection so the new node is the only one selected
  cy.nodes().removeClass('selected');
  cy.edges().removeClass('selected');

  pendingPosition = { x: pos.x, y: pos.y };
  const ghost = cy.add({
    group: 'nodes',
    data: {
      id: '__pending__',
      taskId: null,
      title: '',
      description: '',
      status: 'todo',
      color: DEFAULT_NODE_COLOR,
      meta: { status: 'todo', x: pos.x, y: pos.y },
    },
  });
  ghost.position(pos);
  ghost.addClass('selected');
  pendingNode = ghost;

  // Open the panel in "new task" mode with x/y seeded into frontmatter
  editingTaskId = null;
  panelLoadedMeta = {};
  const panel = document.getElementById('panel');
  document.getElementById('panel-title').textContent = 'New Task';
  const status = document.getElementById('save-status');
  if (status) {
    status.textContent = '';
    status.dataset.kind = '';
    status.classList.remove('saved-fade');
  }
  loadIntoEditor(`---\ntitle: \nstatus: todo\nx: ${pos.x}\ny: ${pos.y}\n---\n`);
  setEditorMode('rich');
  panel.classList.remove('hidden');
  if (typeof adjustPresenceBarOffset === 'function') adjustPresenceBarOffset();
  if (resolveNodeOverlap(ghost)) {
    const fp = ghost.position();
    pendingPosition = fp;
    panelLoadedMeta.x = fp.x;
    panelLoadedMeta.y = fp.y;
  }
  if (options.edgeIntent) {
    attachPendingEdgesToNewNode(ghost, options.edgeIntent);
  }
  centerNodeInVisibleArea(ghost);

  showTitleOverlay();
  updateToolbar();
}

function attachPendingEdgesToNewNode(ghost, edgeIntent) {
  const sources = (edgeIntent.sources || [])
    .map((source) => {
      if (source && typeof source.data === 'function') {
        return { nodeId: source.id(), taskId: source.data('taskId') };
      }
      return source;
    })
    .filter((source) => source && source.nodeId && source.taskId);
  if (sources.length === 0) return;
  pendingEdgesForNewNode = {
    sources,
    direction: edgeIntent.direction || 'forward',
    previewEdges: [],
  };
  rebuildPendingNewNodePreviewEdges(ghost);
}

function rebuildPendingNewNodePreviewEdges(ghost = pendingNode) {
  if (!pendingEdgesForNewNode || !ghost || ghost.removed()) return;
  removePendingEdgePreviews(pendingEdgesForNewNode);
  const { sources, direction } = pendingEdgesForNewNode;
  const isRelated = direction === 'related';
  pendingEdgesForNewNode.previewEdges = sources.map((sourceInfo, idx) => {
    const source = cy.getElementById(String(sourceInfo.nodeId));
    if (!source || source.empty()) return null;
    const fromId = direction === 'backward' ? ghost.id() : source.id();
    const toId = direction === 'backward' ? source.id() : ghost.id();
    return cy.add({
      group: 'edges',
      data: {
        id: `__pending_edge_${idx}__`,
        source: fromId,
        target: toId,
        edgeType: isRelated ? 'related' : 'dependency',
        color: DEFAULT_EDGE_COLOR,
        curveDistance: 0,
        curveWeight: 0.5,
        meta: {},
      },
      classes: 'preview',
    });
  }).filter(Boolean);
}

async function createPendingEdgesForSavedNode(newTaskId, intent) {
  if (!intent) return;
  const isRelated = intent.direction === 'related';
  let created = 0;
  const failures = [];
  for (const source of intent.sources) {
    const sourceTaskId = source.taskId;
    if (!sourceTaskId || String(sourceTaskId) === String(newTaskId)) continue;
    const fromId = intent.direction === 'backward' ? newTaskId : sourceTaskId;
    const toId = intent.direction === 'backward' ? sourceTaskId : newTaskId;
    const res = await createEdge(fromId, toId, isRelated ? 'related' : 'dependency');
    if (res.ok) {
      created += 1;
      addGraphEdge(await res.json());
    } else {
      const err = await res.json().catch(() => ({}));
      failures.push(err.error || 'Could not create edge');
    }
  }
  if (failures.length > 0) {
    showHint(created > 0
      ? `Created ${created}, skipped ${failures.length}`
      : failures[0]);
  } else if (created > 1) {
    showHint(`Created ${created} edges`);
  }
}

// --- Edge creation ---
// Active when the user has hit "E" (or the Connect button) with one or more
// nodes selected. We add a phantom node that tracks the cursor and preview
// edges from the selected sources to the phantom; clicking a real node commits.
let edgeCreation = null;

function startEdgeCreation() {
  if (edgeCreation) return;
  if (isReadOnly() || accessDenied) return;
  const sources = cy.nodes('.selected')
    .filter((n) => n.id() !== '__pending__' && n.data('taskId'))
    .toArray();
  if (sources.length === 0) return;
  if (isPanelOpen()) hidePanel();

  const center = sources.reduce((acc, source) => {
    const pos = source.position();
    return { x: acc.x + pos.x, y: acc.y + pos.y };
  }, { x: 0, y: 0 });
  center.x /= sources.length;
  center.y /= sources.length;

  const phantom = cy.add({
    group: 'nodes',
    data: { id: '__edge_target__' },
    classes: 'phantom',
    position: center,
  });
  edgeCreation = { sources, phantom, direction: 'forward', previewEdges: [] };
  rebuildPreviewEdge();
  document.addEventListener('mousemove', onEdgeCreationMouseMove);
  updateToolbar();
}

function cancelEdgeCreation() {
  if (!edgeCreation) return;
  const previewEdges = edgeCreation.previewEdges || [edgeCreation.previewEdge].filter(Boolean);
  previewEdges.forEach((edge) => {
    if (edge && !edge.removed()) edge.remove();
  });
  if (edgeCreation.phantom && !edgeCreation.phantom.removed()) {
    edgeCreation.phantom.remove();
  }
  cy.nodes('.edge-hover-target').removeClass('edge-hover-target');
  document.removeEventListener('mousemove', onEdgeCreationMouseMove);
  edgeCreation = null;
  updateToolbar();
}

function createPendingNodeFromEdgeCreation(pos) {
  if (!edgeCreation) return;
  const sources = (edgeCreation.sources || [edgeCreation.source])
    .filter((source) => source && !source.removed() && source.data('taskId'));
  const direction = edgeCreation.direction;
  cancelEdgeCreation();
  createNodeAt(pos, { edgeIntent: { sources, direction } });
}

async function commitEdgeCreation(targetNode) {
  if (!edgeCreation) return;
  if (!targetNode || targetNode.empty()) return;
  if (!targetNode.data('taskId')) return;
  const sources = (edgeCreation.sources || [edgeCreation.source])
    .filter((source) => source && !source.removed() && source.data('taskId') && source.id() !== targetNode.id());
  if (sources.length === 0) {
    cancelEdgeCreation();
    return;
  }
  const { direction } = edgeCreation;
  const isRelated = direction === 'related';
  const targetTaskId = targetNode.data('taskId');
  cancelEdgeCreation();
  let created = 0;
  const failures = [];
  try {
    for (const source of sources) {
      const sourceTaskId = source.data('taskId');
      const fromId = direction === 'backward' ? targetTaskId : sourceTaskId;
      const toId = direction === 'backward' ? sourceTaskId : targetTaskId;
      const res = await createEdge(fromId, toId, isRelated ? 'related' : 'dependency');
      if (res.ok) {
        created += 1;
      } else {
        const err = await res.json().catch(() => ({}));
        failures.push(err.error || 'Could not create edge');
      }
    }
    if (created > 0) await fetchGraph();
    if (failures.length > 0) {
      showHint(created > 0
        ? `Created ${created}, skipped ${failures.length}`
        : failures[0]);
    } else if (created > 1) {
      showHint(`Created ${created} edges`);
    }
  } catch {
    showHint('Could not create edges');
  }
}

// Cycle order for the in-progress edge: forward → related → backward → forward
const EDGE_DIRECTION_ORDER = ['forward', 'related', 'backward'];

function cycleEdgeCreationDirection() {
  if (!edgeCreation) return;
  const idx = EDGE_DIRECTION_ORDER.indexOf(edgeCreation.direction);
  edgeCreation.direction = EDGE_DIRECTION_ORDER[(idx + 1) % EDGE_DIRECTION_ORDER.length];
  rebuildPreviewEdge();
  updateToolbar();
}

function rebuildPreviewEdge() {
  if (!edgeCreation) return;
  const { phantom, direction } = edgeCreation;
  const sources = edgeCreation.sources || [edgeCreation.source].filter(Boolean);
  const previewEdges = edgeCreation.previewEdges || [edgeCreation.previewEdge].filter(Boolean);
  previewEdges.forEach((edge) => {
    if (edge && !edge.removed()) edge.remove();
  });
  const isRelated = direction === 'related';
  edgeCreation.previewEdges = sources.map((source, idx) => {
    const fromId = direction === 'backward' ? phantom.id() : source.id();
    const toId = direction === 'backward' ? source.id() : phantom.id();
    return cy.add({
      group: 'edges',
      data: {
        id: `__preview_edge_${idx}__`,
        source: fromId,
        target: toId,
        edgeType: isRelated ? 'related' : 'dependency',
        color: DEFAULT_EDGE_COLOR,
        curveDistance: 0,
        curveWeight: 0.5,
        meta: {},
      },
      classes: 'preview',
    });
  });
}

function onEdgeCreationMouseMove(e) {
  if (!edgeCreation || !edgeCreation.phantom) return;
  const cyRect = document.getElementById('cy').getBoundingClientRect();
  const x = e.clientX - cyRect.left;
  const y = e.clientY - cyRect.top;
  const z = cy.zoom();
  const pan = cy.pan();
  edgeCreation.phantom.position({
    x: (x - pan.x) / z,
    y: (y - pan.y) / z,
  });
}

// --- Existing-edge type editing ---
// When the user selects an edge and presses E, we cycle its direction/type
// optimistically (visual updates immediately). The change isn't persisted
// until the user presses Enter; Esc or moving focus elsewhere reverts it.
let edgeTypeEditing = null;

function cycleSelectedEdgeType() {
  const selectedEdges = cy.edges('.selected').filter((e) => !e.id().startsWith('__'));
  if (selectedEdges.length !== 1) return;
  const edge = selectedEdges[0];

  // Switching to a different edge → revert the previous edit first
  if (edgeTypeEditing && edgeTypeEditing.edgeId !== edge.id()) {
    cancelEdgeTypeEdit();
  }
  if (!edgeTypeEditing) {
    const type = edge.data('edgeType');
    edge.addClass('edge-type-editing');
    edgeTypeEditing = {
      edge,
      edgeId: edge.id(),
      originalType: type,
      originalSourceTaskId: edge.source().data('taskId'),
      originalTargetTaskId: edge.target().data('taskId'),
      currentDirection: type === 'related' ? 'related' : 'forward',
    };
  }
  // forward → related → backward → forward
  const idx = EDGE_DIRECTION_ORDER.indexOf(edgeTypeEditing.currentDirection);
  edgeTypeEditing.currentDirection =
    EDGE_DIRECTION_ORDER[(idx + 1) % EDGE_DIRECTION_ORDER.length];
  applyEdgeTypeVisual();
  updateToolbar();
}

function applyEdgeTypeVisual() {
  if (!edgeTypeEditing) return;
  const { edge, currentDirection } = edgeTypeEditing;
  edge.removeClass('dir-backward');
  edge.addClass('edge-type-editing');
  if (currentDirection === 'related') {
    edge.data('edgeType', 'related');
  } else if (currentDirection === 'backward') {
    edge.data('edgeType', 'dependency');
    edge.addClass('dir-backward');
  } else {
    edge.data('edgeType', 'dependency');
  }
}

async function commitEdgeTypeEdit() {
  if (!edgeTypeEditing) return;
  const state = edgeTypeEditing;
  edgeTypeEditing = null;

  const { edge, edgeId, originalType, originalSourceTaskId, originalTargetTaskId, currentDirection } = state;
  const isRelated = currentDirection === 'related';
  const isBackward = currentDirection === 'backward';
  const newType = isRelated ? 'related' : 'dependency';
  const newSourceId = isBackward ? originalTargetTaskId : originalSourceTaskId;
  const newTargetId = isBackward ? originalSourceTaskId : originalTargetTaskId;

  // Nothing actually changed
  if (!isBackward && newType === originalType) {
    if (edge && !edge.removed()) {
      edge.removeClass('edge-type-editing');
      edge.removeClass('dir-backward');
      edge.data('edgeType', originalType);
    }
    updateToolbar();
    return;
  }

  if (edge && !edge.removed()) edge.removeClass('edge-type-editing');
  const rawId = String(edgeId).replace(/^e/, '');
  try {
    const baseRow = edge && !edge.removed() ? edgeBaseRow(edge) : null;
    const res = await patchWithRetry(
      `${apiBase()}/edges/${rawId}`,
      (base) => {
        const body = { source_id: newSourceId, target_id: newTargetId, type: newType };
        if (base) {
          body.base_row = base;
          body.base_version = base.version;
        }
        return body;
      },
      baseRow,
      'edge',
    );
    if (!res.ok) {
      if (!handleConflictStatus(res, 'edge')) {
        const err = await res.json().catch(() => ({}));
        showHint(err.error || 'Could not update edge');
      }
      await fetchGraph();
      return;
    }
    showHint('Edge type changed');
    await fetchGraph();
  } catch {
    showHint('Could not update edge');
    await fetchGraph();
  }
}

// Reverts the optimistic visual back to the original type and discards the edit
function cancelEdgeTypeEdit() {
  if (!edgeTypeEditing) return;
  const { edge, originalType } = edgeTypeEditing;
  if (edge && !edge.removed()) {
    edge.removeClass('edge-type-editing');
    edge.removeClass('dir-backward');
    edge.data('edgeType', originalType);
  }
  edgeTypeEditing = null;
  updateToolbar();
}

// --- Existing-node status editing ---
// S cycles a selected node's status optimistically. Enter persists it; Esc or
// changing selection restores the original status.
let statusEditing = null;

function statusClass(status) {
  return `status-editing-${status}`;
}

function clearStatusEditClasses(node) {
  node.removeClass('status-editing');
  STATUS_ORDER.forEach((status) => node.removeClass(statusClass(status)));
}

function cycleSelectedNodeStatus() {
  const selectedNodes = cy.nodes('.selected').filter((n) => n.id() !== '__pending__' && n.data('taskId'));
  if (selectedNodes.length !== 1) return;
  const node = selectedNodes[0];

  if (statusEditing && statusEditing.nodeId !== node.id()) {
    cancelStatusEdit();
  }
  if (!statusEditing) {
    const status = node.data('status') || 'todo';
    statusEditing = {
      node,
      nodeId: node.id(),
      taskId: node.data('taskId'),
      originalStatus: status,
      currentStatus: status,
    };
  }

  const idx = STATUS_ORDER.indexOf(statusEditing.currentStatus);
  const nextIdx = idx === -1 ? 0 : (idx + 1) % STATUS_ORDER.length;
  statusEditing.currentStatus = STATUS_ORDER[nextIdx];
  applyStatusVisual();
  updateToolbar();
}

function applyStatusVisual() {
  if (!statusEditing) return;
  const { node, currentStatus } = statusEditing;
  if (!node || node.removed()) return;
  clearStatusEditClasses(node);
  node.data('status', currentStatus);
  node.addClass('status-editing');
  node.addClass(statusClass(currentStatus));
}

async function commitStatusEdit() {
  if (!statusEditing) return;
  const state = statusEditing;
  statusEditing = null;

  const { node, taskId, originalStatus, currentStatus } = state;
  if (node && !node.removed()) clearStatusEditClasses(node);

  if (currentStatus === originalStatus) {
    updateToolbar();
    return;
  }

  try {
    let content;
    let base = null;
    if (String(editingTaskId) === String(taskId)) {
      const titleVal = document.getElementById('field-title').value.trim();
      if (!titleVal) {
        showHint('Title required');
        if (node && !node.removed()) node.data('status', originalStatus);
        updateToolbar();
        return;
      }
      const meta = { ...panelLoadedMeta, title: titleVal, status: currentStatus };
      content = buildContent(meta, readEditorBody());
      if (panelLoadedVersion !== null && panelLoadedContent !== null) {
        base = { version: panelLoadedVersion, content: panelLoadedContent };
      }
    } else {
      const taskRes = await fetch(`${apiBase()}/tasks/${taskId}`);
      if (!taskRes.ok) throw new Error('fetch failed');
      const task = await taskRes.json();
      const parsed = parseFrontmatter(task.content);
      const meta = { ...(parsed.meta || {}), status: currentStatus };
      content = buildContent(meta, parsed.body);
      base = task;
    }

    const res = await updateTask(taskId, content, base);
    if (!res.ok) {
      if (!handleConflictStatus(res, 'task')) {
        const err = await res.json().catch(() => ({}));
        showHint(err.error || 'Could not update status');
      }
      if (node && !node.removed()) node.data('status', originalStatus);
      await fetchGraph();
      return;
    }
    const saved = await res.json();
    updateGraphNode(saved);
    if (String(editingTaskId) === String(taskId)) {
      const statusField = document.getElementById('field-status');
      statusField.value = currentStatus;
      panelLoadedMeta = { ...panelLoadedMeta, status: currentStatus };
      panelLoadedVersion = saved.version ?? panelLoadedVersion;
      panelLoadedContent = saved.content ?? panelLoadedContent;
      lastSavedContent = content;
    }
    showHint(`Status: ${STATUS_LABELS[currentStatus]}`);
    await updateLeafHighlights();
    updateToolbar();
  } catch {
    showHint('Could not update status');
    if (node && !node.removed()) node.data('status', originalStatus);
    await fetchGraph();
  }
}

function cancelStatusEdit() {
  if (!statusEditing) return;
  const { node, originalStatus } = statusEditing;
  if (node && !node.removed()) {
    clearStatusEditClasses(node);
    node.data('status', originalStatus);
  }
  statusEditing = null;
  updateToolbar();
}

// Create a new node at the world position corresponding to the center of
// the currently visible canvas area (viewport minus the side panel, if any).
// Overlap resolution + re-centering happens inside createNodeAt.
function createNodeAtCenter() {
  const panel = document.getElementById('panel');
  const panelWidth = panel.classList.contains('hidden')
    ? 0
    : panel.getBoundingClientRect().width;
  // cy.width()/height() are the cy container's size (already excludes the
  // sidebar); pan() is in cy-container coords, so screenX/Y must be too.
  const screenX = (cy.width() - panelWidth) / 2;
  const screenY = cy.height() / 2;
  const z = cy.zoom();
  const pan = cy.pan();
  createNodeAt({ x: (screenX - pan.x) / z, y: (screenY - pan.y) / z });
}

// Map a non-OK write response to a user-facing toast for the two OCC
// outcomes the server can return: 409 version_conflict (concurrent write
// occurred and the server couldn't auto-merge) and 410 Gone (row was
// deleted while we were editing). Returns true if the status was handled
// here, false to let the caller fall back to a generic failure message.
// Callers should refetch graph state after a true return.
function handleConflictStatus(res, label = 'item') {
  if (res.status === 410) {
    showHint(`This ${label} was deleted elsewhere`);
    return true;
  }
  if (res.status === 409) {
    showHint(`${label} changed elsewhere — refreshing`);
    return true;
  }
  return false;
}

// Snapshot helpers — produce the `base_row` the server uses to do a
// three-way merge against concurrent writes. Values come from local state
// (cytoscape data for edges, currentGraph / the closure's `graph` for
// graphs) so they reflect what the user was looking at when they made
// the edit.
function edgeBaseRow(edge) {
  if (!edge || edge.removed()) return null;
  const v = edge.data('version');
  return {
    source_id: parseInt(edge.data('source'), 10),
    target_id: parseInt(edge.data('target'), 10),
    type: edge.data('edgeType'),
    meta: edge.data('meta') || {},
    version: typeof v === 'number' ? v : 0,
  };
}
function graphBaseRow(graph) {
  if (!graph) return null;
  return {
    name: graph.name,
    description: graph.description ?? null,
    settings: graph.settings || {},
    anon_role: graph.anon_role || 'none',
    version: typeof graph.version === 'number' ? graph.version : 0,
  };
}

// Defensive 409 retry: server resolves disjoint cases itself, so this only
// fires when the merge can't be auto-resolved (e.g. validation fails on the
// merged result). Retry once with the server-supplied `current` as the new
// base — if THAT still 409s, surface the toast.
async function patchWithRetry(url, buildBody, baseRow, label = 'item') {
  let res = await fetch(url, {
    method: 'PATCH',
    headers: writeHeaders(),
    body: JSON.stringify(buildBody(baseRow)),
  });
  if (res.status !== 409) return res;
  const cloned = res.clone();
  let body;
  try { body = await cloned.json(); } catch { return res; }
  if (body?.error !== 'version_conflict' || !body.current) return res;
  const freshBase = { ...body.current, version: body.current.version };
  const retry = await fetch(url, {
    method: 'PATCH',
    headers: writeHeaders(),
    body: JSON.stringify(buildBody(freshBase)),
  });
  return retry;
}

// --- API calls ---
async function createTask(content) {
  return fetch(`${apiBase()}/tasks`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({ content }),
  });
}

// Kanban-only: create a stub task in the given status column. B2 renders
// the card; B5 wires SSE so the new card appears live in this and any
// other kanban-view tab. For now the new task is "Untitled" — the user
// renames via the inspector once B3 wires card-click → panel.
const KANBAN_STATUSES = ['todo', 'in_progress', 'review', 'done'];
async function createKanbanTask(status) {
  if (!activeGraphId) return;
  if (!KANBAN_STATUSES.includes(status)) return;
  const content = `---\ntitle: Untitled\nstatus: ${status}\n---\n`;
  const res = await createTask(content);
  if (!res.ok) {
    if (maybeForbid(res)) return;
    showHint('Create failed');
    return;
  }
  const saved = await res.json();
  // Re-render kanban so the new card lands in DOM before we try to select it.
  // Awaited (not fire-and-forget) so the .selected paint + panel-open happen
  // against the new card, not the pre-create render.
  await fetchGraph().catch(() => {});
  if (!saved || saved.id == null) return;
  const card = document.querySelector(`.kb-card[data-task-id="${saved.id}"]`);
  if (card) {
    document.querySelectorAll('.kb-card.selected').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    updateKanbanToolbar();
  }
  // Open the inspector preloaded — avoids the title-flash from showPanel's
  // own fetch — then focus + select the title input so the user's first
  // keystroke replaces "Untitled" (deferred to next tick so loadIntoEditor
  // has populated the field).
  showPanel({ taskId: saved.id }, { preloaded: saved });
  setTimeout(() => {
    const fld = document.getElementById('field-title');
    if (fld) { fld.focus(); fld.select(); }
  }, 0);
}

// Strip frontmatter and pull the first non-empty body line as a card
// excerpt. Returns '' if no body — caller suppresses the excerpt element.
function extractBodyExcerpt(content) {
  if (typeof content !== 'string') return '';
  const m = content.match(/^---\n[\s\S]*?\n---\n?/);
  const body = m ? content.slice(m[0].length) : content;
  const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
}

function renderKanbanCard(task) {
  const card = document.createElement('div');
  card.className = 'kb-card';
  card.draggable = true;
  card.dataset.taskId = String(task.id);
  const meta = task.meta || {};
  if (meta.color) card.style.setProperty('--card-color', meta.color);

  const titleEl = document.createElement('div');
  titleEl.className = 'kb-card-title';
  titleEl.textContent = meta.title || 'Untitled';
  card.appendChild(titleEl);

  const excerpt = extractBodyExcerpt(task.content);
  if (excerpt) {
    const excerptEl = document.createElement('div');
    excerptEl.className = 'kb-card-excerpt';
    excerptEl.textContent = excerpt;
    card.appendChild(excerptEl);
  }
  return card;
}

// Pulse the card's background in the destination status's light-tier color
// for ~800ms. Mirrors the graph-view "what just changed" flash convention
// (orange = in_progress, yellow = review, green = done, neutral = todo).
function flashKanbanCard(card, status) {
  if (!card) return;
  const cls = `kb-flash-${status}`;
  // Restart the animation if the same class is already there (rapid moves).
  card.classList.remove(cls);
  void card.offsetWidth; // force reflow so the next add re-triggers the animation
  card.classList.add(cls);
  setTimeout(() => card.classList.remove(cls), 850);
}

// Queue actions for the next renderKanban. Two parallel queues:
//   - flash: both own-origin (drag commit) and remote-origin (SSE) writes.
//     Every change deserves a flash to draw attention.
//   - scroll: remote-origin only. Own drags don't scroll — the user just
//     placed the card and knows where it is.
// Set-based so own + SSE double-queue dedupes naturally.
const _kanbanFlashQueue = new Set();
const _kanbanScrollQueue = new Set();
function queueKanbanFlash(taskId) {
  if (taskId == null) return;
  _kanbanFlashQueue.add(String(taskId));
}
function queueKanbanScrollIntoView(taskId) {
  if (taskId == null) return;
  _kanbanScrollQueue.add(String(taskId));
}
function applyKanbanPendingFlashes() {
  if (_kanbanFlashQueue.size === 0 && _kanbanScrollQueue.size === 0) return;
  const userActive = typeof userInteractedRecently === 'function' && userInteractedRecently();
  for (const taskId of _kanbanFlashQueue) {
    const card = document.querySelector(`.kb-card[data-task-id="${taskId}"]`);
    if (!card) continue;
    const col = card.closest('.kb-column');
    const status = col && col.dataset.status;
    if (status) flashKanbanCard(card, status);
    if (_kanbanScrollQueue.has(taskId) && !userActive) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }
  _kanbanFlashQueue.clear();
  _kanbanScrollQueue.clear();
}

// Delete the task currently open in the side panel. Works in both views;
// graph view's cy node disappears via fetchGraph, kanban's card via
// renderKanban (re-fetch). Same confirm modal as the bulk-select path.
async function deletePanelTask() {
  if (editingTaskId == null) return;
  if (!document.getElementById('delete-modal').classList.contains('hidden')) return;
  if (!(await confirmDelete('Delete this task?'))) return;
  const id = editingTaskId;
  await deleteTask(id);
  hidePanel();
  await fetchGraph().catch(() => {});
}

// Toolbar slot management for kanban. When at least one card is selected,
// show tb-kanban-selection (count + Delete) and hide tb-neutral; otherwise
// the reverse. Also force-hide cy-only slots that may have been left visible
// when switching out of graph view.
function updateKanbanToolbar() {
  if (currentView !== 'kanban') {
    // Make sure the kanban-specific slot stays hidden in graph view.
    const slot = document.getElementById('tb-kanban-selection');
    if (slot) slot.classList.add('hidden');
    return;
  }
  ['tb-mixed', 'tb-node', 'tb-edge', 'tb-edge-creating'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const selCount = document.querySelectorAll('.kb-card.selected').length;
  const slot = document.getElementById('tb-kanban-selection');
  const neutral = document.getElementById('tb-neutral');
  if (selCount > 0) {
    if (slot) {
      slot.classList.remove('hidden');
      const c = document.getElementById('tb-kanban-selection-count');
      if (c) c.textContent = String(selCount);
    }
    if (neutral) neutral.classList.add('hidden');
  } else {
    if (slot) slot.classList.add('hidden');
    if (neutral) neutral.classList.remove('hidden');
  }
}

// Delete every selected kanban card after a confirm. Same modal as graph
// view's deleteSelected. Sequential deletes (small N; matches graph path).
async function deleteSelectedKanbanCards() {
  if (currentView !== 'kanban') return;
  if (!document.getElementById('delete-modal').classList.contains('hidden')) return;
  const cards = Array.from(document.querySelectorAll('.kb-card.selected'));
  const taskIds = cards.map((c) => Number(c.dataset.taskId)).filter(Number.isFinite);
  if (taskIds.length === 0) return;
  const word = taskIds.length === 1 ? 'task' : 'tasks';
  if (!(await confirmDelete(`Delete ${taskIds.length} ${word}?`))) return;
  for (const id of taskIds) {
    await deleteTask(id);
  }
  if (isPanelOpen()) hidePanel();
  await fetchGraph().catch(() => {});
  updateKanbanToolbar();
}

// Drag-and-drop: optimistic DOM move + OCC PATCH on the task's status.
// Same-status drop is a no-op. Failure rolls back via renderKanban().
async function moveKanbanCardToStatus(taskId, newStatus) {
  if (!KANBAN_STATUSES.includes(newStatus)) return;
  const card = document.querySelector(`.kb-card[data-task-id="${taskId}"]`);
  if (!card) return;
  const sourceContainer = card.parentElement;
  const sourceColumn = sourceContainer ? sourceContainer.closest('.kb-column') : null;
  const sourceStatus = sourceColumn ? sourceColumn.dataset.status : null;
  if (!sourceStatus || sourceStatus === newStatus) return;

  const dest = document.getElementById(`kb-cards-${newStatus}`);
  if (!dest) return;
  dest.prepend(card);
  // Update column counts inline; full renderKanban will reconcile on next refresh.
  for (const s of KANBAN_STATUSES) {
    const container = document.getElementById(`kb-cards-${s}`);
    const count = document.getElementById(`kb-count-${s}`);
    if (container && count) count.textContent = String(container.children.length);
  }

  try {
    const res = await fetch(`${apiBase()}/tasks/${taskId}`);
    if (!res.ok) throw new Error('load');
    const task = await res.json();
    const parsed = parseFrontmatter(task.content);
    const newContent = buildContent({ ...(parsed.meta || {}), status: newStatus }, parsed.body);
    const upd = await updateTask(taskId, newContent, task);
    if (!upd.ok) {
      if (maybeForbid(upd)) { renderKanban(); return; }
      throw new Error('save');
    }
    // Flash on the next renderKanban (which the SSE event will trigger).
    // Direct flashKanbanCard here would be wiped by that re-render anyway.
    queueKanbanFlash(taskId);
  } catch {
    showHint('Status change failed');
    renderKanban();
  }
}

// Render task cards into their status columns. Called from fetchGraph
// success and (later) from applyView when switching into kanban. No-op
// when not in kanban view — keeps the render cost off graph-view users.
// Uses /tasks (not /graph) because /graph omits content + updated_at,
// both needed here (excerpt + sort).
async function renderKanban() {
  if (currentView !== 'kanban') return;
  if (!activeGraphId) return;
  // Snapshot local selection before the DOM replace wipes it.
  const preservedSelection = new Set(
    Array.from(document.querySelectorAll('.kb-card.selected')).map((c) => c.dataset.taskId)
  );
  let tasks;
  try {
    const res = await fetch(`${apiBase()}/tasks`);
    if (!res.ok) return;
    tasks = await res.json();
  } catch { return; }

  const buckets = { todo: [], in_progress: [], review: [], done: [] };
  for (const t of tasks) {
    const s = (t.meta && t.meta.status) || 'todo';
    (buckets[s] || buckets.todo).push(t);
  }
  for (const s of KANBAN_STATUSES) {
    buckets[s].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    const container = document.getElementById(`kb-cards-${s}`);
    const count = document.getElementById(`kb-count-${s}`);
    if (container) {
      container.replaceChildren(...buckets[s].map(renderKanbanCard));
    }
    if (count) count.textContent = String(buckets[s].length);
  }
  // Restore local selection on the freshly-rendered cards. Tasks that were
  // deleted between renders just drop out of the set naturally.
  for (const id of preservedSelection) {
    const card = document.querySelector(`.kb-card[data-task-id="${id}"]`);
    if (card) card.classList.add('selected');
  }
  // Apply any flashes queued before this re-render (drag commits, SSE events).
  applyKanbanPendingFlashes();
  // The full DOM replace wiped peer-selected/peer-editing classes from
  // existing cards. Re-paint from peerSelectionState so peer presence on
  // cards survives a re-render. peerCursorRefresh is called inside.
  if (typeof applyPeerSelectionToCy === 'function') applyPeerSelectionToCy();
  // Selection count may have changed (deleted cards drop out); sync toolbar.
  updateKanbanToolbar();
}

// `base` is { version, content } from the most recent server read of this
// task. When supplied, the server can three-way merge a concurrent edit
// instead of clobbering it. Omitted on writes that don't have a base
// available (e.g. first PATCH after a fresh-page race) — the server falls
// back to last-write-wins for those.
async function updateTask(id, content, base = null) {
  const body = { content };
  if (base && typeof base.version === 'number' && typeof base.content === 'string') {
    body.base_version = base.version;
    body.base_content = base.content;
  }
  return fetch(`${apiBase()}/tasks/${id}`, {
    method: 'PATCH',
    headers: writeHeaders(),
    body: JSON.stringify(body),
  });
}

// Re-run the breadthfirst layout with tight spacing, persist the new
// positions, and zoom-to-fit. Use when manual placements have left the graph
// sprawling and you want to start over with a clean compact arrangement.
// Destructive of any custom node positions — that's the point.
async function tidyAndFit() {
  if (!cy || cy.elements().length === 0) return;
  cy.layout({
    name: 'breadthfirst',
    directed: true,
    spacingFactor: 1.0,
    avoidOverlap: true,
    nodeDimensionsIncludeLabels: true,
    fit: false,
  }).run();
  resolveAllOverlaps();
  cy.fit(undefined, 50);
  // Persist each node's new position so it survives reloads. Done in
  // parallel; persistNodePosition swallows individual failures with a hint.
  await Promise.all(
    cy.nodes()
      .filter((n) => n.data('taskId') && !n.id().startsWith('__'))
      .map((n) => persistNodePosition(n))
  );
  showHint('Tidied & fit');
}

async function persistNodePosition(node) {
  if (!node || node.empty() || node.removed()) return;
  const taskId = node.data('taskId');
  if (!taskId) return;

  const pos = node.position();
  const x = roundPosition(pos.x);
  const y = roundPosition(pos.y);
  const meta = { ...(node.data('meta') || {}), x, y };
  node.data('meta', meta);

  if (String(editingTaskId) === String(taskId)) {
    panelLoadedMeta = { ...panelLoadedMeta, x, y };
  }

  try {
    const taskRes = await fetch(`${apiBase()}/tasks/${taskId}`);
    if (!taskRes.ok) throw new Error('load failed');
    const task = await taskRes.json();
    const parsed = parseFrontmatter(task.content);
    const content = buildContent({ ...(parsed.meta || {}), x, y }, parsed.body);
    const updateRes = await updateTask(taskId, content, task);
    if (!updateRes.ok) {
      if (maybeForbid(updateRes)) return;
      throw new Error('save failed');
    }
    const saved = await updateRes.json();
    updateGraphNode(saved);
    if (String(editingTaskId) === String(taskId)) {
      panelLoadedMeta = { ...panelLoadedMeta, x, y };
    }
  } catch {
    showHint('Could not save position');
  }
}

async function deleteTask(id) {
  await fetch(`${apiBase()}/tasks/${id}`, { method: 'DELETE' });
}

async function createEdge(source_id, target_id, type) {
  return fetch(`${apiBase()}/edges`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({ source_id, target_id, type }),
  });
}

async function updateEdgeMeta(edge, metaPatch) {
  const rawId = String(edge.id()).replace(/^e/, '');
  const url = `${apiBase()}/edges/${rawId}`;
  const baseRow = edgeBaseRow(edge);
  return patchWithRetry(
    url,
    (base) => {
      const body = { meta: metaPatch };
      if (base) {
        body.base_row = base;
        body.base_version = base.version;
      }
      return body;
    },
    baseRow,
    'edge',
  );
}

// --- Hint toast ---
// `anchor` defaults to 'canvas' (current behavior — graph-operation toasts
// like Tidy, status changes, edge ops). Pass 'page' for toasts that aren't
// about the graph itself (sharing/access, account, graph-options modal save
// errors) so they center to the viewport instead of the canvas band.
let hintTimeout;
function showHint(text, anchor = 'canvas') {
  const el = document.getElementById('hotkey-hint');
  const inner = document.getElementById('hotkey-hint-text');
  inner.textContent = text;
  if (anchor === 'page') {
    el.dataset.anchor = 'page';
    el.style.right = '';
  } else {
    delete el.dataset.anchor;
    // Center over the visible canvas: the bar already starts at the sidebar's
    // right edge (CSS), but its right edge follows the task panel when open
    // so the toast doesn't drift behind the panel.
    const panel = document.getElementById('panel');
    if (panel && !panel.classList.contains('hidden')) {
      el.style.right = `${Math.round(panel.getBoundingClientRect().width)}px`;
    } else {
      el.style.right = '';
    }
  }
  el.classList.remove('hidden');
  clearTimeout(hintTimeout);
  hintTimeout = setTimeout(() => el.classList.add('hidden'), 2000);
}

function clearSelection() {
  closeColorPalette();
  if (edgeTypeEditing) cancelEdgeTypeEdit();
  if (statusEditing) cancelStatusEdit();
  cy.nodes().removeClass('selected');
  cy.edges().removeClass('selected');
  cy.edges().removeClass('highlighted');
  hideCurveHandle();
  updateToolbar();
  // Esc / programmatic clears need to take the local "(You)" pill with them;
  // the cy 'tap' handler doesn't fire for these paths.
  if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
}

function elementFocusPoint(ele) {
  if (!ele || ele.empty()) return null;
  if (ele.isNode()) return ele.position();
  const midpoint = ele.midpoint();
  return midpoint || null;
}

function isDirectionalCandidate(from, to, direction) {
  if (!from || !to) return false;
  const EPS = 1e-6;
  if (direction === 'ArrowUp') return to.y < from.y - EPS;
  if (direction === 'ArrowDown') return to.y > from.y + EPS;
  if (direction === 'ArrowLeft') return to.x < from.x - EPS;
  if (direction === 'ArrowRight') return to.x > from.x + EPS;
  return false;
}

function nearestElementInDirection(current, candidates, direction) {
  const from = elementFocusPoint(current);
  if (!from) return null;

  let best = null;
  let bestScore = Infinity;
  candidates.forEach((candidate) => {
    if (candidate.id() === current.id()) return;
    const to = elementFocusPoint(candidate);
    if (!isDirectionalCandidate(from, to, direction)) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
    const axial = horizontal ? dx : dy;
    const perp = horizontal ? dy : dx;
    const score = perp * perp * 4 + axial * axial;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });
  return best;
}

function moveSelection(direction) {
  if (edgeCreation || edgeTypeEditing || statusEditing) return false;
  if (pendingNode) return false;

  const selectedNodes = cy.nodes('.selected').filter((n) => n.id() !== '__pending__' && n.id() !== '__edge_target__');
  const selectedEdges = cy.edges('.selected').filter((edge) => !edge.id().startsWith('__'));
  const isNodeFocus = selectedNodes.length === 1 && selectedEdges.length === 0;
  const isEdgeFocus = selectedEdges.length === 1 && selectedNodes.length === 0;
  if (!isNodeFocus && !isEdgeFocus) return false;

  const current = isNodeFocus ? selectedNodes[0] : selectedEdges[0];
  const candidates = isNodeFocus
    ? cy.nodes().filter((n) => n.id() !== '__pending__' && n.id() !== '__edge_target__')
    : cy.edges().filter((edge) => !edge.id().startsWith('__'));
  const next = nearestElementInDirection(current, candidates, direction);
  if (!next) return false;

  if (isNodeFocus) {
    cy.nodes().removeClass('selected');
    cy.edges().removeClass('selected');
    next.addClass('selected');
    if (isPanelOpen()) showPanel(next);
  } else {
    cy.nodes().removeClass('selected');
    cy.edges().removeClass('selected');
    next.addClass('selected');
    if (isPanelOpen()) hidePanel();
    showCurveHandle(next);
  }
  updateToolbar();
  return true;
}

let curveHandleEdge = null;
let curveHandleDragging = false;

function getEdgeCurveGeometry(edge) {
  if (!edge || edge.empty() || edge.removed()) return null;
  const source = edge.source();
  const target = edge.target();
  if (!source || !target || source.empty() || target.empty()) return null;

  const a = source.position();
  const b = target.position();
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;

  const tangent = { x: dx / length, y: dy / length };
  const normal = { x: -tangent.y, y: tangent.x };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const { distance, weight: rawWeight } = getEdgeCurveData(edge);

  // Clamp weight to per-edge bounds derived from node sizes — keeps the
  // handle visibly outside both nodes even if a stale value was persisted
  // before nodes resized.
  const { wMin, wMax } = getEdgeWeightBounds(source, target, length);
  const weight = Math.max(wMin, Math.min(wMax, rawWeight));

  // Render the handle ON the curve at B(t=weight) — the bezier sample at the
  // weight parameter. Tangential position along S→T is the smoothstep
  // s(w) = w²(3-2w); perpendicular displacement at that t is 2(1-w)w·d.
  const s = weight * weight * (3 - 2 * weight);
  const tangentialOffset = (s - 0.5) * length;
  const perpendicularOffset = 2 * weight * (1 - weight) * distance;
  const handle = {
    x: mid.x + tangent.x * tangentialOffset + normal.x * perpendicularOffset,
    y: mid.y + tangent.y * tangentialOffset + normal.y * perpendicularOffset,
  };
  return { mid, tangent, normal, length, handle };
}

// Inverse of smoothstep s(w) = w²(3-2w) for y in [0,1] → w in [0,1].
// Closed form via the trigonometric solution to the cubic 2w³ - 3w² + y = 0.
function inverseSmoothstep(y) {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  return 0.5 - Math.sin(Math.asin(1 - 2 * y) / 3);
}

// Distance from the center of an axis-aligned rectangle to its boundary
// along a given direction. min(hw/|dx|, hh/|dy|) — pick whichever side the
// ray hits first. Treats nodes as their bounding rect; close enough for
// rounded rects too, slightly conservative at the corners.
function rectRadiusAlongDirection(width, height, dirX, dirY) {
  const hw = width / 2;
  const hh = height / 2;
  const ax = Math.abs(dirX);
  const ay = Math.abs(dirY);
  const tX = ax > 1e-9 ? hw / ax : Infinity;
  const tY = ay > 1e-9 ? hh / ay : Infinity;
  const t = Math.min(tX, tY);
  return Number.isFinite(t) ? t : Math.max(hw, hh);
}

// Per-edge dynamic weight bounds so the handle never lands inside either
// node. The keep-out zone is the actual rect radius along the edge direction
// plus a visual margin, expressed as a fraction along S→T and converted to
// a weight via inverse smoothstep. Intersected with the static
// [EDGE_WEIGHT_MIN, MAX] range.
const EDGE_HANDLE_MARGIN = 18;
function getEdgeWeightBounds(source, target, length) {
  const a = source.position();
  const b = target.position();
  const dirX = (b.x - a.x) / length;
  const dirY = (b.y - a.y) / length;
  const sourceR = rectRadiusAlongDirection(source.width(), source.height(), dirX, dirY);
  const targetR = rectRadiusAlongDirection(target.width(), target.height(), dirX, dirY);
  const fMin = (sourceR + EDGE_HANDLE_MARGIN) / length;
  const fMax = 1 - (targetR + EDGE_HANDLE_MARGIN) / length;
  if (fMin >= fMax) return { wMin: 0.5, wMax: 0.5 };
  const wMin = Math.max(EDGE_WEIGHT_MIN, inverseSmoothstep(Math.max(0, Math.min(1, fMin))));
  const wMax = Math.min(EDGE_WEIGHT_MAX, inverseSmoothstep(Math.max(0, Math.min(1, fMax))));
  if (wMin >= wMax) return { wMin: 0.5, wMax: 0.5 };
  return { wMin, wMax };
}

function modelToViewportPoint(pos) {
  const rect = document.getElementById('cy').getBoundingClientRect();
  const pan = cy.pan();
  const zoom = cy.zoom();
  return {
    x: rect.left + pos.x * zoom + pan.x,
    y: rect.top + pos.y * zoom + pan.y,
  };
}

function pointerToModelPoint(e) {
  const rect = document.getElementById('cy').getBoundingClientRect();
  const pan = cy.pan();
  const zoom = cy.zoom();
  return {
    x: (e.clientX - rect.left - pan.x) / zoom,
    y: (e.clientY - rect.top - pan.y) / zoom,
  };
}

function getEdgeHandlePoint(edge) {
  if (!edge || edge.empty() || edge.removed()) return null;
  // Don't use Cytoscape's edge.midpoint() — it returns the midpoint of the
  // rendered curve (B(0.5)), not our control point. With our handle-at-
  // control-point model that would visually cap drag reach at ~25% from
  // each endpoint regardless of the underlying weight value.
  const geometry = getEdgeCurveGeometry(edge);
  return geometry ? geometry.handle : null;
}

function updateCurveHandlePosition() {
  const handle = document.getElementById('edge-curve-handle');
  if (!curveHandleEdge || curveHandleEdge.empty() || curveHandleEdge.removed()) {
    hideCurveHandle();
    return;
  }
  const handlePoint = getEdgeHandlePoint(curveHandleEdge);
  if (!handlePoint) {
    hideCurveHandle();
    return;
  }
  const point = modelToViewportPoint(handlePoint);
  handle.style.left = `${point.x}px`;
  handle.style.top = `${point.y}px`;
}

function showCurveHandle(edge) {
  if (!edge || edge.empty() || edge.removed() || edge.id().startsWith('__')) return;
  curveHandleEdge = edge;
  const handle = document.getElementById('edge-curve-handle');
  handle.classList.remove('hidden');
  updateCurveHandlePosition();
}

function hideCurveHandle() {
  if (curveHandleDragging) return;
  curveHandleEdge = null;
  const handle = document.getElementById('edge-curve-handle');
  handle.classList.add('hidden');
  handle.classList.remove('dragging');
}

function scheduleCurveHandleHide(edge) {
  setTimeout(() => {
    const handle = document.getElementById('edge-curve-handle');
    if (curveHandleDragging || handle.matches(':hover')) return;
    if (edge && edge.hasClass && edge.hasClass('selected')) return;
    if (curveHandleEdge && edge && curveHandleEdge.id() !== edge.id()) return;
    hideCurveHandle();
  }, 80);
}

function setEdgeCurveFromPointer(edge, e) {
  const geom = getEdgeCurveGeometry(edge);
  if (!geom) return;
  const point = pointerToModelPoint(e);
  const dx = point.x - geom.mid.x;
  const dy = point.y - geom.mid.y;
  const alpha = dx * geom.tangent.x + dy * geom.tangent.y; // along S→T
  const beta = dx * geom.normal.x + dy * geom.normal.y;    // perpendicular

  // Inverse of the geometry: handle is at B(t=w), so the tangential
  // fraction-from-S equals smoothstep(w). Solve for w via inverse smoothstep,
  // then back out d from the perpendicular component, which at t=w is
  // 2(1-w)w·d.
  const fraction = Math.max(0, Math.min(1, alpha / geom.length + 0.5));
  let weight = inverseSmoothstep(fraction);

  // Per-edge dynamic clamp keeps the handle outside both node bodies. We
  // recompute it here because the geometry function uses the same source
  // data — keeping these in sync prevents render/drag drift.
  const { wMin, wMax } = getEdgeWeightBounds(edge.source(), edge.target(), geom.length);
  weight = Math.max(wMin, Math.min(wMax, weight));

  const denom = 2 * weight * (1 - weight);
  // denom is in (0, 0.5] for weight in (0,1), so this stays well-defined.
  let distance = beta / denom;
  distance = Math.max(-EDGE_CURVE_LIMIT, Math.min(EDGE_CURVE_LIMIT, roundCurve(distance)));
  weight = Math.round(weight * 1000) / 1000;

  const meta = { ...(edge.data('meta') || {}), curve: { distance, weight } };
  edge.data('meta', meta);
  edge.data('curveDistance', distance);
  edge.data('curveWeight', weight);
  updateCurveHandlePosition();
}

async function persistEdgeCurve(edge) {
  if (!edge || edge.empty() || edge.removed()) return;
  const curve = getEdgeCurveData(edge);
  try {
    const res = await updateEdgeMeta(edge, { curve });
    if (!res.ok) throw new Error('save failed');
    const saved = await res.json();
    edge.data('meta', saved.meta || {});
    const next = getEdgeCurveData(saved);
    edge.data('curveDistance', next.distance);
    edge.data('curveWeight', next.weight);
    if (typeof saved.version === 'number') edge.data('version', saved.version);
    updateCurveHandlePosition();
  } catch {
    showHint('Could not save curve');
  }
}

async function deleteEdgeById(edgeId) {
  await fetch(`${apiBase()}/edges/${edgeId}`, { method: 'DELETE' });
}

function confirmDelete(message, opts = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('delete-modal');
    const title = document.getElementById('delete-modal-title');
    const desc = document.getElementById('delete-modal-desc');
    const btnConfirm = document.getElementById('delete-confirm');
    const btnCancel = document.getElementById('delete-cancel');
    desc.textContent = message;
    const originalTitle = title.textContent;
    const originalConfirmText = btnConfirm.textContent;
    if (opts.title) title.textContent = opts.title;
    if (opts.confirmText) btnConfirm.textContent = opts.confirmText;

    function close(result) {
      modal.classList.add('hidden');
      title.textContent = originalTitle;
      btnConfirm.textContent = originalConfirmText;
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onConfirm() { close(true); }
    function onCancel() { close(false); }
    function onBackdrop(e) { if (e.target === modal) close(false); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    }

    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    modal.classList.remove('hidden');
    btnConfirm.focus();
  });
}

async function deleteSelected() {
  if (!document.getElementById('delete-modal').classList.contains('hidden')) return;
  const nodes = cy.nodes('.selected').filter((n) => n.id() !== '__pending__' && n.data('taskId'));
  const edges = cy.edges('.selected');
  if (nodes.length === 0 && edges.length === 0) return;

  const parts = [];
  if (nodes.length) parts.push(`${nodes.length} ${nodes.length === 1 ? 'task' : 'tasks'}`);
  if (edges.length) parts.push(`${edges.length} ${edges.length === 1 ? 'edge' : 'edges'}`);
  if (!(await confirmDelete(`Delete ${parts.join(' and ')}?`))) return;

  for (const n of nodes) {
    await deleteTask(n.data('taskId'));
  }
  for (const e of edges) {
    const rawId = String(e.id()).replace(/^e/, '');
    await deleteEdgeById(rawId);
  }
  if (isPanelOpen()) hidePanel();
  clearSelection();
  await fetchGraph();
}

// --- Sidebar / multi-graph ---

const sidebar = {
  graphs: [],   // public graphs from GET /api/graphs
  recents: [],  // browser-local visit history; see RECENT_GRAPHS_STORAGE_KEY
};

// Recent-graphs persistence — purely client-side. The server does not know
// which graphs you've visited; that's the privacy model. Each entry caches
// {id, name, last_visited_at} so the sidebar can render without a round-
// trip; entries are refreshed lazily by fetchGraphsList.
function recentsRead() {
  try {
    const raw = localStorage.getItem(RECENT_GRAPHS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && typeof r.id === 'string');
  } catch { return []; }
}

function recentsWrite(list) {
  try {
    localStorage.setItem(
      RECENT_GRAPHS_STORAGE_KEY,
      JSON.stringify(list.slice(0, RECENTS_CAP))
    );
  } catch {}
}

// `created` is the local "I made this graph" flag. Persisted in localStorage
// so it survives reloads. Once true it stays true across re-visits — we only
// flip false → true (when the user creates a new graph) or set fresh entries
// to false (when they arrive via URL). Used by the sidebar to bucket
// anon-mode entries into 'My graphs' vs 'Shared with me'.
function recentsUpsert(graph, opts = {}) {
  if (!graph || typeof graph.id !== 'string') return;
  const list = recentsRead();
  const i = list.findIndex((r) => r.id === graph.id);
  const prev = i >= 0 ? list[i] : null;
  if (i >= 0) list.splice(i, 1);
  list.unshift({
    id: graph.id,
    name: graph.name,
    created: opts.created === true || (prev?.created === true),
    last_visited_at: new Date().toISOString(),
  });
  recentsWrite(list);
  sidebar.recents = list;
}

function recentsRemove(id) {
  const list = recentsRead().filter((r) => r.id !== id);
  recentsWrite(list);
  sidebar.recents = list;
}

// Sidebar collapse state. Driven by `.collapsed` on `#sidebar`; CSS hides
// the title, list, and bottom-spacer text, leaving the expand and gear
// icons. Persisted across reloads.
function isSidebarCollapsed() {
  const el = document.getElementById('sidebar');
  return !!(el && el.classList.contains('collapsed'));
}

function setSidebarCollapsed(collapsed) {
  const el = document.getElementById('sidebar');
  if (!el) return;
  el.classList.toggle('collapsed', !!collapsed);
  // The canvas, bottom toolbar, and panel all anchor off `--sidebar-w` so
  // they reflow when the sidebar shrinks. Keep that var in sync.
  document.documentElement.style.setProperty('--sidebar-w', collapsed ? '48px' : '200px');
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
  // Cytoscape sized off the parent — let it know the viewport changed.
  if (typeof cy !== 'undefined' && cy) {
    requestAnimationFrame(() => { try { cy.resize(); } catch {} });
  }
  // Sidebar width feeds into computePanelMaxWidth (button shifts with
  // --sidebar-w, sidebar.right changes too). Re-clamp so a previously-safe
  // wide panel doesn't suddenly overlap the avatar bar.
  if (typeof adjustPresenceBarOffset === 'function') adjustPresenceBarOffset();
  // Sidebar width also affects the bottom toolbar's available canvas width.
  if (typeof fitBottomBar === 'function') fitBottomBar();
}

function applySidebarCollapsedFromStorage() {
  let stored = '0';
  try { stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) || '0'; } catch {}
  setSidebarCollapsed(stored === '1');
}

// All time display in this app is UTC so the same graph reads identically
// to any viewer regardless of their browser tz. Two formats:
//   formatUtc      → MM/DD/YY        (compact, default)
//   formatUtcLong  → YYYY-MM-DD HH:MM UTC (full, on hover/click in modal)
function formatUtc(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCFullYear() % 100)}`;
}
function formatUtcLong(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

function relativeTime(iso) {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

async function fetchGraphsList() {
  const res = await fetch('/api/graphs');
  if (!res.ok) throw new Error('failed to load graphs');
  sidebar.graphs = await res.json();
  sidebar.recents = recentsRead();
  renderSidebar();
  // Lazy refresh of recents: fetch each cached entry to update name and
  // drop entries the user no longer has access to (404 / 403).
  refreshRecents();
}

async function refreshRecents() {
  const list = recentsRead();
  let changed = false;
  for (const r of list) {
    try {
      const res = await fetch(`/api/graphs/${encodeURIComponent(r.id)}`);
      if (res.status === 404) {
        const after = recentsRead().filter((e) => e.id !== r.id);
        recentsWrite(after);
        sidebar.recents = after;
        changed = true;
        continue;
      }
      if (!res.ok) continue;
      const row = await res.json();
      if (row.name !== r.name) {
        const current = recentsRead();
        const i = current.findIndex((e) => e.id === r.id);
        if (i >= 0) {
          current[i] = { ...current[i], name: row.name };
          recentsWrite(current);
          sidebar.recents = current;
          changed = true;
        }
      }
    } catch { /* network/transient — leave the cached entry alone */ }
  }
  if (changed) renderSidebar();
}

function renderSidebar() {
  const list = document.getElementById('sidebar-list');
  if (!list) return;
  list.innerHTML = '';

  // Sort key: prefer the user's last-visited time from the recents cache, fall
  // back to the server's updated_at. Ensures both sections render in
  // "recently visited" order regardless of when the graph was last touched
  // on the server.
  const recentMap = new Map(sidebar.recents.map((r) => [r.id, r.last_visited_at]));
  const byVisit = (a, b) => {
    const at = recentMap.get(a.id) || a.updated_at || a.last_visited_at || '';
    const bt = recentMap.get(b.id) || b.updated_at || b.last_visited_at || '';
    return bt.localeCompare(at);
  };

  const viewerId = gtAuth?.viewerUserId || null;
  let myGraphs = [];
  let sharedGraphs = [];
  const renderedIds = new Set();

  // Race fix: when auth is enabled, the initial render fires before Clerk +
  // /api/config have resolved the viewer identity. Falling through to the
  // anon-fallback below would bucket recents from localStorage by their
  // (often-missing) `created` flag, then immediately re-render with server
  // truth — producing a visible flash where owned graphs briefly land in
  // "Shared with me". Hold the sidebar empty until identity is known.
  const authPending = gtAuth.enabled && (
    !gtAuth.ready || (gtAuth.user && !gtAuth.viewerUserId)
  );
  if (authPending) {
    updateEmptyStates();
    return;
  }

  if (viewerId) {
    // Signed-in: server gave us owned + member-of in sidebar.graphs.
    myGraphs = sidebar.graphs.filter((g) => g.owner_user_id === viewerId).sort(byVisit);
    sharedGraphs = sidebar.graphs.filter((g) => g.owner_user_id !== viewerId).sort(byVisit);
    for (const g of [...myGraphs, ...sharedGraphs]) renderedIds.add(g.id);
  } else {
    // Anonymous: server returns []. Bucket from localStorage recents instead,
    // splitting by the `created` flag set in recentsUpsert.
    const recents = sidebar.recents;
    myGraphs = recents.filter((r) => r.created === true);
    sharedGraphs = recents.filter((r) => r.created !== true);
    for (const r of [...myGraphs, ...sharedGraphs]) renderedIds.add(r.id);
  }

  // Always source the "source" label so makeSidebarItem can branch on it
  // (e.g. for future per-bucket affordances).
  const myLabel = 'My graphs';
  const sharedLabel = 'Shared with me';

  if (myGraphs.length > 0) {
    list.appendChild(makeSectionHeader(myLabel));
    for (const g of myGraphs) list.appendChild(makeSidebarItem(g, { source: 'owned' }));
  }
  if (sharedGraphs.length > 0) {
    list.appendChild(makeSectionHeader(sharedLabel));
    for (const g of sharedGraphs) list.appendChild(makeSidebarItem(g, { source: 'shared' }));
  }
  updateEmptyStates();
}

function makeSectionHeader(text) {
  const h = document.createElement('div');
  h.className = 'sb-section';
  h.textContent = text;
  return h;
}

function makeSidebarItem(graphLike, { source }) {
  const item = document.createElement('div');
  item.className = 'sb-item' + (graphLike.id === activeGraphId ? ' active' : '');
  item.dataset.graphId = String(graphLike.id);
  if (graphLike.description) item.title = graphLike.description;

  // Status dot in the left gutter, on the title row. Orange when this is the
  // active graph, grey otherwise (orange comes from the .active class).
  const dot = document.createElement('span');
  dot.className = 'sb-dot';
  item.appendChild(dot);

  const name = document.createElement('div');
  name.className = 'sb-name';
  name.appendChild(document.createTextNode(graphLike.name));
  item.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'sb-meta';
  const stamp = graphLike.updated_at || graphLike.last_visited_at;
  meta.textContent = stamp ? relativeTime(stamp) : '';
  item.appendChild(meta);

  // Phase A's lock icon (driven by is_public=false) is gone — `anon_role`
  // now carries the privacy semantic and isn't cached in recents. We can
  // re-introduce a privacy indicator later by caching anon_role too.

  const menuBtn = document.createElement('button');
  menuBtn.className = 'sb-menu-btn';
  menuBtn.textContent = '⋮';
  menuBtn.title = 'Graph options';
  menuBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Sidebar entries (owned, member, or recent) carry only the subset
    // needed to render. Fetch the full row so the modal can show description
    // and the access controls without missing fields.
    try {
      const res = await fetch(`/api/graphs/${encodeURIComponent(graphLike.id)}`);
      if (!res.ok) {
        showHint('Could not open graph options', 'page');
        return;
      }
      openGraphEditModal(await res.json());
    } catch {
      showHint('Could not open graph options', 'page');
    }
  });
  item.appendChild(menuBtn);

  item.addEventListener('click', () => {
    if (graphLike.id !== activeGraphId) switchActiveGraph(graphLike.id, { pushState: true });
  });

  return item;
}

function updateEmptyStates() {
  const sidebarEmpty = document.getElementById('sidebar-empty');
  const nothingToShow =
    sidebar.graphs.length === 0 && sidebar.recents.length === 0;
  if (sidebarEmpty) sidebarEmpty.classList.toggle('hidden', !nothingToShow);
  // Refresh the canvas-level empty-state hint so its copy matches
  // whether or not a graph is active.
  if (typeof updateEmptyState === 'function') updateEmptyState();
}

// Single edit modal — Save commits name + description; Delete confirms then removes.
let _graphModalClose = null;

// Convergence point for Cmd+K, the toolbar Settings button, and the
// post-create modal's Settings button. Toggles the modal closed if it's
// already open. No-op when there's no active graph (empty home page).
async function openGraphSettings() {
  if (_graphModalClose) { _graphModalClose(); return; }
  if (activeGraphId == null) return;
  try {
    const res = await fetch(`/api/graphs/${encodeURIComponent(activeGraphId)}`);
    if (!res.ok) return;
    openGraphEditModal(await res.json());
  } catch {}
}

function openGraphEditModal(graph) {
  // If the modal was already open (e.g. clicking ⋮ on another graph), tear
  // down the previous instance's listeners before binding new ones.
  if (_graphModalClose) _graphModalClose();

  const modal = document.getElementById('graph-modal');
  const nameInput = document.getElementById('graph-modal-name');
  const nameError = document.getElementById('graph-modal-name-error');
  const descInput = document.getElementById('graph-modal-desc');
  const createdEl = document.getElementById('graph-modal-created');
  const urlInput = document.getElementById('graph-modal-url');
  const copyBtn = document.getElementById('graph-modal-copy');
  const rotateBtn = document.getElementById('graph-modal-rotate');
  const fontPicker = document.getElementById('graph-modal-font');
  const fontSwatchesEl = document.getElementById('graph-modal-font-swatches');
  const bgSwatchesEl = document.getElementById('graph-modal-bg-swatches');
  const saveBtn = document.getElementById('graph-modal-save');
  const deleteBtn = document.getElementById('graph-modal-delete');

  // Access section (Phase B5c): shown only for owned graphs the viewer can
  // manage. Legacy un-owned graphs hide it (URL = full access already).
  const accessSection = document.getElementById('graph-modal-access');
  const showAccess = graph.owner_user_id != null && graph.viewer_can_manage !== false;
  accessSection.classList.toggle('hidden', !showAccess);

  let accessCleanup = null;
  if (showAccess) {
    accessCleanup = wireAccessSection(graph);
  }

  // View picker (per-user, per-graph; client-only). Sits above the font
  // picker in the appearance grid. wirePicker handles open/close/keyboard;
  // onChange persists the choice and flips the canvas region immediately.
  const viewCleanup = wirePicker(document.getElementById('graph-modal-view'), {
    initial: getViewPref(graph.id),
    onChange: (v) => {
      setViewPref(graph.id, v);
      applyView(v);
    },
  });

  nameInput.textContent = graph.name || '';
  nameError.textContent = '';
  nameError.classList.add('hidden');
  descInput.value = graph.description || '';

  // Created-at toggles between compact (default) and full UTC datetime.
  // Hover previews the full form; click sticks it. Modal always opens
  // collapsed — no persistence across opens.
  let createdExpanded = false;
  function renderCreated() {
    createdEl.textContent = `Created ${
      createdExpanded ? formatUtcLong(graph.created_at) : formatUtc(graph.created_at)
    }`;
  }
  function onCreatedEnter() {
    createdEl.textContent = `Created ${formatUtcLong(graph.created_at)}`;
  }
  function onCreatedLeave() { renderCreated(); }
  function onCreatedClick() { createdExpanded = !createdExpanded; renderCreated(); }
  renderCreated();
  createdEl.addEventListener('mouseenter', onCreatedEnter);
  createdEl.addEventListener('mouseleave', onCreatedLeave);
  createdEl.addEventListener('click', onCreatedClick);

  // Per-graph appearance overrides. Each per-key state has two pieces:
  //   customized → did the user explicitly set this key (vs. inheriting)?
  //   value      → if customized, what hex/font-id?
  // The color picker always shows *something* — when not customized, it
  // shows the effective app default so the user sees the graph's current
  // appearance. The "Reset" button clears `customized` and snaps the input
  // back to the app default.
  const initialSettings = (graph.settings && typeof graph.settings === 'object') ? graph.settings : {};
  const appearance = {
    font: { initial: initialSettings.font || null, current: initialSettings.font || null },
    font_color: { initial: initialSettings.font_color || null, customized: !!initialSettings.font_color },
    bg_color: { initial: initialSettings.bg_color || null, customized: !!initialSettings.bg_color },
  };

  // Custom font picker — native <select> popups ignore per-option
  // font-family on macOS, so we render a controlled menu we can style.
  // The trigger label inherits the chosen option's inline font-family so
  // the closed picker also shows the choice in its own face.
  const fontTrigger = fontPicker.querySelector('.font-picker-trigger');
  const fontValueEl = fontPicker.querySelector('.font-picker-value');
  const fontMenu = fontPicker.querySelector('.font-picker-menu');
  const fontOptions = Array.from(fontPicker.querySelectorAll('.font-picker-option'));

  function applyFontSelection(value) {
    appearance.font.current = value || null;
    const opt = fontOptions.find((o) => o.dataset.value === (value || '')) || fontOptions[0];
    fontValueEl.textContent = opt.textContent;
    fontValueEl.style.fontFamily = opt.style.fontFamily || '';
    fontOptions.forEach((o) => {
      o.classList.toggle('active', o === opt);
      o.setAttribute('aria-selected', o === opt ? 'true' : 'false');
    });
  }
  function openFontMenu() {
    fontMenu.classList.remove('hidden');
    fontTrigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onFontDocClick, true);
    document.addEventListener('keydown', onFontDocKey, true);
  }
  function closeFontMenu() {
    fontMenu.classList.add('hidden');
    fontTrigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onFontDocClick, true);
    document.removeEventListener('keydown', onFontDocKey, true);
  }
  function onFontTriggerClick() {
    if (fontMenu.classList.contains('hidden')) openFontMenu();
    else closeFontMenu();
  }
  function onFontOptionClick(e) {
    const btn = e.currentTarget;
    applyFontSelection(btn.dataset.value);
    closeFontMenu();
  }
  function onFontDocClick(e) {
    if (!fontPicker.contains(e.target)) closeFontMenu();
  }
  function onFontDocKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeFontMenu(); }
  }

  applyFontSelection(appearance.font.current || '');
  fontTrigger.addEventListener('click', onFontTriggerClick);
  fontOptions.forEach((o) => o.addEventListener('click', onFontOptionClick));

  // Render the inline swatch grids for Text + Background. Picking the same
  // color as the app default clears the per-graph override (acts as reset
  // without a dedicated button).
  function renderSwatches(container, palette, key) {
    const appDefault = key === 'font_color' ? appSettings.fontColor : appSettings.bgColor;
    const effective = appearance[key].customized
      ? (appearance[key].initial || appDefault)
      : appDefault;
    container.innerHTML = '';
    palette.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.style.backgroundColor = color.value;
      btn.title = color.name;
      btn.setAttribute('aria-label', color.name);
      if (normalizeColor(color.value) === normalizeColor(effective)) {
        btn.classList.add('active');
      }
      btn.addEventListener('click', () => {
        if (normalizeColor(color.value) === normalizeColor(appDefault)) {
          appearance[key].customized = false;
        } else {
          appearance[key].customized = true;
          appearance[key].initial = color.value;
        }
        container.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('active'));
        btn.classList.add('active');
      });
      container.appendChild(btn);
    });
  }
  renderSwatches(fontSwatchesEl, FONT_COLOR_PALETTE, 'font_color');
  renderSwatches(bgSwatchesEl, COLOR_PALETTE, 'bg_color');
  function setShareUrl(id) {
    urlInput.value = `${location.origin}/g/${id}`;
  }
  setShareUrl(graph.id);

  function close() {
    _graphModalClose = null;
    // Blur the trigger (toolbar Settings button etc.) so pressing Escape
    // to close the modal doesn't leave the browser drawing a focus-visible
    // outline on the button after the keyboard interaction.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    modal.classList.add('hidden');
    if (typeof accessCleanup === 'function') accessCleanup();
    if (typeof viewCleanup === 'function') viewCleanup();
    saveBtn.removeEventListener('click', onSave);
    deleteBtn.removeEventListener('click', onDelete);
    copyBtn.removeEventListener('click', onCopy);
    rotateBtn.removeEventListener('click', onRotate);
    createdEl.removeEventListener('mouseenter', onCreatedEnter);
    createdEl.removeEventListener('mouseleave', onCreatedLeave);
    createdEl.removeEventListener('click', onCreatedClick);
    fontTrigger.removeEventListener('click', onFontTriggerClick);
    fontOptions.forEach((o) => o.removeEventListener('click', onFontOptionClick));
    closeFontMenu();
    nameInput.removeEventListener('blur', onNameBlur);
    nameInput.removeEventListener('keydown', onNameKey);
    nameInput.removeEventListener('input', clearNameError);
    modal.removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey, true);
  }
  function showNameError(msg) {
    nameError.textContent = msg;
    nameError.classList.remove('hidden');
  }
  function clearNameError() {
    nameError.textContent = '';
    nameError.classList.add('hidden');
  }
  // Autosave-on-blur for the inline-editable graph name. Empty input reverts
  // to the last saved name; conflicts (409) and other server errors surface
  // via the inline #graph-modal-name-error. The bottom Save button still runs
  // independently for description/visibility/appearance.
  async function onNameBlur() {
    const next = nameInput.textContent.trim();
    if (!next) {
      nameInput.textContent = graph.name || '';
      clearNameError();
      return;
    }
    if (next === graph.name) {
      clearNameError();
      return;
    }
    try {
      const baseRow = graphBaseRow(graph);
      const res = await patchWithRetry(
        `/api/graphs/${graph.id}`,
        (base) => {
          const body = { name: next };
          if (base) {
            body.base_row = base;
            body.base_version = base.version;
          }
          return body;
        },
        baseRow,
        'graph',
      );
      if (!res.ok) {
        if (handleConflictStatus(res, 'graph')) {
          await fetchGraphsList();
          return;
        }
        const e = await res.json().catch(() => ({}));
        showNameError(e.error || 'Could not save name.');
        return;
      }
      const updated = await res.json();
      graph.name = updated.name;
      graph.version = updated.version;
      nameInput.textContent = updated.name;
      clearNameError();
      if (graph.id === activeGraphId) currentGraph = updated;
      fetchGraphsList();
    } catch {
      showNameError('Could not save name.');
    }
  }
  function onNameKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      nameInput.textContent = graph.name || '';
      clearNameError();
      nameInput.blur();
    }
  }
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(urlInput.value);
      const icon = copyBtn.querySelector('i');
      if (icon) {
        const original = icon.className;
        icon.className = 'ph ph-check';
        setTimeout(() => { icon.className = original; }, 1200);
      }
    } catch {
      urlInput.select();
    }
  }
  async function onRotate() {
    const ok = await confirmDelete(
      'Current link will no longer exist.',
      { title: 'Rotate link?', confirmText: 'Rotate' }
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/graphs/${graph.id}/rotate-id`, { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        showHint(e.error || 'Rotate failed', 'page');
        return;
      }
      const updated = await res.json();
      const wasActive = graph.id === activeGraphId;
      const oldId = graph.id;
      graph.id = updated.id;
      setShareUrl(updated.id);
      // The old id is now invalid; replace it in the recents list.
      recentsRemove(oldId);
      recentsUpsert(updated);
      if (wasActive) {
        activeGraphId = updated.id;
        try { localStorage.setItem(ACTIVE_GRAPH_STORAGE_KEY, updated.id); } catch {}
        history.replaceState({ graphId: updated.id }, '', `/g/${updated.id}`);
      }
      await fetchGraphsList();
    } catch {
      showHint('Rotate failed', 'page');
    }
  }
  async function onSave() {
    const nextName = nameInput.textContent.trim();
    const nextDescRaw = descInput.value;
    if (!nextName) {
      nameInput.focus();
      return;
    }
    const body = {};
    if (nextName !== graph.name) body.name = nextName;
    const trimmedDesc = nextDescRaw.trim();
    const newDesc = trimmedDesc === '' ? null : nextDescRaw;
    if (newDesc !== (graph.description ?? null)) body.description = newDesc;
    // anon_role is mutated via the inline access controls (live PATCH on
    // change); the Save button only diffs name / description / appearance.

    // Per-graph appearance: send a partial settings patch when any of the
    // three changed. null means "revert to default" — server strips nulls
    // out of the merged JSONB so the key disappears.
    const settingsPatch = {};
    const fontInitial = initialSettings.font || null;
    const nextFont = appearance.font.current || null;
    if (nextFont !== fontInitial) settingsPatch.font = nextFont; // may be null
    for (const key of ['font_color', 'bg_color']) {
      const initialHex = initialSettings[key] || null;
      const nextHex = appearance[key].customized
        ? (appearance[key].initial || null)
        : null;
      if (nextHex !== initialHex) settingsPatch[key] = nextHex;
    }
    if (Object.keys(settingsPatch).length > 0) body.settings = settingsPatch;

    if (Object.keys(body).length === 0) { close(); return; }
    try {
      const baseRow = graphBaseRow(graph);
      const res = await patchWithRetry(
        `/api/graphs/${graph.id}`,
        (base) => {
          const out = { ...body };
          if (base) {
            out.base_row = base;
            out.base_version = base.version;
          }
          return out;
        },
        baseRow,
        'graph',
      );
      if (!res.ok) {
        if (handleConflictStatus(res, 'graph')) {
          close();
          await fetchGraphsList();
          return;
        }
        const e = await res.json().catch(() => ({}));
        showHint(e.error || 'Save failed', 'page');
        return;
      }
      const updated = await res.json();
      // Reflect new appearance / metadata immediately. If the user edited
      // the active graph (the common case), update currentGraph and re-apply
      // visual settings so the canvas reflects the change without a reload.
      if (graph.id === activeGraphId) {
        currentGraph = updated;
        applySettings();
      }
      close();
      await fetchGraphsList();
    } catch {
      showHint('Save failed', 'page');
    }
  }
  async function onDelete() {
    const ok = await confirmDelete(
      `Delete "${graph.name}"? This removes all its tasks and edges.`
    );
    if (!ok) return;
    await fetch(`/api/graphs/${graph.id}`, { method: 'DELETE' });
    close();
    recentsRemove(graph.id);
    if (graph.id === activeGraphId) {
      activeGraphId = null;
      currentGraph = null;
      try { localStorage.removeItem(ACTIVE_GRAPH_STORAGE_KEY); } catch {}
      history.replaceState({}, '', '/');
      if (cy) cy.elements().remove();
      applySettings();
      applyReadOnlyState();
    }
    await fetchGraphsList();
    if (!activeGraphId && sidebar.graphs.length > 0) {
      await switchActiveGraph(sidebar.graphs[0].id, { pushState: true });
    } else {
      updateEmptyStates();
    }
  }
  function onBackdrop(e) { if (e.target === modal) close(); }
  function onKey(e) {
    // Enter while editing the name is handled by onNameKey (commit-blur).
    // Escape on the name field reverts; outside the name field, it closes.
    if (e.key === 'Escape' && e.target !== nameInput) {
      // If a confirm dialog is on top of us, let it handle Escape so the
      // user lands back on this graph-modal instead of dropping all the
      // way to the canvas.
      const confirmModal = document.getElementById('app-confirm-modal');
      if (confirmModal && !confirmModal.classList.contains('hidden')) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  saveBtn.addEventListener('click', onSave);
  deleteBtn.addEventListener('click', onDelete);
  copyBtn.addEventListener('click', onCopy);
  rotateBtn.addEventListener('click', onRotate);
  nameInput.addEventListener('blur', onNameBlur);
  nameInput.addEventListener('keydown', onNameKey);
  nameInput.addEventListener('input', clearNameError);
  modal.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKey, true);
  _graphModalClose = close;
  modal.classList.remove('hidden');
  // Open the modal scrolled to the top, but don't auto-focus the name
  // anymore — clicking it is the affordance. Auto-focusing felt aggressive
  // for a heading.
  modal.scrollTop = 0;
}

// Lazy-create a graph the first time the user does anything that needs one.
// Race-guarded so two fast clicks don't create two graphs.
let _ensureGraphPromise = null;
// id of a graph that was lazy-created in this session and hasn't yet had a
// task committed in it. If the user backs out before committing, we delete it
// so they don't accumulate empty "Untitled" graphs.
let _lazyCreatedGraphId = null;

function ensureActiveGraph() {
  if (activeGraphId != null) return Promise.resolve();
  if (_ensureGraphPromise) return _ensureGraphPromise;
  _ensureGraphPromise = (async () => {
    // Try "Untitled", then "Untitled 2", "Untitled 3", ... so the lazy-create
    // flow keeps working when the default name is already taken.
    let created = null;
    for (let i = 1; i <= 50; i++) {
      const name = i === 1 ? 'Untitled' : `Untitled ${i}`;
      const res = await fetch('/api/graphs', {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ name }),
      });
      if (res.ok) { created = await res.json(); break; }
      if (res.status !== 409) throw new Error('failed to create graph');
    }
    if (!created) throw new Error('failed to create graph');
    _lazyCreatedGraphId = created.id;
    await fetchGraphsList();
    await switchActiveGraph(created.id, { pushState: true });
  })().finally(() => { _ensureGraphPromise = null; });
  return _ensureGraphPromise;
}

// If the user lazy-created a graph and then backed out without committing
// any task, delete it. Deferred via setTimeout(0) so an in-flight createNodeAt
// can re-add a ghost before the check runs.
let _lazyCleanupTimer = null;
function maybeCleanupLazyGraph() {
  if (_lazyCreatedGraphId == null) return;
  if (_lazyCreatedGraphId !== activeGraphId) return;
  if (_lazyCleanupTimer) clearTimeout(_lazyCleanupTimer);
  _lazyCleanupTimer = setTimeout(async () => {
    _lazyCleanupTimer = null;
    if (_lazyCreatedGraphId == null) return;
    if (_lazyCreatedGraphId !== activeGraphId) return;
    if (cy && cy.nodes().length > 0) return; // a node is back in play
    const gid = _lazyCreatedGraphId;
    _lazyCreatedGraphId = null;
    try { await fetch(`/api/graphs/${gid}`, { method: 'DELETE' }); } catch {}
    activeGraphId = null;
    try { localStorage.removeItem(ACTIVE_GRAPH_STORAGE_KEY); } catch {}
    history.replaceState({}, '', '/');
    await fetchGraphsList();
    updateEmptyStates();
  }, 0);
}

async function createGraphFromUI() {
  const created = await promptNewGraphName();
  if (!created) return;
  // Mark the new graph as locally-created so the sidebar can put it under
  // 'My graphs' for anon users (signed-in users use server-side ownership).
  // The flag persists across reloads via the recents cache.
  recentsUpsert(created, { created: true });
  await fetchGraphsList();
  switchActiveGraph(created.id, { pushState: true });
  // Fire only on explicit creation. New graphs default to anon_role='viewer';
  // the user needs to know they should bookmark the URL or flip to restricted.
  showPrivateWarning(created);
}

// Post-create privacy warning. Bails immediately if the user previously chose
// "Never show again". Settings button opens the graph edit modal so they can
// flip is_public / copy URL / rotate without an extra click; Dismiss closes.
let _privateWarnClose = null;
function showPrivateWarning(graph) {
  try {
    if (localStorage.getItem(PRIVATE_WARN_SUPPRESS_KEY) === '1') return;
  } catch {}
  if (_privateWarnClose) _privateWarnClose();

  const modal = document.getElementById('private-warn-modal');
  const suppressEl = document.getElementById('private-warn-suppress');
  const settingsBtn = document.getElementById('private-warn-settings');
  const dismissBtn = document.getElementById('private-warn-dismiss');

  suppressEl.checked = false;

  function persistSuppressIfChecked() {
    if (!suppressEl.checked) return;
    try { localStorage.setItem(PRIVATE_WARN_SUPPRESS_KEY, '1'); } catch {}
  }
  function close() {
    _privateWarnClose = null;
    modal.classList.add('hidden');
    settingsBtn.removeEventListener('click', onSettings);
    dismissBtn.removeEventListener('click', onDismiss);
    modal.removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey, true);
  }
  function onSettings() {
    persistSuppressIfChecked();
    close();
    openGraphEditModal(graph);
  }
  function onDismiss() {
    persistSuppressIfChecked();
    close();
  }
  function onBackdrop(e) { if (e.target === modal) onDismiss(); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDismiss(); }
  }

  settingsBtn.addEventListener('click', onSettings);
  dismissBtn.addEventListener('click', onDismiss);
  modal.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKey, true);
  _privateWarnClose = close;
  modal.classList.remove('hidden');
}

// In-app modal replacement for the legacy prompt(). Resolves to the created
// graph row on success, or null on cancel. Validation + name-conflict errors
// render inline so the user can fix and retry without losing what they typed.
function promptNewGraphName() {
  return new Promise((resolve) => {
    const modal = document.getElementById('new-graph-modal');
    const input = document.getElementById('new-graph-name');
    const errorEl = document.getElementById('new-graph-error');
    const createBtn = document.getElementById('new-graph-create');
    const cancelBtn = document.getElementById('new-graph-cancel');

    input.value = '';
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    function setError(msg) {
      errorEl.textContent = msg;
      errorEl.classList.remove('hidden');
    }
    function clearError() {
      errorEl.classList.add('hidden');
      errorEl.textContent = '';
    }
    function close(result) {
      modal.classList.add('hidden');
      createBtn.removeEventListener('click', onCreate);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      input.removeEventListener('input', clearError);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    async function onCreate() {
      const trimmed = input.value.trim();
      if (!trimmed) {
        setError('Name is required');
        input.focus();
        return;
      }
      createBtn.disabled = true;
      try {
        const res = await fetch('/api/graphs', {
          method: 'POST',
          headers: writeHeaders(),
          body: JSON.stringify({ name: trimmed }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || 'Failed to create graph');
          input.focus();
          input.select();
          return;
        }
        const created = await res.json();
        close(created);
      } finally {
        createBtn.disabled = false;
      }
    }
    function onCancel() { close(null); }
    function onBackdrop(e) { if (e.target === modal) close(null); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && e.target === input) {
        e.preventDefault();
        onCreate();
      }
    }

    createBtn.addEventListener('click', onCreate);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    input.addEventListener('input', clearError);
    document.addEventListener('keydown', onKey, true);
    modal.classList.remove('hidden');
    input.focus();
  });
}

async function switchActiveGraph(id, { pushState = false } = {}) {
  // Depart presence on the previous graph before switching. Local state for
  // the new graph is reset; the new SSE stream will re-hydrate it.
  if (activeGraphId && activeGraphId !== id) {
    presenceDepart(activeGraphId);
  }
  stopPresenceHeartbeat();
  stopAccessDeniedPoll();
  presenceState = new Map();
  accessDenied = false;
  activeGraphId = id;
  try { localStorage.setItem(ACTIVE_GRAPH_STORAGE_KEY, String(id)); } catch {}
  applyView(getViewPref(id));
  if (pushState) history.pushState({ graphId: id }, '', `/g/${id}`);
  renderSidebar();
  if (cy) cy.elements().remove();
  // In parallel: load the graph contents and the graph row metadata. The
  // metadata write to recents is best-effort — if the graph doesn't exist,
  // fetchGraph will surface the failure.
  const [, graphRow] = await Promise.all([
    fetchGraph(),
    fetch(`/api/graphs/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  if (graphRow) {
    currentGraph = graphRow;
    recentsUpsert(graphRow);
    renderSidebar();
    applySettings();
  }
  applyReadOnlyState();
  if (typeof updateToolbar === 'function') updateToolbar();
  openGraphEventStream(id);
  // Presence: hydrate current snapshot, announce self, start heartbeat.
  presenceHydrate(id);
  presenceAnnounce(id);
  startPresenceHeartbeat(id);
  renderPresenceBar();
  // Own writer_id can vary per graph (per-graph presence identity), so the
  // selection color needs to be re-applied after the switch.
  if (typeof applyOwnSelectionColor === 'function') applyOwnSelectionColor();
  // Follow-toggle pref: pull per-graph + default in parallel and apply.
  // Per-graph row is only WRITTEN on first toggle, never on read — so old
  // graphs that haven't been toggled keep falling back to the live default.
  loadFollowPref(id).then((value) => {
    followToggleEnabled = value;
    updateFollowToggleUI();
  });
}

// Live-update plumbing: open one EventSource per active graph. When the
// server emits a change (any task/edge mutation in this graph), do a
// selection-preserving refetch. The native EventSource auto-reconnects on
// drop, so we don't need our own retry loop here.
let _graphEventSource = null;
let _graphEventTimer = null;
// Most recent event payload from this burst, used for agent-follow targeting.
let _graphEventLastPayload = null;

// Track the last user-driven interaction (mousedown / keydown / wheel)
// so agent-follow doesn't yank the camera mid-drag or while typing. Idle
// threshold: 2 seconds.
let _lastUserInteractionAt = 0;
function noteUserInteraction() { _lastUserInteractionAt = Date.now(); }
function userInteractedRecently() { return Date.now() - _lastUserInteractionAt < 2000; }
['pointerdown', 'keydown', 'wheel'].forEach((evt) => {
  window.addEventListener(evt, noteUserInteraction, true);
});

// When the tab becomes visible again, snap the camera to whichever node
// the current agent is on — *instantly*, no animation. The document.hidden
// guards in maybeFollowSelection / refreshFromEvent already keep us from
// queueing pans while hidden, so there's nothing to replay; we just want
// the user to see the current state the moment they return, not the pre-
// switch state plus a delayed pan.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  snapCameraToCurrentAgentTarget();
});

function snapCameraToCurrentAgentTarget() {
  if (!cy) return;
  if (!followToggleEnabled) return;
  // Find a peer selection from an agent we'd follow (same multi-agent rules
  // as the live follow). First match wins; with a single active agent there
  // is only one match anyway.
  let targetNode = null;
  for (const [writerId, sel] of peerSelectionState) {
    if (!shouldFollowSelectionFrom(writerId)) continue;
    const anchor = sel.cursor_anchor || sel.editing;
    if (!anchor || anchor.kind !== 'node' || anchor.id == null) continue;
    const node = cy.getElementById(String(anchor.id));
    if (!node || node.empty()) continue;
    targetNode = node;
    break;
  }
  if (!targetNode) return;
  // Instant pan: replicate centerNodeInVisibleArea's math but use cy.panBy
  // (synchronous) instead of cy.animate (220ms ease).
  const panel = document.getElementById('panel');
  const panelWidth = panel && !panel.classList.contains('hidden')
    ? panel.getBoundingClientRect().width
    : 0;
  const targetX = (cy.width() - panelWidth) / 2;
  const targetY = cy.height() / 2;
  const pos = targetNode.renderedPosition();
  const dx = targetX - pos.x;
  const dy = targetY - pos.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  cy.panBy({ x: dx, y: dy });
}

// --- Presence (multiplayer avatars) ---
// Per-graph map of writerId -> {id, name, type, lastSeen}. Updated by SSE
// events from the server (other people joining/renaming/leaving) and our own
// optimistic local writes. Re-rendered on every change.
const VISIBLE_AVATARS = 4;
// Hard cap on individually-rendered avatars (including own). Anything past
// this collapses into a single "+N others" overflow chip at the far end of
// the stack, hover-explained.
// Hard cap on individual avatars shown in the presence bar. Anything past
// this folds into a single "+N others" chip at the leftmost position.
// 7 + chip = 8 icons total, which keeps the bar's measured width bounded
// (~150px even in stack mode) so the panel-resize cap (computePanelMaxWidth)
// has enough headroom on narrow viewports and the bar never has to slide
// into the sidebar or off-screen to clear a wide panel.
const MAX_AVATARS = 7;
const PRESENCE_HEARTBEAT_MS = 20000;
let presenceState = new Map();
let _presenceHeartbeatTimer = null;

function presenceCurrentOwnId() {
  if (!activeGraphId) return null;
  const id = getOrCreateIdentity(activeGraphId);
  return id ? id.id : null;
}

// Uniform spacing bumper for floating UI groups (presence bar, follow toggle
// button, future canvas overlays). Each group reserves UI_BUMPER px on every
// side that other groups can't encroach into; when two bumpers meet they
// stack, so the visible gap between groups is at least 2 × UI_BUMPER. This
// keeps the layout from collapsing into overlaps when the panel is wide,
// when the sidebar collapses, or when an agent joins and the play/pause
// button appears.
const UI_BUMPER = 16;
const PANEL_BAR_GAP = 16;     // matches what adjustPresenceBarOffset writes
const PANEL_MIN_WIDTH = 320;

// Largest panel width that still leaves room for the sidebar and the
// presence bar, each with their own bumper. The follow-toggle button is
// no longer a separate obstacle — it sits directly beneath the bar (same
// right edge), so the bar's bumper already covers it.
//
// Sidebar width is read from --sidebar-w (the CSS variable), NOT from
// sidebar.getBoundingClientRect(). The sidebar has a 0.7s width transition;
// getBoundingClientRect would return the in-progress animated width and
// give us the wrong target, leaving the panel uncapped until the next
// unrelated re-clamp trigger fires (e.g. a 20s heartbeat-driven rerender).
function computePanelMaxWidth() {
  const bar = document.getElementById('presence-bar');
  if (!bar) return null;
  const sidebarWvar = getComputedStyle(document.documentElement)
    .getPropertyValue('--sidebar-w').trim();
  const sidebarRight = parseFloat(sidebarWvar) || 0;
  const barW = bar.getBoundingClientRect().width;
  // Leftmost screen-x the presence bar's LEFT edge is allowed to reach.
  // Two bumpers stack here (one from the sidebar, one from the bar) so the
  // visible gap is at least 2 × UI_BUMPER.
  const minBarLeft = sidebarRight + 2 * UI_BUMPER;
  // adjustPresenceBarOffset places the bar at `right = panelW + PANEL_BAR_GAP`,
  // so bar.left = viewport.width - panelW - PANEL_BAR_GAP - barW. Solve for panelW.
  const max = window.innerWidth - PANEL_BAR_GAP - barW - minBarLeft;
  return Math.max(PANEL_MIN_WIDTH, max);
}

function adjustPresenceBarOffset() {
  const bar = document.getElementById('presence-bar');
  const panel = document.getElementById('panel');
  if (!bar) return;
  // When the task panel is open, shift the avatar bar left of the panel so
  // the own avatar doesn't sit on top of the panel's close button. Also
  // clamp the panel down to its bumper-aware max in case the layout changed
  // (sidebar collapsed, follow-toggle button appeared, viewport shrank).
  if (panel && !panel.classList.contains('hidden')) {
    const max = computePanelMaxWidth();
    if (max != null) {
      const current = panel.getBoundingClientRect().width;
      if (current > max) panel.style.width = `${max}px`;
    }
    const w = panel.getBoundingClientRect().width;
    let barRight = Math.round(w) + PANEL_BAR_GAP;
    // Hard floor on bar.right so the bar's LEFT edge can never cross the
    // sidebar bumper. Without this, an extreme-narrow viewport (where the
    // panel can't shrink below its 320px min and the bar has nowhere left
    // to go) would push the bar off-screen left or onto the sidebar.
    // Constraint: bar.left = viewport.width - barRight - barW >= sidebarW + UI_BUMPER
    //   →        barRight <= viewport.width - barW - sidebarW - UI_BUMPER
    const sidebarW = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'),
    ) || 0;
    const barW = bar.getBoundingClientRect().width;
    const maxBarRight = window.innerWidth - barW - sidebarW - UI_BUMPER;
    if (barRight > maxBarRight) barRight = Math.max(0, maxBarRight);
    bar.style.right = `${barRight}px`;
  } else {
    bar.style.right = '';
  }
  // Keep the follow-toggle button's CENTER aligned under the own avatar's
  // center (LU in the screenshots). Avatar is 32px wide; button is 40px
  // wide; matching `right` values would put the avatar's right edge at
  // the button's right edge but leave the button's center 4px to the
  // left of the avatar's center. Offset by (button_w - avatar_w) / 2 = 4
  // so centers align.
  const btn = document.getElementById('btn-follow-toggle');
  if (btn) {
    const barRight = bar.style.right;
    btn.style.right = barRight
      ? `${parseFloat(barRight) - 4}px`
      : '';  // fall back to CSS default `right: 12px` which is 16 - 4
  }
  // Eye icon sits at top-right of the chrome cluster — when the cluster
  // shifts left to dodge the panel, the eye has to follow or it ends up
  // under the panel where the user can't see it or hover-trigger it.
  // Default CSS has bar at right:16 + eye at right:2 (14px offset between
  // them). Preserve that offset when shifting.
  const eye = document.getElementById('presence-eye');
  if (eye) {
    const barRight = bar.style.right;
    eye.style.right = barRight
      ? `${Math.max(2, parseFloat(barRight) - 14)}px`
      : '';  // CSS default `right: 2px`
  }
}

// Watch the panel's class attribute and re-run the presence-bar adjustment
// every time `.hidden` is added or removed. Belt-and-suspenders for the
// explicit calls in showPanel/hidePanel/cancelPendingNode/ghost-create — any
// future path that toggles the panel's visibility (or anything that adds a
// different state class) gets the bar offset reconciled automatically.
let _panelClassObserver = null;
function startPanelClassObserver() {
  if (_panelClassObserver) return;
  const panel = document.getElementById('panel');
  if (!panel) return;
  _panelClassObserver = new MutationObserver(() => adjustPresenceBarOffset());
  _panelClassObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
}

function renderPresenceBar() {
  const bar = document.getElementById('presence-bar');
  if (!bar) return;
  const ownId = presenceCurrentOwnId();
  if (!activeGraphId || !ownId) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    // Bar disappeared: re-evaluate the cap (panel can grow now). Run on next
    // frame so the bar's hidden class has actually applied.
    requestAnimationFrame(() => adjustPresenceBarOffset());
    return;
  }
  const ownIdentity = effectiveIdentity(activeGraphId);
  const others = Array.from(presenceState.values())
    .filter((w) => w.id !== ownId)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const own = {
    id: ownId,
    name: ownIdentity.name,
    type: 'human',
    lastSeen: Date.now(),
  };
  const ordered = [own, ...others];

  bar.classList.remove('hidden');
  bar.innerHTML = '';
  if (ordered.length < 5) {
    // Row mode: every avatar fully visible, no overlap.
    for (const w of ordered) {
      bar.appendChild(presenceAvatarEl(w, w.id === ownId));
    }
  } else {
    // Stack mode: all avatars overlap into one deck. We render in REVERSE
    // of the items so own (originally at index 0) becomes the LAST DOM
    // child — naturally painted on top, and visually rightmost.
    // Past MAX_AVATARS, the oldest others fold into a single "+N others"
    // overflow chip that lives at the leftmost (first DOM) position.
    const deck = document.createElement('div');
    deck.className = 'presence-stack-deck';
    deck.setAttribute('aria-label', `${ordered.length} active`);

    const overflowCount = Math.max(0, ordered.length - MAX_AVATARS);
    const visible = overflowCount > 0 ? ordered.slice(0, MAX_AVATARS) : ordered;

    // Render in reverse: leftmost (oldest) appended first, own appended last.
    for (const w of visible.slice().reverse()) {
      deck.appendChild(presenceAvatarEl(w, w.id === ownId));
    }
    if (overflowCount > 0) {
      // Insert the "+N" chip at the very front of the deck (DOM-first =
      // leftmost = painted underneath the visible avatars where they overlap).
      deck.insertBefore(presenceOverflowEl(overflowCount), deck.firstChild);
    }
    bar.appendChild(deck);
  }
  // After the bar's DOM has been rebuilt, the bar's measured width may
  // have changed (added/removed avatars or stack chip). Re-clamp the panel
  // so it respects the new bumper-aware max. Deferred to next frame so the
  // browser has laid out the new content before we measure.
  requestAnimationFrame(() => adjustPresenceBarOffset());
}

function presenceOverflowEl(n) {
  const el = document.createElement('div');
  el.className = 'presence-avatar presence-avatar-overflow is-active';
  el.setAttribute('data-tooltip', `+${n} others`);
  el.textContent = `+${n}`;
  return el;
}

function presenceAvatarEl(writer, isOwn) {
  const el = document.createElement('div');
  el.className = 'presence-avatar';
  if (isOwn) el.classList.add('presence-avatar-own');
  if (writer.type === 'agent') el.classList.add('presence-avatar-agent');
  const color = colorForId(writer.id);
  el.style.background = color;
  el.style.setProperty('--avatar-glow', color);
  // Server flips active/idle and broadcasts the transition. Treat missing
  // field as active so an older server (no active flag) keeps everyone lit.
  const isActive = isOwn || writer.active !== false;
  el.classList.add(isActive ? 'is-active' : 'is-idle');
  const suffix = isOwn ? ' (You)' : (writer.type === 'agent' ? ' (Agent)' : '');
  el.setAttribute('data-tooltip', writer.name + suffix);
  el.textContent = writer.type === 'agent' ? '🤖' : initialsFromName(writer.name);
  if (isOwn) {
    el.addEventListener('click', openRenameModal);
  }
  return el;
}

async function presenceHydrate(gid) {
  try {
    const r = await fetch(`/api/graphs/${encodeURIComponent(gid)}/presence`);
    if (!r.ok) return;
    const list = await r.json();
    if (gid !== activeGraphId) return; // raced past a graph switch
    presenceState = new Map(list.map((w) => [w.id, w]));
    renderPresenceBar();
    // Catch up on peer selections too — without this a late-joining tab
    // wouldn't see existing peer outlines until something changes.
    if (typeof hydratePeerSelections === 'function') hydratePeerSelections();
    // Re-evaluate follow-toggle visibility now that we know who's on the graph.
    if (typeof updateFollowToggleUI === 'function') updateFollowToggleUI();
  } catch {}
}

function presenceAnnounce(gid) {
  if (!gid) return;
  const identity = effectiveIdentity(gid);
  if (!identity) return;
  fetch(`/api/graphs/${encodeURIComponent(gid)}/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: identity.id, name: identity.name, type: 'human' }),
  }).catch(() => {});
}

function presenceDepart(gid) {
  if (!gid) return;
  const identity = getOrCreateIdentity(gid);
  if (!identity) return;
  const url = `/api/graphs/${encodeURIComponent(gid)}/presence/${encodeURIComponent(identity.id)}`;
  // Prefer sendBeacon for unload reliability; fall back to fetch with keepalive.
  if (navigator.sendBeacon) {
    try {
      const blob = new Blob([''], { type: 'text/plain' });
      // sendBeacon only POSTs. Use a fetch with keepalive for DELETE.
      // Browsers support fetch keepalive for unload events on most platforms.
      navigator.sendBeacon; // referenced to satisfy strict mode in some tooling
    } catch {}
  }
  try {
    fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {});
  } catch {}
}

function startPresenceHeartbeat(gid) {
  stopPresenceHeartbeat();
  if (!gid) return;
  _presenceHeartbeatTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (gid !== activeGraphId) return;
    presenceAnnounce(gid);
  }, PRESENCE_HEARTBEAT_MS);
}
function stopPresenceHeartbeat() {
  if (_presenceHeartbeatTimer) {
    clearInterval(_presenceHeartbeatTimer);
    _presenceHeartbeatTimer = null;
  }
}

function handlePresenceEvent(payload) {
  if (!payload || payload.kind !== 'presence' || !payload.writer) return;
  const ownId = presenceCurrentOwnId();
  // The server includes the local user too. Skip applying their own write back
  // to local state — render always synthesizes "own" from local identity.
  if (payload.writer.id === ownId) return;
  if (payload.op === 'depart') {
    presenceState.delete(payload.writer.id);
    // Also drop any peer-selection state for this writer so stale outlines
    // don't linger between the depart frame and the SSE selection 'cleared'
    // frame (they ride on the same broadcast but render order is incidental).
    if (peerSelectionState.delete(payload.writer.id)) applyPeerSelectionToCy();
  } else {
    presenceState.set(payload.writer.id, payload.writer);
    // Refresh any active peer-selection entry so its color/name reflect the
    // latest writer object (e.g. after a rename).
    if (peerSelectionState.has(payload.writer.id)) applyPeerSelectionToCy();
  }
  renderPresenceBar();
  // An agent joining/leaving should show/hide the follow-toggle button.
  if (typeof updateFollowToggleUI === 'function') updateFollowToggleUI();
}

// ---- Peer selection rendering ---------------------------------------------
// State: per peer (writer_id), what they have selected/are editing on the
// graph. Driven by SSE `kind: 'selection'` frames from src/selectionState.js.
// Renders as colored cytoscape underlays + dashed borders (T256). The cursor
// label overlay (T257) reads the same state.
const peerSelectionState = new Map();

// Cytoscape doesn't honor CSS variables on elements; per-element colors must
// be threaded via data() interpolation (already used at line 5419 for
// background-color). Each peer's rules use data(peerColor) — set on the cy
// element by applyPeerSelectionToCy.
function applyPeerSelectionToCy() {
  if (!cy) return;
  // Wipe existing peer classes first, then re-apply from current state.
  cy.elements('.peer-selected, .peer-editing').forEach((el) => {
    el.removeClass('peer-selected peer-editing');
    el.removeData('peerColor');
  });
  // Same wipe for kanban cards. Cards are paint-target #2 alongside cy
  // elements — same source-of-truth (peerSelectionState), parallel render.
  document.querySelectorAll('.kb-card.peer-selected, .kb-card.peer-editing').forEach((c) => {
    c.classList.remove('peer-selected', 'peer-editing');
    c.style.removeProperty('--peer-color');
  });
  // Group peers by element id so each element computes its color from the
  // same "lead" peer that the cursor marker uses (editing-first, then by
  // writer_id). Otherwise the node's outline and the marker pill end up
  // in different colors when 2+ peers are on the same node.
  // Map<elementId, { isEditing: bool, peers: [{ writerId, color, sel }] }>
  const groups = new Map();
  const visit = (elemId, peer, isEditing) => {
    let g = groups.get(elemId);
    if (!g) { g = { isEditing: false, peers: [] }; groups.set(elemId, g); }
    if (isEditing) g.isEditing = true;
    g.peers.push(peer);
  };
  for (const [writerId, sel] of peerSelectionState) {
    // Skip idle HUMAN peers — selection state has no expiry but presence
    // flips active=false after ACTIVE_WINDOW_MS (60s) of no writes. For
    // agents, presence membership IS the "still working" signal (Stop hook
    // DELETEs at end of turn), so an agent pondering >60s without writes
    // should still render its marker. Per-type filter handles both.
    const writer = presenceState.get(writerId);
    if (writer && writer.type !== 'agent' && writer.active === false) continue;
    const peer = { writerId, sel, color: colorForId(writerId) };
    for (const id of sel.node_ids ?? []) visit(String(id), peer, false);
    for (const id of sel.edge_ids ?? []) visit(String(id), peer, false);
    if (sel.editing) visit(String(sel.editing.id), peer, true);
  }
  for (const [elemId, g] of groups) {
    const el = cy.getElementById(elemId);
    if (!el || el.empty()) continue;
    // Lead peer: editing peer first, then first by writer_id. Mirrors
    // peerCursorRenderGroup so the marker and the outline reference the
    // same peer's color.
    const lead = g.peers.slice().sort((a, b) => {
      const ae = a.sel.editing ? 0 : 1;
      const be = b.sel.editing ? 0 : 1;
      if (ae !== be) return ae - be;
      return a.writerId < b.writerId ? -1 : 1;
    })[0];
    el.data('peerColor', lead.color);
    // Always apply peer-selected if anyone selected this element. Add
    // peer-editing on top if at least one peer has it as their editing
    // target — the dashed border reads on top of the underlay.
    el.addClass('peer-selected');
    if (g.isEditing) el.addClass('peer-editing');
    // Kanban: paint the corresponding card if it's rendered. peerSelectionState
    // tracks node + edge ids; cards exist only for nodes (tasks). Edges are
    // hidden in kanban, so skip those groups silently.
    const card = document.querySelector(`.kb-card[data-task-id="${elemId}"]`);
    if (card) {
      card.style.setProperty('--peer-color', lead.color);
      card.classList.add('peer-selected');
      if (g.isEditing) card.classList.add('peer-editing');
    }
  }
  // Refresh labeled cursors in lock-step with the cytoscape highlights.
  if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
}

function handleSelectionEvent(payload) {
  if (!payload || payload.kind !== 'selection') return;
  const ownId = presenceCurrentOwnId();
  // Skip our own selection coming back from the server — local cy already
  // shows it via the 'selected' class set by cy.on('select').
  if (payload.writer_id === ownId) return;
  // The peer just did something — they're active by definition. Bump their
  // local presence state to active=true so applyPeerSelectionToCy doesn't
  // skip them due to a stale idle flag from an earlier ACTIVE_WINDOW timeout.
  // Server-side `touch()` flips them active and emits a presence event too,
  // but the presence vs selection event order over SSE isn't guaranteed — if
  // selection arrives first we'd otherwise drop the paint.
  const peerWriter = presenceState.get(payload.writer_id);
  if (peerWriter && peerWriter.active === false) peerWriter.active = true;
  if (payload.op === 'cleared') {
    if (!peerSelectionState.delete(payload.writer_id)) return;
  } else {
    peerSelectionState.set(payload.writer_id, {
      node_ids: payload.node_ids ?? [],
      edge_ids: payload.edge_ids ?? [],
      editing: payload.editing ?? null,
      cursor_anchor: payload.cursor_anchor ?? null,
    });
    // Camera-follow on the agent's announce_focus, not just the subsequent
    // PATCH. Agents POST selection before they edit, so without this the
    // peer-cursor tag would render at the new node's rendered position
    // while the camera was still on the previous node — the tag visually
    // floats until the PATCH lands and triggers the pan.
    maybeFollowSelection(payload);
  }
  applyPeerSelectionToCy();
  // T257 will hook here too to redraw cursor labels.
}

function maybeFollowSelection(payload) {
  if (!cy) return;
  if (!followToggleEnabled) return;
  // Hidden tab → don't pan. rAF is throttled/paused, so cy.animate calls
  // would queue and replay in a burst when the tab returns.
  if (document.hidden) return;
  if (userInteractedRecently()) return;
  if (!shouldFollowSelectionFrom(payload.writer_id)) return;
  const anchor = payload.cursor_anchor || payload.editing;
  if (!anchor || anchor.kind !== 'node' || anchor.id == null) return;
  const node = cy.getElementById(String(anchor.id));
  if (!node || node.empty()) return;
  centerNodeInVisibleArea(node);
}

// Companion to shouldFollowAgentEvent for selection events. Same multi-agent
// rules: 0 agents → never; 1 agent → follow it; 2+ agents → follow only
// agents owned by me. Keyed on writer_id (no payload.id with a row to read
// last_modified_by_user from, so we read the agent's owner_user_id directly
// off presenceState).
function shouldFollowSelectionFrom(writerId) {
  const writer = presenceState.get(writerId);
  if (!writer || writer.type !== 'agent') return false;
  const activeAgents = Array.from(presenceState.values())
    .filter((w) => w.type === 'agent');
  if (activeAgents.length === 0) return false;
  if (activeAgents.length === 1) return true;
  const me = window.gtUser?.id ?? null;
  if (me == null) return false;
  return writer.owner_user_id != null && writer.owner_user_id === me;
}

// Debounced POST of the local cytoscape selection so peers see what we have
// selected/are editing. Debounce window matches the server-side rate-limit
// guard (50ms) with a margin — shift-selecting 30 nodes fires 30 events;
// we coalesce to ~2-3 POSTs.
let _postLocalSelectionTimer = null;
let _lastPostedSelectionKey = '';
// Stable cursor anchor across re-broadcasts. Keeps the peer name pill
// pinned to the same selected element while you grow / shrink a multi-
// selection; only moves when the anchored element leaves the set.
let _localAnchor = null; // { kind: 'node'|'edge', id } | null

// Mirror a kanban card's .selected DOM class onto the matching cy node's
// .selected class so postLocalSelection (which reads cy.nodes('.selected'))
// broadcasts the full kanban selection — not just the one card whose
// panel is open. cy stays in lock-step with kanban so the selection
// survives view switches too.
function mirrorKbCardSelectionToCy(card) {
  if (!cy || !card) return;
  const tid = card.dataset.taskId;
  if (!tid) return;
  const el = cy.getElementById(String(tid));
  if (el.empty()) return;
  if (card.classList.contains('selected')) el.addClass('selected');
  else el.removeClass('selected');
}

function postLocalSelection() {
  if (_postLocalSelectionTimer) clearTimeout(_postLocalSelectionTimer);
  _postLocalSelectionTimer = setTimeout(() => {
    _postLocalSelectionTimer = null;
    if (!cy || !activeGraphId) return;
    const ownId = presenceCurrentOwnId();
    if (!ownId) return;
    // This codebase uses the .selected CSS class (manually managed in tap
    // handlers / data-refresh) rather than cytoscape's native :selected
    // pseudo-class. Read from the class so we stay in sync.
    const nodeIds = cy.nodes('.selected').map((n) => Number(n.id())).filter(Number.isFinite);
    const edgeIds = cy.edges('.selected').map((e) => Number(e.id())).filter(Number.isFinite);
    // editing field: the side panel is the canonical "I'm actively editing
    // this" signal. It's set by showPanel via editingTaskId, cleared by
    // hidePanel. BUT: if the panel was opened programmatically (e.g. by
    // followAgentEdit auto-surfacing an agent's update), the local user
    // is a passive viewer — not actually editing. Skip the broadcast in
    // that case so peers don't see this user as "editing along" with
    // every node the agent touches.
    const panel = document.getElementById('panel');
    const panelOpen = panel && !panel.classList.contains('hidden');
    const editing = (panelOpen && editingTaskId != null && !_panelOpenedProgrammatically)
      ? { kind: 'node', id: Number(editingTaskId) }
      : null;
    // Cursor anchor: prefer the editing target, else stick to a stable
    // member of the selection so the peer name pill doesn't disappear
    // mid-multi-select. Nodes win over edges when both are selected.
    // Keep the previous anchor if it's still in the set; otherwise pick
    // the first remaining. Clears when the selection empties.
    let cursor_anchor = null;
    if (editing) {
      cursor_anchor = editing;
    } else {
      const candidates = nodeIds.length > 0
        ? nodeIds.map((id) => ({ kind: 'node', id }))
        : edgeIds.map((id) => ({ kind: 'edge', id }));
      if (candidates.length > 0) {
        const stillIn = _localAnchor && candidates.some(
          (c) => c.kind === _localAnchor.kind && c.id === _localAnchor.id
        );
        if (!stillIn) _localAnchor = candidates[0];
        cursor_anchor = _localAnchor;
      } else {
        _localAnchor = null;
      }
    }
    const key = JSON.stringify([nodeIds, edgeIds, editing, cursor_anchor]);
    if (key === _lastPostedSelectionKey) return;
    _lastPostedSelectionKey = key;
    const headers = { 'Content-Type': 'application/json', 'X-Writer-Id': ownId };
    const identity = effectiveIdentity(activeGraphId);
    if (identity?.name) headers['X-Writer-Name'] = identity.name;
    if (identity?.type) headers['X-Writer-Type'] = identity.type;
    fetch(`/api/graphs/${activeGraphId}/selection`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ node_ids: nodeIds, edge_ids: edgeIds, editing, cursor_anchor }),
      keepalive: true,
    }).catch(() => {});
  }, 120);
}

// Hydrate peer selections on graph open / SSE reconnect so a late joiner
// sees peers' current state without waiting for the next change.
async function hydratePeerSelections() {
  if (!activeGraphId) return;
  try {
    const r = await fetch(`/api/graphs/${activeGraphId}/selection`);
    if (!r.ok) return;
    const list = await r.json();
    const ownId = presenceCurrentOwnId();
    peerSelectionState.clear();
    for (const sel of list) {
      if (sel.writer_id === ownId) continue;
      peerSelectionState.set(sel.writer_id, {
        node_ids: sel.node_ids ?? [],
        edge_ids: sel.edge_ids ?? [],
        editing: sel.editing ?? null,
        cursor_anchor: sel.cursor_anchor ?? null,
      });
    }
    applyPeerSelectionToCy();
  } catch {}
}
// ---- end peer selection rendering -----------------------------------------

// ---- Peer cursor overlay (glowing dot + name pill) ----------------------
// One DOM marker per ANCHOR (node/edge), not per peer — so multiple peers
// focused on the same node stack into one marker rather than overlapping
// in the same slot. Three rendering modes by peer count:
//   1 peer        : dot + full name pill (the common case)
//   2-4 peers     : vertically stacked rows, each = dot + initials pill
//                   (editing peer placed at the top so it's nearest the node)
//   5+ peers      : one larger dot + "AB & N others" pill
// Slot placement uses an 8-direction probe (deterministic, no simulation)
// so the marker never overlaps the anchor or any other node bbox.

const _peerCursorSlots = new Map();   // anchorKey ("node:123" | "edge:45") → { el }
const STACK_INITIALS_THRESHOLD = 2;   // ≥ this many peers → use initials
const STACK_OVERFLOW_THRESHOLD = 5;   // ≥ this many peers → overflow chip

function peerCursorMakeEl() {
  const layer = document.getElementById('peer-cursor-layer');
  if (!layer) return null;
  const el = document.createElement('div');
  el.className = 'peer-cursor peer-cursor-enter';
  layer.appendChild(el);
  requestAnimationFrame(() => el.classList.remove('peer-cursor-enter'));
  return el;
}

function peerCursorAnchorKey(sel) {
  const pick = sel.cursor_anchor || sel.editing
    || (sel.node_ids?.[0] != null ? { kind: 'node', id: sel.node_ids[0] } : null)
    || (sel.edge_ids?.[0] != null ? { kind: 'edge', id: sel.edge_ids[0] } : null);
  if (!pick) return null;
  return `${pick.kind}:${pick.id}`;
}

// Build the inner HTML for an anchor's group of peers. Single peer → full
// name pill. 2-4 peers → vertically stacked dot+initials rows, editing
// peer at the top. 5+ → big dot + "AB & N others" using the editing (or
// first) peer's initials and color.
function peerCursorRenderGroup(el, peers) {
  // Stable ordering: editing peer(s) first so they render closest to the
  // node, then by writer_id for determinism.
  const sorted = peers.slice().sort((a, b) => {
    const ae = a.sel.editing ? 0 : 1;
    const be = b.sel.editing ? 0 : 1;
    if (ae !== be) return ae - be;
    return a.writerId < b.writerId ? -1 : 1;
  });

  el.classList.remove('peer-cursor-stack', 'peer-cursor-overflow');

  if (sorted.length < STACK_INITIALS_THRESHOLD) {
    // Single peer: dot + full name. Color = peer color.
    const p = sorted[0];
    el.style.setProperty('--peer-color', p.color);
    el.innerHTML =
      '<span class="peer-cursor-dot"></span>' +
      '<span class="peer-cursor-pill"></span>';
    el.querySelector('.peer-cursor-pill').textContent = p.name;
    return;
  }

  if (sorted.length < STACK_OVERFLOW_THRESHOLD) {
    // 2-4: stacked rows, initials only, each in its peer's color.
    el.classList.add('peer-cursor-stack');
    el.style.removeProperty('--peer-color');
    el.innerHTML = '';
    for (const p of sorted) {
      const row = document.createElement('span');
      row.className = 'peer-cursor-row';
      row.style.setProperty('--peer-color', p.color);
      row.title = p.name;
      row.innerHTML =
        '<span class="peer-cursor-dot"></span>' +
        '<span class="peer-cursor-pill"></span>';
      row.querySelector('.peer-cursor-pill').textContent = initialsFromName(p.name);
      el.appendChild(row);
    }
    return;
  }

  // 5+ peers: overflow chip with one larger dot and a "AB & N others" pill.
  // Color/initials come from the editing (or first) peer per ordering above.
  el.classList.add('peer-cursor-overflow');
  const lead = sorted[0];
  el.style.setProperty('--peer-color', lead.color);
  el.title = sorted.map((p) => p.name).join(', ');
  const otherCount = sorted.length - 1;
  el.innerHTML =
    '<span class="peer-cursor-dot"></span>' +
    '<span class="peer-cursor-pill"></span>';
  el.querySelector('.peer-cursor-pill').textContent =
    `${initialsFromName(lead.name)} & ${otherCount} other${otherCount === 1 ? '' : 's'}`;
}

// 8-slot probe: place the marker just outside the anchor bbox in one of
// 8 directions; pick the first slot whose marker rect doesn't intersect
// any other node bbox AND fits inside the cy container. Falls back to a
// best-effort choice (N or S, whichever has more in-bounds space) if
// every slot has a problem. Slot is the marker's top-left corner in
// rendered coords (which is cy-container-relative — same space as
// renderedBoundingBox).
function peerCursorPickSlot(anchorBb, markerW, markerH, otherBboxes) {
  // GAP scales with zoom so the tag sits proportionally close to the node.
  // At zoom=1 it's the historical 8px; zoomed out the node renders smaller
  // and a constant 8px would look detached, so we scale down (floored at
  // 2px to keep some breathing room).
  const zoomFactor = cy ? cy.zoom() : 1;
  const GAP = Math.max(2, Math.min(16, 8 * zoomFactor));
  const viewW = cy ? cy.width() : Infinity;
  const viewH = cy ? cy.height() : Infinity;
  const cx = (anchorBb.x1 + anchorBb.x2) / 2 - markerW / 2;
  const cy_ = (anchorBb.y1 + anchorBb.y2) / 2 - markerH / 2;
  const slots = [
    { x: cx,                       y: anchorBb.y1 - markerH - GAP }, // N
    { x: anchorBb.x2 + GAP,        y: anchorBb.y1 - markerH - GAP }, // NE
    { x: anchorBb.x2 + GAP,        y: cy_ },                          // E
    { x: anchorBb.x2 + GAP,        y: anchorBb.y2 + GAP },            // SE
    { x: cx,                       y: anchorBb.y2 + GAP },            // S
    { x: anchorBb.x1 - markerW - GAP, y: anchorBb.y2 + GAP },         // SW
    { x: anchorBb.x1 - markerW - GAP, y: cy_ },                       // W
    { x: anchorBb.x1 - markerW - GAP, y: anchorBb.y1 - markerH - GAP },// NW
  ];
  for (const s of slots) {
    const sx2 = s.x + markerW;
    const sy2 = s.y + markerH;
    // Skip slots that clip the viewport — a tall stack near the top edge
    // would otherwise lose its uppermost row to overflow: hidden.
    if (s.x < 0 || s.y < 0 || sx2 > viewW || sy2 > viewH) continue;
    let overlap = false;
    for (const bb of otherBboxes) {
      if (s.x < bb.x2 && sx2 > bb.x1 && s.y < bb.y2 && sy2 > bb.y1) {
        overlap = true;
        break;
      }
    }
    if (!overlap) return s;
  }
  // Nothing perfect: prefer the slot whose top-left is in-bounds and
  // closest to the anchor, even if it overlaps something.
  return slots.find((s) =>
    s.x >= 0 && s.y >= 0 && s.x + markerW <= viewW && s.y + markerH <= viewH,
  ) || slots[4 /* S */] || slots[0];
}

// Read the local cytoscape selection in the same shape peerSelectionState
// holds for peers, so peerCursorRefresh can render a "<name> (You)" pill on
// the local user's own focused node. Mirrors postLocalSelection's anchor
// logic — editing target wins, otherwise _localAnchor (with fallback to the
// first remaining selected element). Returns null when the user has nothing
// selected (no pill to draw).
function computeLocalCursorSel() {
  if (!cy) return null;
  const nodeIds = cy.nodes('.selected').map((n) => Number(n.id())).filter(Number.isFinite);
  const edgeIds = cy.edges('.selected').map((e) => Number(e.id())).filter(Number.isFinite);
  const panel = document.getElementById('panel');
  const panelOpen = panel && !panel.classList.contains('hidden');
  const editing = (panelOpen && editingTaskId != null && !_panelOpenedProgrammatically)
    ? { kind: 'node', id: Number(editingTaskId) }
    : null;
  if (editing) {
    return { node_ids: nodeIds, edge_ids: edgeIds, editing, cursor_anchor: editing };
  }
  if (nodeIds.length === 0 && edgeIds.length === 0) return null;
  const candidates = nodeIds.length > 0
    ? nodeIds.map((id) => ({ kind: 'node', id }))
    : edgeIds.map((id) => ({ kind: 'edge', id }));
  const stillIn = _localAnchor && candidates.some(
    (c) => c.kind === _localAnchor.kind && c.id === _localAnchor.id,
  );
  const cursor_anchor = stillIn ? _localAnchor : candidates[0];
  return { node_ids: nodeIds, edge_ids: edgeIds, editing: null, cursor_anchor };
}

function peerCursorRefresh() {
  if (!cy) return;
  // 1. Group peers by anchor key. One DOM marker per group. Idle HUMAN
  // peers are skipped (presence.active=false); agents are never filtered
  // on the active flag — see applyPeerSelectionToCy for the rationale.
  const groups = new Map(); // anchorKey → [{ writerId, sel, name, color }, ...]
  for (const [writerId, sel] of peerSelectionState) {
    const writer = presenceState.get(writerId);
    if (writer && writer.type !== 'agent' && writer.active === false) continue;
    const key = peerCursorAnchorKey(sel);
    if (!key) continue;
    const peer = {
      writerId,
      sel,
      name: writer?.name || 'Anonymous',
      color: colorForId(writerId),
    };
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(peer);
  }
  // Local user's own focused node — labeled "<name> (You)" so you can find
  // yourself on a large graph. Reuses the peer pill pipeline so stacking
  // with co-located peers Just Works; the .selected underlay still owns
  // the highlight color (applyPeerSelectionToCy isn't touched).
  const ownId = presenceCurrentOwnId();
  if (ownId) {
    const localSel = computeLocalCursorSel();
    if (localSel) {
      const key = peerCursorAnchorKey(localSel);
      if (key) {
        const baseName = effectiveIdentity(activeGraphId)?.name || 'You';
        const peer = {
          writerId: ownId,
          sel: localSel,
          name: `${baseName} (You)`,
          color: colorForId(ownId),
        };
        let arr = groups.get(key);
        if (!arr) { arr = []; groups.set(key, arr); }
        arr.push(peer);
      }
    }
  }
  // Kanban view uses card DOM rects instead of cy renderedBoundingBox.
  // Skip edge groups (no edges visible in kanban) and let cy-coord groups
  // fall through to the graph-view path below.
  if (currentView === 'kanban') {
    peerCursorRefreshKanban(groups);
    return;
  }

  // 2. Render each group; collect anchor bboxes for slot picking. Build the
  // "other nodes" bbox list once.
  const allBboxes = cy.nodes().map((n) => ({ id: n.id(), bb: n.renderedBoundingBox() }));
  const seen = new Set();
  for (const [key, peers] of groups) {
    const [kind, idStr] = key.split(':');
    const anchorEl = cy.getElementById(idStr);
    if (!anchorEl || anchorEl.empty()) continue;
    seen.add(key);
    let entry = _peerCursorSlots.get(key);
    if (!entry) {
      const el = peerCursorMakeEl();
      if (!el) continue;
      entry = { el };
      _peerCursorSlots.set(key, entry);
    }
    peerCursorRenderGroup(entry.el, peers);
    const anchorBb = anchorEl.renderedBoundingBox();
    // Measure after rendering so a freshly-resized stack contributes its
    // real bbox to the slot probe.
    const r = entry.el.getBoundingClientRect();
    const markerW = r.width || 80;
    const markerH = r.height || 18;
    const others = allBboxes.filter((o) => o.id !== anchorEl.id()).map((o) => o.bb);
    const slot = peerCursorPickSlot(anchorBb, markerW, markerH, others);
    entry.el.style.transform = `translate3d(${slot.x}px, ${slot.y}px, 0)`;
  }
  // 3. Remove DOM for anchors that no longer have peers.
  for (const key of Array.from(_peerCursorSlots.keys())) {
    if (!seen.has(key)) {
      _peerCursorSlots.get(key).el.remove();
      _peerCursorSlots.delete(key);
    }
  }
}

// Kanban variant: anchor cursors off card DOM rects instead of cy world
// coords. Skips edge groups (kanban hides edges). Always placed just above
// the card's top edge, left-aligned. Stack mode lays out horizontally in
// kanban (see style.css `.view-kanban .peer-cursor-stack`) so a 2-4 peer
// chip stays short enough that the slight overlap with the previous card
// only nicks the bottom edge — preferable to fragmenting placement across
// the side and confusing which card the chip belongs to.
function peerCursorRefreshKanban(groups) {
  const layer = document.getElementById('peer-cursor-layer');
  if (!layer) return;
  const layerRect = layer.getBoundingClientRect();
  const seen = new Set();
  for (const [key, peers] of groups) {
    const [kind, idStr] = key.split(':');
    if (kind !== 'node') continue; // edges not visible in kanban
    const card = document.querySelector(`.kb-card[data-task-id="${idStr}"]`);
    if (!card) continue;
    seen.add(key);
    let entry = _peerCursorSlots.get(key);
    if (!entry) {
      const el = peerCursorMakeEl();
      if (!el) continue;
      entry = { el };
      _peerCursorSlots.set(key, entry);
    }
    peerCursorRenderGroup(entry.el, peers);
    const cardRect = card.getBoundingClientRect();
    const markerRect = entry.el.getBoundingClientRect();
    const markerH = markerRect.height || 18;
    const GAP = 4;
    const x = cardRect.left - layerRect.left;
    const y = cardRect.top - layerRect.top - markerH - GAP;
    entry.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }
  // Clear stale markers for anchors no longer present.
  for (const key of Array.from(_peerCursorSlots.keys())) {
    if (!seen.has(key)) {
      _peerCursorSlots.get(key).el.remove();
      _peerCursorSlots.delete(key);
    }
  }
}

// ---- end peer cursor overlay --------------------------------------------

function openRenameModal() {
  if (!activeGraphId) return;
  const identity = effectiveIdentity(activeGraphId);
  if (!identity) return;
  const modal = document.getElementById('rename-modal');
  const input = document.getElementById('rename-modal-input');
  const save = document.getElementById('rename-modal-save');
  const cancel = document.getElementById('rename-modal-cancel');
  if (!modal || !input || !save || !cancel) return;

  input.value = identity.name;
  modal.classList.remove('hidden');
  setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 0);

  function close() {
    modal.classList.add('hidden');
    save.removeEventListener('click', onSave);
    cancel.removeEventListener('click', close);
    input.removeEventListener('keydown', onKey);
    modal.removeEventListener('click', onBackdrop);
  }
  function onSave() {
    const next = setIdentityName(activeGraphId, input.value);
    if (next) {
      presenceAnnounce(activeGraphId);
      renderPresenceBar();
    }
    close();
  }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); onSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }
  function onBackdrop(e) {
    if (e.target === modal) close();
  }
  save.addEventListener('click', onSave);
  cancel.addEventListener('click', close);
  input.addEventListener('keydown', onKey);
  modal.addEventListener('click', onBackdrop);
}

// Best-effort depart on unload (page close, tab close, navigation away).
window.addEventListener('pagehide', () => {
  if (activeGraphId) presenceDepart(activeGraphId);
});
window.addEventListener('beforeunload', () => {
  if (activeGraphId) presenceDepart(activeGraphId);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeGraphId) {
    presenceAnnounce(activeGraphId);
  }
});

function openGraphEventStream(id) {
  if (_graphEventSource) {
    try { _graphEventSource.close(); } catch {}
    _graphEventSource = null;
  }
  if (!id) return;
  const es = new EventSource(`/api/graphs/${id}/events`);
  es.onopen = () => {
    // Successful (re)connect after a stretch of being denied means access
    // was just re-granted. Probe the graph to leave the accessDenied state
    // instead of waiting for the 10-second poll.
    if (accessDenied && id === activeGraphId) {
      fetchGraph().catch(() => {});
    }
  };
  es.onmessage = (e) => {
    if (id !== activeGraphId) return;
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    if (payload && payload.kind === 'presence') {
      handlePresenceEvent(payload);
      return;
    }
    if (payload && payload.kind === 'selection') {
      handleSelectionEvent(payload);
      return;
    }
    _graphEventLastPayload = payload;
    // Coalesce bursts (e.g. a bulk-edges insert fires N notifications).
    if (_graphEventTimer) clearTimeout(_graphEventTimer);
    _graphEventTimer = setTimeout(() => {
      _graphEventTimer = null;
      const next = _graphEventLastPayload;
      _graphEventLastPayload = null;
      refreshFromEvent(next);
    }, 150);
  };
  es.onerror = () => {
    // Native EventSource will auto-reconnect; no-op here. Keep the handler
    // so errors don't bubble to the console as unhandled.
  };
  _graphEventSource = es;
}

async function refreshFromEvent(payload) {
  if (!cy) return;
  // Kanban flash + scroll hook — queue a flash AND a scroll-into-view on
  // the next renderKanban for any task INSERT/UPDATE. DELETE doesn't need
  // a flash (the card just vanishes when /tasks no longer returns it).
  // Scroll is gated on !userInteractedRecently() inside the apply step so
  // an agent edit doesn't yank the viewport mid-drag or while the user is typing.
  if (
    currentView === 'kanban'
    && payload && payload.kind === 'tasks'
    && (payload.op === 'INSERT' || payload.op === 'UPDATE')
    && payload.id != null
  ) {
    queueKanbanFlash(payload.id);
    queueKanbanScrollIntoView(payload.id);
  }
  // Graph-row UPDATE (anon_role / settings / name / description). Refetch
  // the row first so currentGraph + viewer_can_edit are fresh, then run a
  // normal canvas refresh — fetchGraph's 403 branch handles access
  // revocation by switching us into the accessDenied state.
  if (payload && payload.kind === 'graphs') {
    try {
      const r = await fetch(`/api/graphs/${encodeURIComponent(activeGraphId)}`);
      if (r.ok) {
        currentGraph = await r.json();
        applySettings();
        renderSidebar();
      }
    } catch {}
    applyReadOnlyState();
    await fetchGraph();
    return;
  }
  // Two scenarios are unsafe for a full fetchGraph (which wipes & rebuilds):
  //   - The creation ghost is on the canvas — its row doesn't exist in the DB
  //     yet, so a refresh would wipe it.
  //   - An inline title overlay is bound to a cy node — wiping that node leaves
  //     the overlay anchored to a removed reference.
  // In both cases we still want the canvas data for OTHER nodes/edges to stay
  // in sync with concurrent edits. Fall back to a surgical update for the
  // single affected element instead of a full refresh.
  const ghostActive = pendingNode && !pendingNode.removed() && pendingNode.id() === '__pending__';
  const titleOverlayActive = cy.$('.inline-title-edit').length > 0;
  if (ghostActive || titleOverlayActive) {
    if (payload && payload.id != null) {
      if (payload.kind === 'tasks' && payload.op === 'UPDATE') {
        try {
          const r = await fetch(`${apiBase()}/tasks/${payload.id}`);
          if (r.ok) updateGraphNode(await r.json());
        } catch {}
      } else if (payload.kind === 'edges' && payload.op === 'UPDATE') {
        try {
          const r = await fetch(`${apiBase()}/edges`);
          if (r.ok) {
            const edges = await r.json();
            const fresh = edges.find((e) => e.id === payload.id);
            const cyEdge = cy.getElementById(`e${payload.id}`);
            if (fresh && cyEdge && !cyEdge.empty()) {
              cyEdge.data('edgeType', fresh.type);
              cyEdge.data('meta', fresh.meta || {});
              cyEdge.data('color', (fresh.meta && fresh.meta.color) || DEFAULT_EDGE_COLOR);
              if (typeof fresh.version === 'number') cyEdge.data('version', fresh.version);
            }
          }
        } catch {}
      }
    }
    return;
  }

  // Capture pre-refresh status so we can tell whether this UPDATE was a
  // status change (flash with status color) vs body-only edit (purple).
  let preStatus = null;
  if (
    payload &&
    payload.kind === 'tasks' &&
    payload.id != null &&
    payload.op !== 'INSERT'
  ) {
    const preNode = cy.getElementById(String(payload.id));
    if (preNode && !preNode.empty()) preStatus = preNode.data('status');
  }

  const selectedNodeIds = cy.nodes('.selected').map((n) => n.id());
  const selectedEdgeIds = cy.edges('.selected').map((e) => e.id());
  // pendingNode's cy reference goes stale after fetchGraph wipes elements;
  // remember its id so we can re-bind to the new node below.
  const pendingNodeId =
    pendingNode && !pendingNode.removed() && pendingNode.id() !== '__pending__'
      ? pendingNode.id()
      : null;
  await fetchGraph();
  if (pendingNodeId) {
    const refreshed = cy.getElementById(pendingNodeId);
    if (refreshed && !refreshed.empty()) {
      pendingNode = refreshed;
    } else {
      // The row the panel was editing was deleted elsewhere — close the panel
      // rather than leave the user staring at a dangling form.
      pendingNode = null;
      hidePanel();
      showHint('This task was deleted elsewhere');
    }
  }
  selectedNodeIds.forEach((id) => {
    const n = cy.getElementById(id);
    if (n && !n.empty()) n.addClass('selected');
  });
  selectedEdgeIds.forEach((id) => {
    const e = cy.getElementById(id);
    if (e && !e.empty()) e.addClass('selected');
  });
  // fetchGraph wiped & rebuilt every cy element, which dropped the
  // peer-selected / peer-editing classes set by handleSelectionEvent
  // before this refresh. Re-apply them so peer outlines don't blink off
  // every time an agent edit comes through. The cursor markers (DOM
  // overlay) survived intact since they live outside cy, but their
  // anchor positions need a refresh too.
  if (typeof applyPeerSelectionToCy === 'function') applyPeerSelectionToCy();
  if (typeof updateToolbar === 'function') updateToolbar();

  // Agent-follow: when an external (SSE-delivered) edit lands on a task and
  // the user isn't actively interacting, pan the camera to the affected
  // node and (for UPDATE) open the side panel. The "who is editing this"
  // visual cue now comes from the peer-selected/peer-editing classes in
  // the writer's color when the agent broadcasts its selection — no more
  // legacy purple-flash class layered on top.
  if (
    payload &&
    payload.kind === 'tasks' &&
    payload.id != null &&
    payload.op !== 'DELETE' &&
    !document.hidden &&
    !userInteractedRecently() &&
    shouldFollowAgentEvent(payload)
  ) {
    const node = cy.getElementById(String(payload.id));
    if (node && !node.empty()) {
      followAgentEdit(node, payload.op);
    }
  }
}

// User-controlled toggle for whether the camera should follow agent edits.
// Default true to preserve the historical behavior. Per-graph + per-user
// prefs (T259) update this on graph load and on toggle clicks.
let followToggleEnabled = true;

// ---- Follow-toggle prefs (authed: REST; anon: localStorage) -------------
// Schema:
//   - authed: GET/PUT /api/me/prefs (default), GET/PUT /api/graphs/:gid/prefs/me (per-graph)
//             PUT to per-graph also writes through to the user's default in
//             one server-side tx — see src/routes/graphPrefs.js.
//   - anon:   localStorage 'gt_follow_default' (boolean) and
//             'gt_follow_graph_<gid>' (boolean | absent). Toggling a graph
//             writes BOTH keys; old graphs with their own per-graph value
//             stay as they were.
const PREF_KEY_DEFAULT = 'gt_follow_default';
const PREF_KEY_GRAPH = (gid) => `gt_follow_graph_${gid}`;

function _readAnonPref(key) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return null;
    return v === 'true';
  } catch { return null; }
}
function _writeAnonPref(key, value) {
  try { localStorage.setItem(key, value ? 'true' : 'false'); } catch {}
}

async function loadFollowPref(gid) {
  if (!gid) return true;
  if (window.gtUser?.id) {
    try {
      const [rDef, rPer] = await Promise.all([
        fetch('/api/me/prefs', { credentials: 'include' }),
        fetch(`/api/graphs/${encodeURIComponent(gid)}/prefs/me`, { credentials: 'include' }),
      ]);
      const def = rDef.ok ? (await rDef.json()).agent_follow_default : true;
      const per = rPer.ok ? (await rPer.json()).agent_follow : null;
      return per != null ? per : def;
    } catch { return true; }
  }
  // Anon: localStorage. Per-graph wins over default.
  const per = _readAnonPref(PREF_KEY_GRAPH(gid));
  if (per != null) return per;
  const def = _readAnonPref(PREF_KEY_DEFAULT);
  return def != null ? def : true;
}

async function saveFollowPref(gid, value) {
  if (!gid) return;
  if (window.gtUser?.id) {
    try {
      // Server PUT writes BOTH per-graph + user default in a single tx.
      await fetch(`/api/graphs/${encodeURIComponent(gid)}/prefs/me`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_follow: value }),
      });
    } catch {}
    return;
  }
  // Anon: write per-graph AND default so the next new graph adopts it.
  _writeAnonPref(PREF_KEY_GRAPH(gid), value);
  _writeAnonPref(PREF_KEY_DEFAULT, value);
}

function updateFollowToggleUI() {
  const btn = document.getElementById('btn-follow-toggle');
  if (!btn) return;
  // Show iff at least one agent is in presenceState. Stop hook (.claude
  // graphtask SKILL.md) DELETEs presence at end of turn, so membership
  // alone is the "agent is here and working" signal — no 60s window.
  const hasAgent = Array.from(presenceState.values()).some((w) => w.type === 'agent');
  const wasHidden = btn.classList.contains('hidden');
  if (!hasAgent) {
    btn.classList.add('hidden');
    // Visibility changed → re-evaluate the panel cap, since the button now
    // doesn't push the presence bar's allowable left edge anymore.
    if (!wasHidden && typeof adjustPresenceBarOffset === 'function') {
      adjustPresenceBarOffset();
    }
    return;
  }
  btn.classList.remove('hidden');
  // Button appeared → its bumper now reserves space; clamp the panel if it
  // was sized wider than the new cap allows.
  if (wasHidden && typeof adjustPresenceBarOffset === 'function') {
    adjustPresenceBarOffset();
  }
  // Push-button: .is-tracking means camera follow is active (cap
  // pressed in + orange pulse halo runs). Absence means follow is
  // paused. CSS drives the press animation and halo play-state.
  const status = btn.querySelector('.push-button-status');
  if (followToggleEnabled) {
    btn.classList.add('is-tracking');
    // Custom CSS tooltip on hover (via [data-tooltip] + ::after). The
    // native `title` attribute also fires a system tooltip but with a
    // browser-controlled ~750ms delay, so we use data-tooltip instead
    // to match the avatar bar's instant tooltip behavior.
    btn.dataset.tooltip = 'Stop tracking';
    btn.setAttribute('aria-pressed', 'true');
    if (status) status.textContent = 'Live';
  } else {
    btn.classList.remove('is-tracking');
    btn.dataset.tooltip = 'Track agent';
    btn.setAttribute('aria-pressed', 'false');
    if (status) status.textContent = 'Quiet';
  }
}

function wireFollowToggleButton() {
  const btn = document.getElementById('btn-follow-toggle');
  if (!btn || btn._gtWired) return;
  btn._gtWired = true;
  btn.addEventListener('click', async () => {
    followToggleEnabled = !followToggleEnabled;
    updateFollowToggleUI();
    if (activeGraphId) await saveFollowPref(activeGraphId, followToggleEnabled);
  });
}
// ---- end follow-toggle prefs --------------------------------------------

// Multi-agent follow rules:
//   0 active agents → never follow (toggle button is also hidden by T259).
//   1 active agent  → follow it (any owner) — single-agent sessions Just Work.
//   2+ active agents → follow ONLY events written by the agent owned by me
//                      (so I track *my* agent's path; peers' agents still
//                      render colored highlights, but my screen doesn't pan
//                      around to follow their work).
//   Anon viewer + 2+ agents → no follow target; rely on highlights only.
function shouldFollowAgentEvent(payload) {
  if (!followToggleEnabled) return false;
  // Stop hook (.claude SKILL.md) DELETEs presence at end of turn, so
  // membership in presenceState IS the active signal. Don't filter on the
  // 60s `active` flag — an agent pondering for >60s without writing is
  // still mid-turn and should still steer camera follow.
  const activeAgents = Array.from(presenceState.values())
    .filter((w) => w.type === 'agent');
  if (activeAgents.length === 0) return false;
  if (activeAgents.length === 1) return true;
  const me = window.gtUser?.id ?? null;
  if (me == null) return false;
  // T255 made tasks/edges rows carry last_modified_by_user; refreshFromEvent
  // refetches the row before this point, and updateGraphNode/addGraphNode
  // stash it on the cy node as `lastModifiedByUser`. Read it from the node
  // — the SSE pg_notify payload itself only has {graph_id, kind, op, id}.
  if (cy) {
    const node = cy.getElementById(String(payload.id));
    if (node && !node.empty()) {
      const eventOwner = node.data('lastModifiedByUser');
      return eventOwner != null && eventOwner === me;
    }
  }
  return false;
}

function followAgentEdit(node, op) {
  // UPDATE → open the side panel showing the new content.
  // INSERT → just pan; don't force the panel open every time a new node lands.
  if (op === 'UPDATE') {
    // programmatic: true so postLocalSelection doesn't broadcast THIS user
    // as the editor — they're passively viewing what the agent changed,
    // not actively editing it themselves. Without this, every viewer who
    // had agent-follow enabled would be tagged as a co-editor on every
    // node the agent touched.
    showPanel(node, { programmatic: true });
  } else {
    centerNodeInVisibleArea(node);
  }
}

function parseGraphIdFromPath() {
  const m = location.pathname.match(/^\/g\/([a-z0-9]+)\/?$/);
  return m ? m[1] : null;
}

async function bootSidebar() {
  await fetchGraphsList();
  // Resolve which graph to open: URL → localStorage → first public → none.
  // The URL-supplied id is bearer-token equivalent and must be honored even
  // if the graph is private (and therefore not in sidebar.graphs). Same for
  // the stored last-active id — if it's been deleted, switchActiveGraph
  // will surface that, and recentsRefresh will eventually drop it.
  let target = parseGraphIdFromPath();
  if (target == null) {
    try { target = localStorage.getItem(ACTIVE_GRAPH_STORAGE_KEY) || null; } catch {}
  }
  if (target == null && sidebar.graphs.length > 0) target = sidebar.graphs[0].id;

  if (target == null) {
    activeGraphId = null;
    updateEmptyStates();
  } else {
    await switchActiveGraph(target, { pushState: parseGraphIdFromPath() !== target });
  }
}

window.addEventListener('popstate', () => {
  const id = parseGraphIdFromPath();
  if (id != null) {
    if (id !== activeGraphId) switchActiveGraph(id, { pushState: false });
  } else if (id == null && activeGraphId != null) {
    // Falling back to /: clear per-graph appearance overrides.
    currentGraph = null;
    applySettings();
    applyReadOnlyState();
    activeGraphId = null;
    if (cy) cy.elements().remove();
    renderSidebar();
    updateEmptyStates();
  }
});

// --- Cytoscape style arrays — one per theme.
// We deliberately keep both arrays in full (including the rules that don't
// differ between themes) so the toggle is byte-for-byte exact and easy to
// audit. The dark array is the cron-reference design; the light array is
// the prior mymind-reference design.
function cytoscapeStyleDark() {
  return [
    {
      selector: 'node',
      style: {
        'shape': 'round-rectangle',
        'background-color': 'data(color)',
        'border-color': '#cccccc',
        'border-width': 1,
        'label': 'data(title)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '13px',
        'font-family': getFontStack(appSettings.font),
        'color': appSettings.fontColor,
        'text-wrap': 'wrap',
        'text-max-width': '140px',
        'width': 'label',
        'height': 'label',
        'padding': '16px',
        'text-overflow-wrap': 'whitespace',
      },
    },
    { selector: 'node[status = "in_progress"]', style: { 'border-color': '#ffffff', 'border-width': 2 } },
    { selector: 'node[status = "review"]', style: { 'border-color': '#ff4700', 'border-width': 2, 'border-style': 'dashed', 'border-dash-pattern': [6, 4] } },
    { selector: 'node[status = "done"]', style: { 'border-color': '#cccccc', 'border-opacity': 0.35, 'opacity': 0.55 } },
    { selector: 'node[color]', style: { 'background-color': 'data(color)' } },
    // Image-bearing nodes: TWO REGIONS. The top region is a normal label-
    // sized text area with 16px padding on all four sides. The bottom region
    // is the image, anchored to the node's bottom edge, sized to the image's
    // actual aspect ratio at width 220. They do not overlap.
    //
    // Layout from top to bottom of the node:
    //
    //   16px        — top padding
    //   label       — title text (auto-grows with line count)
    //   16px        — bottom-of-text padding (matches top)
    //   bgImageH    — image area (the image's natural height at width 220)
    //
    // bgImageH lives on node.data, written by loadBgImageDimensions() once
    // the image's natural dimensions are known. The three style functions
    // below read it back and feed the layout — cytoscape re-evaluates these
    // automatically when ele.data() changes.
    //
    // background-fit MUST be 'contain' (not 'cover') so background-height
    // is honored as the image-area size; 'cover' stretches the image across
    // the whole node and the title ends up rendered on top of it.
    // Image-bearing nodes: TWO REGIONS. Top region holds the title, bottom
    // region is the image flush against the bottom edge. No overlap.
    //
    // Cytoscape gotchas this layout has to dodge (verified in-browser):
    //   - `padding-bottom` as a function or per-element override CANNOT be
    //     asymmetric from `padding-top` — both sides snap to the same value.
    //     So we keep the symmetric `padding: 16px` shorthand and don't try
    //     to stretch the node via padding-bottom.
    //   - `height: 'label'` auto-sizes only to the label; it can't include
    //     the image area. So we drop label-auto-sizing for image nodes and
    //     set `height` directly per-node from applyBgDimensions(): height =
    //     50 (text strip) + bgImageH (image strip).
    //   - `text-margin-y` is unitless and DOES accept per-node overrides.
    //   - `background-height` accepts per-node overrides with `'<n>px'`
    //     suffix.
    //
    // The static defaults below (assuming a 16:9 ≈ 124px-tall image) cover
    // the brief window between adding the node and the image's onload.
    { selector: 'node[backgroundImage]', style: {
        'text-valign': 'center',
        'text-margin-y': -62,
        'text-max-width': '188px',
        'width': '220px',
        'height': '137px',
        'padding': '16px',
        'background-image': 'data(backgroundImage)',
        'background-fit': 'contain',
        'background-width': '100%',
        'background-height': '124px',
        'background-position-x': '50%',
        'background-position-y': '100%',
        'background-image-containment': 'inside',
        'background-clip': 'node',
    } },
    { selector: 'node.selected', style: { 'underlay-color': '#ff4700', 'underlay-opacity': 0.22, 'underlay-padding': 6 } },
    // Peer-selection visuals: a soft colored halo + dashed border when a
    // peer has the side panel open. Color comes from data(peerColor) which
    // the renderer sets to colorForId(writer_id) — same hue as that
    // writer's avatar in the presence bar.
    { selector: 'node.peer-selected', style: { 'underlay-color': 'data(peerColor)', 'underlay-opacity': 0.30, 'underlay-padding': 8 } },
    { selector: 'node.peer-editing', style: { 'border-color': 'data(peerColor)', 'border-style': 'dashed', 'border-width': 3, 'border-dash-pattern': [6, 4] } },
    { selector: 'node.selected.status-editing-todo, node.selected.status-editing-in_progress, node.selected.status-editing-done', style: { 'border-color': '#ff4700', 'border-width': 2.5 } },
    { selector: 'node.editing', style: { 'border-color': '#ff4700', 'border-style': 'dashed', 'border-width': 3, 'border-dash-pattern': [6, 4] } },
    { selector: 'node.inline-title-edit', style: { 'text-opacity': 0 } },
    // Edge visuals: thinner lines + `vee` arrowheads (narrow V) for a sleeker
    // look than the previous triangle. arrow-scale=1.2 makes the vee read at
    // the same visual mass as the old triangle without the chunky base.
    { selector: 'edge', style: { 'width': 1, 'line-color': 'data(color)', 'curve-style': 'unbundled-bezier', 'control-point-distances': 'data(curveDistance)', 'control-point-weights': 'data(curveWeight)' } },
    { selector: 'edge[edgeType = "dependency"]', style: { 'target-arrow-shape': 'vee', 'target-arrow-color': 'data(color)', 'arrow-scale': 1.2, 'line-color': 'data(color)', 'width': 1.25 } },
    { selector: 'edge[edgeType = "related"]', style: { 'target-arrow-shape': 'vee', 'target-arrow-color': 'data(color)', 'source-arrow-shape': 'vee', 'source-arrow-color': 'data(color)', 'arrow-scale': 1.2, 'line-color': 'data(color)', 'width': 1.25 } },
    { selector: 'edge.selected', style: { 'underlay-color': '#ff4700', 'underlay-opacity': 0.22, 'underlay-padding': 5, 'z-index': 9 } },
    { selector: 'edge.peer-selected', style: { 'underlay-color': 'data(peerColor)', 'underlay-opacity': 0.35, 'underlay-padding': 5, 'z-index': 9 } },
    { selector: 'edge.peer-editing', style: { 'line-color': 'data(peerColor)', 'target-arrow-color': 'data(peerColor)', 'source-arrow-color': 'data(peerColor)', 'width': 2, 'z-index': 9 } },
    { selector: 'edge.edge-type-editing', style: { 'line-style': 'dashed', 'line-dash-pattern': [8, 6] } },
    { selector: 'edge.highlighted', style: { 'line-color': '#ff4700', 'target-arrow-color': '#ff4700', 'width': 2.25, 'z-index': 10 } },
    { selector: 'edge.dir-backward', style: { 'target-arrow-shape': 'none', 'source-arrow-shape': 'vee', 'source-arrow-color': 'data(color)' } },
    { selector: 'node.edge-hover-target', style: { 'border-color': '#ff4700', 'border-width': 2 } },
    { selector: 'node.phantom', style: { 'width': 1, 'height': 1, 'background-opacity': 0, 'border-width': 0, 'label': '', 'events': 'no' } },
    { selector: 'edge.preview', style: { 'opacity': 0.6, 'events': 'no', 'z-index': 8 } },
    { selector: 'node:active, edge:active, core:active', style: { 'overlay-opacity': 0 } },
    // Suppress the default ~25px translucent gray circle Cytoscape paints
    // at the pointer during a background press/drag. The pointer already
    // tells the user where they are; the indicator adds nothing.
    { selector: 'core', style: { 'active-bg-opacity': 0, 'active-bg-size': 0 } },
  ];
}
// Resolve the --status-* CSS tokens at call time. Returns { in_progress,
// review, done } each with { fill, stroke } hex values. Reading the cascade
// makes style.css the single source of truth — touching a token there
// updates both the kanban view (via CSS) and the graph view (via this
// function feeding cytoscapeStyleLight).
function statusPalette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    in_progress: { fill: v('--status-in-progress-fill'), stroke: v('--status-in-progress-stroke') },
    review:      { fill: v('--status-review-fill'),      stroke: v('--status-review-stroke') },
    done:        { fill: v('--status-done-fill'),        stroke: v('--status-done-stroke') },
  };
}
function cytoscapeStyleLight() {
  const _statusPalette = statusPalette();
  // Palette mapping (May 2026):
  //   Tier rule: light → fill, strong → border + text.
  //   in_progress         → bg amber-light #ffe7c5, border/text amber-strong #e88a1b
  //                         (warm amber-orange — "actively working")
  //   review              → bg green-light #deffe3, border/text green-strong #49ca80
  //                         (calm green — "ready for sign-off")
  //   done                → bg indigo-light #e0e7ff, border/text indigo-strong #4f46e5
  //                         (settled indigo — "complete, archived")
  //   selection / main    → main-orange #fb5305 (selection underlay, edge.selected, status-editing-todo)
  //   agent-edit / hover  → purple-strong #a45fff (.editing, edge-hover-target)
  //   warning             → red-strong #ef3230 (edge.highlighted)
  //   default todo border → neutral-grey #e5e5e5 (todo has no status hue)
  return [
    {
      selector: 'node',
      style: {
        'shape': 'round-rectangle',
        'background-color': 'data(color)',
        'border-color': '#e5e5e5',
        'border-width': 3,
        'label': 'data(title)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '13px',
        'font-family': getFontStack(appSettings.font),
        'color': appSettings.fontColor,
        'text-wrap': 'wrap',
        'text-max-width': '140px',
        'width': 'label',
        'height': 'label',
        'padding': '16px',
        'text-overflow-wrap': 'whitespace',
      },
    },
    // Per-status palette. Hex values pulled from --status-* CSS tokens
    // at boot (see statusPalette() below) so the kanban + graph views
    // stay in lockstep — change `--status-review-stroke` in style.css and
    // both views update with no JS edit. (todo has no status hue and
    // falls through to the default body text color.)
    { selector: 'node[status = "in_progress"]', style: { 'background-color': _statusPalette.in_progress.fill, 'border-color': _statusPalette.in_progress.stroke, 'color': _statusPalette.in_progress.stroke } },
    { selector: 'node[status = "review"]',      style: { 'background-color': _statusPalette.review.fill,      'border-color': _statusPalette.review.stroke,      'color': _statusPalette.review.stroke } },
    { selector: 'node[status = "done"]',        style: { 'background-color': _statusPalette.done.fill,        'border-color': _statusPalette.done.stroke,        'color': _statusPalette.done.stroke } },
    { selector: 'node[color]', style: { 'background-color': 'data(color)' } },
    // Image-bearing nodes: TWO REGIONS. The top region is a normal label-
    // sized text area with 16px padding on all four sides. The bottom region
    // is the image, anchored to the node's bottom edge, sized to the image's
    // actual aspect ratio at width 220. They do not overlap.
    //
    // Layout from top to bottom of the node:
    //
    //   16px        — top padding
    //   label       — title text (auto-grows with line count)
    //   16px        — bottom-of-text padding (matches top)
    //   bgImageH    — image area (the image's natural height at width 220)
    //
    // bgImageH lives on node.data, written by loadBgImageDimensions() once
    // the image's natural dimensions are known. The three style functions
    // below read it back and feed the layout — cytoscape re-evaluates these
    // automatically when ele.data() changes.
    //
    // background-fit MUST be 'contain' (not 'cover') so background-height
    // is honored as the image-area size; 'cover' stretches the image across
    // the whole node and the title ends up rendered on top of it.
    // Image-bearing nodes: TWO REGIONS. Top region holds the title, bottom
    // region is the image flush against the bottom edge. No overlap.
    //
    // Cytoscape gotchas this layout has to dodge (verified in-browser):
    //   - `padding-bottom` as a function or per-element override CANNOT be
    //     asymmetric from `padding-top` — both sides snap to the same value.
    //     So we keep the symmetric `padding: 16px` shorthand and don't try
    //     to stretch the node via padding-bottom.
    //   - `height: 'label'` auto-sizes only to the label; it can't include
    //     the image area. So we drop label-auto-sizing for image nodes and
    //     set `height` directly per-node from applyBgDimensions(): height =
    //     50 (text strip) + bgImageH (image strip).
    //   - `text-margin-y` is unitless and DOES accept per-node overrides.
    //   - `background-height` accepts per-node overrides with `'<n>px'`
    //     suffix.
    //
    // The static defaults below (assuming a 16:9 ≈ 124px-tall image) cover
    // the brief window between adding the node and the image's onload.
    { selector: 'node[backgroundImage]', style: {
        'text-valign': 'center',
        'text-margin-y': -62,
        'text-max-width': '188px',
        'width': '220px',
        'height': '137px',
        'padding': '16px',
        'background-image': 'data(backgroundImage)',
        'background-fit': 'contain',
        'background-width': '100%',
        'background-height': '124px',
        'background-position-x': '50%',
        'background-position-y': '100%',
        'background-image-containment': 'inside',
        'background-clip': 'node',
    } },
    { selector: 'node.selected', style: { 'underlay-color': '#fb5305', 'underlay-opacity': 0.35, 'underlay-padding': 6 } },
    // Peer-selection visuals: a soft colored halo + dashed border when a
    // peer has the side panel open. Color comes from data(peerColor) which
    // the renderer sets to colorForId(writer_id) — same hue as that
    // writer's avatar in the presence bar.
    { selector: 'node.peer-selected', style: { 'underlay-color': 'data(peerColor)', 'underlay-opacity': 0.35, 'underlay-padding': 8 } },
    { selector: 'node.peer-editing', style: { 'border-color': 'data(peerColor)', 'border-style': 'dashed', 'border-width': 3, 'border-dash-pattern': [6, 4] } },
    { selector: 'node.selected.status-editing-todo',        style: { 'border-color': '#fb5305', 'border-width': 1.5 } },
    { selector: 'node.selected.status-editing-in_progress', style: { 'border-color': _statusPalette.in_progress.stroke, 'border-width': 2.5 } },
    { selector: 'node.selected.status-editing-review',      style: { 'border-color': _statusPalette.review.stroke,      'border-width': 2.5 } },
    { selector: 'node.selected.status-editing-done',        style: { 'border-color': _statusPalette.done.stroke,        'border-width': 2.5 } },
    { selector: 'node.editing', style: { 'border-color': '#a45fff', 'border-style': 'dashed', 'border-width': 3.5, 'border-dash-pattern': [6, 4] } },
    { selector: 'node.inline-title-edit', style: { 'text-opacity': 0 } },
    // Edge visuals: thinner lines + `vee` arrowheads (narrow V) for a sleeker
    // look than the previous triangle. arrow-scale=1.2 makes the vee read at
    // the same visual mass as the old triangle without the chunky base.
    { selector: 'edge', style: { 'width': 1, 'line-color': 'data(color)', 'curve-style': 'unbundled-bezier', 'control-point-distances': 'data(curveDistance)', 'control-point-weights': 'data(curveWeight)' } },
    { selector: 'edge[edgeType = "dependency"]', style: { 'target-arrow-shape': 'vee', 'target-arrow-color': 'data(color)', 'arrow-scale': 1.2, 'line-color': 'data(color)', 'width': 1.25 } },
    { selector: 'edge[edgeType = "related"]', style: { 'target-arrow-shape': 'vee', 'target-arrow-color': 'data(color)', 'source-arrow-shape': 'vee', 'source-arrow-color': 'data(color)', 'arrow-scale': 1.2, 'line-color': 'data(color)', 'width': 1.25 } },
    { selector: 'edge.selected', style: { 'underlay-color': '#fb5305', 'underlay-opacity': 0.35, 'underlay-padding': 5, 'z-index': 9 } },
    { selector: 'edge.peer-selected', style: { 'underlay-color': 'data(peerColor)', 'underlay-opacity': 0.40, 'underlay-padding': 5, 'z-index': 9 } },
    { selector: 'edge.peer-editing', style: { 'line-color': 'data(peerColor)', 'target-arrow-color': 'data(peerColor)', 'source-arrow-color': 'data(peerColor)', 'width': 2, 'z-index': 9 } },
    { selector: 'edge.edge-type-editing', style: { 'line-style': 'dashed', 'line-dash-pattern': [8, 6] } },
    { selector: 'edge.highlighted', style: { 'line-color': '#ef3230', 'target-arrow-color': '#ef3230', 'width': 2.25, 'z-index': 10 } },
    { selector: 'edge.dir-backward', style: { 'target-arrow-shape': 'none', 'source-arrow-shape': 'vee', 'source-arrow-color': 'data(color)' } },
    { selector: 'node.edge-hover-target', style: { 'border-color': '#a45fff', 'border-width': 2 } },
    { selector: 'node.phantom', style: { 'width': 1, 'height': 1, 'background-opacity': 0, 'border-width': 0, 'label': '', 'events': 'no' } },
    { selector: 'edge.preview', style: { 'opacity': 0.6, 'events': 'no', 'z-index': 8 } },
    { selector: 'node:active, edge:active, core:active', style: { 'overlay-opacity': 0 } },
    // Suppress the default ~25px translucent gray circle Cytoscape paints
    // at the pointer during a background press/drag. The pointer already
    // tells the user where they are; the indicator adds nothing.
    { selector: 'core', style: { 'active-bg-opacity': 0, 'active-bg-size': 0 } },
  ];
}
function cytoscapeStyle(theme) {
  return theme === 'light' ? cytoscapeStyleLight() : cytoscapeStyleDark();
}

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
  // Fire-and-forget: auth chrome lights up when Clerk finishes loading.
  // The sidebar list + cytoscape boot proceed in parallel so a slow Clerk
  // CDN doesn't gate the rest of the UI. The cookie carries auth state
  // server-side, so /api/graphs returns the right slice from the first call.
  bootAuth();
  loadSettings();
  startPanelClassObserver();
  wireFollowToggleButton();
  cy = cytoscape({
    container: document.getElementById('cy'),
    style: cytoscapeStyle(appSettings.theme),
    layout: { name: 'preset' },
    wheelSensitivity: 0.3,
    boxSelectionEnabled: false,
    selectionType: 'additive',
    minZoom: 0.2,
    maxZoom: 1.5,
  });
  // Own-selection color is the local user's avatar color, not the historical
  // orange — applied once after cy init and again on every full re-style.
  if (typeof applyOwnSelectionColor === 'function') applyOwnSelectionColor();

  // --- Node interactions ---
  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    if (node.id() === '__pending__' || node.id() === '__edge_target__') return;

    if (edgeCreation) {
      commitEdgeCreation(node);
      return;
    }
    if (edgeTypeEditing) cancelEdgeTypeEdit();
    if (statusEditing && statusEditing.nodeId !== node.id()) cancelStatusEdit();

    if (isCmd(evt.originalEvent)) {
      node.toggleClass('selected');
      if (statusEditing && cy.nodes('.selected').length !== 1) {
        cancelStatusEdit();
      }
    } else {
      cy.nodes().not(node).removeClass('selected');
      cy.edges().removeClass('selected');
      node.addClass('selected');
      hideCurveHandle();
      cancelPendingNode();
      showPanel(node);
    }
    updateToolbar();
  });

  // Edge tap → select / cmd-toggle
  cy.on('tap', 'edge', (evt) => {
    const edge = evt.target;
    if (edge.id().startsWith('__')) return; // ignore preview edge
    if (edgeTypeEditing && edgeTypeEditing.edgeId !== edge.id()) cancelEdgeTypeEdit();
    if (statusEditing) cancelStatusEdit();
    if (isCmd(evt.originalEvent)) {
      edge.toggleClass('selected');
      if (edge.hasClass('selected')) showCurveHandle(edge);
    } else {
      cy.nodes().removeClass('selected');
      cy.edges().not(edge).removeClass('selected');
      edge.addClass('selected');
      cancelPendingNode();
      if (isPanelOpen()) hidePanel();
      showCurveHandle(edge);
    }
    updateToolbar();
  });
  cy.on('mouseover', 'edge', (evt) => {
    const edge = evt.target;
    if (edge.id().startsWith('__')) return;
    showCurveHandle(edge);
  });
  cy.on('mouseout', 'edge', (evt) => {
    const edge = evt.target;
    if (edge.id().startsWith('__')) return;
    scheduleCurveHandleHide(edge);
  });

  // Right-click to delete (still works on a node)
  cy.on('cxttap', 'node', async (evt) => {
    const node = evt.target;
    if (node.id() === '__pending__') return;
    const ok = await showConfirm({
      title: 'Delete task?',
      body: `"${node.data('title')}" — this can't be undone.`,
      okText: 'Delete',
      danger: true,
    });
    if (ok) {
      await deleteTask(node.data('taskId'));
      clearSelection();
      await fetchGraph();
    }
  });

  // Click background — empty space click creates a node; otherwise clears selection
  cy.on('tap', (evt) => {
    if (evt.target !== cy) return;
    if (accessDenied) return;
    if (isCmd(evt.originalEvent)) return; // cmd+click on bg is reserved for box-select start

    if (edgeCreation) {
      if (isReadOnly()) return;
      createPendingNodeFromEdgeCreation(evt.position);
      return;
    }

    const anySelected = cy.nodes('.selected').length > 0 || cy.edges('.selected').length > 0;
    if (anySelected) {
      clearSelection();
      if (isPanelOpen()) hidePanel();
      return;
    }
    if (pendingNode) {
      cancelPendingNode();
      return;
    }
    if (isReadOnly()) return;
    createNodeAt(evt.position);
  });

  // Double-click handlers: cmd selects all-of-type; plain dbl-click enters inline edit
  cy.on('dbltap', 'node', (evt) => {
    const node = evt.target;
    if (node.id() === '__pending__') return;
    if (isCmd(evt.originalEvent)) {
      cy.edges().removeClass('selected');
      cy.nodes().addClass('selected');
      updateToolbar();
      return;
    }
    startEditingNode(node);
  });
  cy.on('dbltap', 'edge', (evt) => {
    if (!isCmd(evt.originalEvent)) return;
    cy.nodes().removeClass('selected');
    cy.edges().addClass('selected');
    updateToolbar();
  });

  // After a node is dropped, push it out of any overlap with neighbors.
  cy.on('dragfree', 'node', (evt) => {
    const node = evt.target;
    if (node.id() === '__edge_target__') return;
    resolveNodeOverlap(node);
    const pos = node.position();
    const x = roundPosition(pos.x);
    const y = roundPosition(pos.y);
    if (node.id() === '__pending__') {
      pendingPosition = { x, y };
      panelLoadedMeta = { ...panelLoadedMeta, x, y };
      return;
    }
    persistNodePosition(node);
  });

  // While in edge creation, hovering a candidate target node previews the
  // connection by giving it the same blue ring as a selected node.
  cy.on('mouseover', 'node', (evt) => {
    if (!edgeCreation) return;
    const node = evt.target;
    if (node.id() === '__pending__' || node.id() === '__edge_target__') return;
    const sources = edgeCreation.sources || [edgeCreation.source].filter(Boolean);
    if (sources.some((source) => source.id() === node.id())) return;
    node.addClass('edge-hover-target');
  });
  cy.on('mouseout', 'node', (evt) => {
    evt.target.removeClass('edge-hover-target');
  });

  // --- Cmd+drag box select ---
  // Disable cytoscape's panning whenever cmd/ctrl is held so a drag on the
  // background becomes our rubber-band selection instead of a pan.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && cy) cy.userPanningEnabled(false);
  });
  window.addEventListener('keyup', (e) => {
    if (!e.metaKey && !e.ctrlKey && cy) cy.userPanningEnabled(true);
  });
  window.addEventListener('blur', () => { if (cy) cy.userPanningEnabled(true); });

  let cmdBoxState = null;

  function showCmdBox(p1, p2) {
    const box = document.getElementById('cmd-box');
    const rect = document.getElementById('cy').getBoundingClientRect();
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);
    box.style.left = (rect.left + x) + 'px';
    box.style.top = (rect.top + y) + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    box.classList.remove('hidden');
  }

  function hideCmdBox() {
    document.getElementById('cmd-box').classList.add('hidden');
  }

  cy.on('tapstart', (evt) => {
    if (evt.target !== cy) return;
    if (!isCmd(evt.originalEvent)) return;
    cmdBoxState = {
      startWorld: { x: evt.position.x, y: evt.position.y },
      startRendered: { x: evt.renderedPosition.x, y: evt.renderedPosition.y },
      additive: evt.originalEvent.shiftKey,
    };
    showCmdBox(cmdBoxState.startRendered, cmdBoxState.startRendered);
  });

  cy.on('tapdrag', (evt) => {
    if (!cmdBoxState) return;
    showCmdBox(cmdBoxState.startRendered, evt.renderedPosition);
  });

  cy.on('tapend', (evt) => {
    if (!cmdBoxState) return;
    const startW = cmdBoxState.startWorld;
    const endW = evt.position;
    const additive = cmdBoxState.additive;
    hideCmdBox();
    cmdBoxState = null;

    // Ignore zero-area drags (essentially a cmd+click on empty space)
    if (Math.abs(endW.x - startW.x) < 2 && Math.abs(endW.y - startW.y) < 2) return;

    const x1 = Math.min(startW.x, endW.x);
    const y1 = Math.min(startW.y, endW.y);
    const x2 = Math.max(startW.x, endW.x);
    const y2 = Math.max(startW.y, endW.y);

    if (!additive) {
      cy.nodes().removeClass('selected');
      cy.edges().removeClass('selected');
    }

    cy.nodes().forEach((n) => {
      if (n.id() === '__pending__') return;
      const bb = n.boundingBox();
      if (bb.x2 >= x1 && bb.x1 <= x2 && bb.y2 >= y1 && bb.y1 <= y2) {
        n.addClass('selected');
      }
    });
    cy.edges().forEach((edge) => {
      const m = edge.midpoint();
      if (m && m.x >= x1 && m.x <= x2 && m.y >= y1 && m.y <= y2) {
        edge.addClass('selected');
      }
    });

    updateToolbar();
  });

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    const inField =
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'TEXTAREA' ||
      e.target.tagName === 'SELECT' ||
      e.target.isContentEditable;
    // Cmd+K opens *graph* settings (the graph edit modal) when there's an
    // active graph. App-level Defaults live behind the gear icon. Cmd+K is
    // a no-op on the empty home page.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openGraphSettings();
      return;
    }
    if (handleSettingsKey(e)) return;
    if (handleColorPaletteKey(e)) return;
    // Esc always works (closes overlay/panel/clears selection/cancels edge)
    if (e.key === 'Escape') {
      if (edgeCreation) {
        cancelEdgeCreation();
        e.preventDefault();
        return;
      }
      if (edgeTypeEditing) {
        cancelEdgeTypeEdit();
        e.preventDefault();
        return;
      }
      if (statusEditing) {
        cancelStatusEdit();
        e.preventDefault();
        return;
      }
      if (!document.getElementById('node-title-overlay').classList.contains('hidden')) {
        // Overlay's own keydown handles Esc; allow it to propagate
        return;
      }
      if (isPanelOpen()) {
        hidePanel();
        // Kanban: close panel AND clear selection in one Esc press.
        // hidePanel no longer auto-clears (mid-flight hides would wipe
        // multi-select), so do it here explicitly.
        if (currentView === 'kanban') {
          document.querySelectorAll('.kb-card.selected').forEach((c) => c.classList.remove('selected'));
          if (cy) cy.elements('.selected').removeClass('selected');
          updateKanbanToolbar();
        }
        e.preventDefault();
      } else {
        clearSelection();
        if (currentView === 'kanban') {
          document.querySelectorAll('.kb-card.selected').forEach((c) => c.classList.remove('selected'));
          updateKanbanToolbar();
        }
      }
      return;
    }
    // Cmd/Ctrl+Enter commits a new-node create from anywhere — including the
    // body editor where plain Enter inserts a newline.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (!editingTaskId && pendingNode) {
        e.preventDefault();
        window.__commitNewNode();
        return;
      }
    }
    if (inField) return;
    // Kanban-specific hotkeys handle G (new task in selected card's column,
    // fallback todo) and S (cycle status of selected card). Other keys fall
    // through to no-op in kanban — cytoscape concepts (T/F/E/B) don't apply.
    if (currentView === 'kanban') {
      switch (e.key) {
        case 'g': case 'G': {
          const selected = document.querySelector('.kb-card.selected');
          const col = selected && selected.closest('.kb-column');
          createKanbanTask((col && col.dataset.status) || 'todo');
          break;
        }
        case 's': case 'S': {
          const selected = document.querySelector('.kb-card.selected');
          if (!selected) break;
          const col = selected.closest('.kb-column');
          const curStatus = col && col.dataset.status;
          if (!curStatus) break;
          const idx = KANBAN_STATUSES.indexOf(curStatus);
          const next = KANBAN_STATUSES[(idx + 1) % KANBAN_STATUSES.length];
          const taskId = Number(selected.dataset.taskId);
          if (Number.isFinite(taskId)) moveKanbanCardToStatus(taskId, next);
          break;
        }
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          deleteSelectedKanbanCards();
          break;
      }
      return;
    }

    switch (e.key) {
      case 'f':
      case 'F':
        cy.fit(undefined, 50);
        showHint('Zoom to fit');
        break;
      case 't':
      case 'T':
        tidyAndFit();
        break;
      case 'g':
      case 'G':
        createNodeAtCenter();
        break;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        if (moveSelection(e.key)) e.preventDefault();
        break;
      case 'e':
      case 'E':
        // E means: cycle direction in an in-progress edge, OR cycle the type
        // of a selected existing edge, OR start edge creation from a selected
        // node — depending on current state.
        if (edgeCreation) {
          cycleEdgeCreationDirection();
        } else if (cy.edges('.selected').filter((x) => !x.id().startsWith('__')).length === 1) {
          cycleSelectedEdgeType();
        } else {
          startEdgeCreation();
        }
        break;
      case 's':
      case 'S':
        cycleSelectedNodeStatus();
        break;
      case 'b':
      case 'B':
        if (!e.metaKey && !e.ctrlKey && !e.altKey && openColorPalette()) e.preventDefault();
        break;
      case 'c':
      case 'C':
        // Edge-context color shortcut. C opens the color palette only when
        // an edge is selected — nodes still use B (above). Surfaced on the
        // tb-edge toolbar as the canonical edge-color hotkey.
        if (!e.metaKey && !e.ctrlKey && !e.altKey
            && cy.edges('.selected').filter((x) => !x.id().startsWith('__')).length >= 1
            && openColorPalette()) {
          e.preventDefault();
        }
        break;
      case 'd':
      case 'D':
        // Edge-context direction shortcut. D cycles the selected edge's
        // direction (forward → related → backward). E still works as the
        // legacy shortcut + the node-context "start edge creation" key.
        if (!e.metaKey && !e.ctrlKey && !e.altKey
            && cy.edges('.selected').filter((x) => !x.id().startsWith('__')).length === 1) {
          cycleSelectedEdgeType();
          e.preventDefault();
        }
        break;
      case 'Enter':
        if (edgeTypeEditing) {
          e.preventDefault();
          commitEdgeTypeEdit();
        } else if (statusEditing) {
          e.preventDefault();
          commitStatusEdit();
        }
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        deleteSelected();
        break;
    }
  });

  // --- Kanban column add buttons (one per column) ---
  document.querySelectorAll('.kb-column-add').forEach((btn) => {
    btn.addEventListener('click', () => createKanbanTask(btn.dataset.status));
  });
  // Kanban-selection toolbar Delete button.
  document.getElementById('btn-kanban-delete')
    .addEventListener('click', deleteSelectedKanbanCards);
  // Panel-footer Delete button (both views).
  document.getElementById('panel-delete')
    .addEventListener('click', deletePanelTask);

  // --- Kanban card click → inspector. Event delegation on #kanban handles
  //     dynamically-rendered cards without per-card listeners. Cmd/Ctrl-click
  //     toggles the card in/out of the selection without affecting others
  //     (mirrors the rubber-band multi-select in graph view). Clicking empty
  //     canvas clears the selection. ---
  const kanbanEl = document.getElementById('kanban');
  kanbanEl.addEventListener('click', (e) => {
    // Ignore clicks on the per-column + button — it has its own handler.
    if (e.target.closest('.kb-column-add')) return;
    const card = e.target.closest('.kb-card');
    if (!card) {
      // Empty area: clear selection + close panel.
      document.querySelectorAll('.kb-card.selected').forEach((c) => c.classList.remove('selected'));
      if (cy) cy.elements('.selected').removeClass('selected');
      if (isPanelOpen()) hidePanel();
      updateKanbanToolbar();
      return;
    }
    if (isCmd(e)) {
      // Toggle this card; leave others alone.
      card.classList.toggle('selected');
      mirrorKbCardSelectionToCy(card);
      const selected = document.querySelectorAll('.kb-card.selected');
      if (selected.length === 1) {
        const taskId = Number(selected[0].dataset.taskId);
        if (Number.isFinite(taskId)) showPanel({ taskId });
      } else if (isPanelOpen()) {
        // 0 or 2+ selected — no single card to show in the inspector.
        hidePanel();
      } else {
        // Panel closed and selection still multi (or zero): the cy mirror
        // changed but no panel transition runs postLocalSelection for us.
        postLocalSelection();
        if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
      }
    } else {
      // Single click: replace selection.
      document.querySelectorAll('.kb-card.selected').forEach((c) => c.classList.remove('selected'));
      if (cy) cy.elements('.selected').removeClass('selected');
      card.classList.add('selected');
      mirrorKbCardSelectionToCy(card);
      const taskId = Number(card.dataset.taskId);
      if (Number.isFinite(taskId)) showPanel({ taskId });
    }
    updateKanbanToolbar();
  });

  // --- Kanban drag-and-drop. Cards carry their task id; columns are drop
  //     targets keyed by data-status. moveKanbanCardToStatus does the OCC
  //     PATCH + optimistic DOM move + snap-back on failure. ---
  kanbanEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kb-card');
    if (!card) return;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.taskId);
  });
  kanbanEl.addEventListener('dragend', (e) => {
    const card = e.target.closest('.kb-card');
    if (card) card.classList.remove('dragging');
    document.querySelectorAll('.kb-column.drag-over').forEach((c) => c.classList.remove('drag-over'));
  });
  kanbanEl.addEventListener('dragover', (e) => {
    const column = e.target.closest('.kb-column');
    if (!column) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.kb-column.drag-over').forEach((c) => {
      if (c !== column) c.classList.remove('drag-over');
    });
    column.classList.add('drag-over');
  });
  kanbanEl.addEventListener('dragleave', (e) => {
    const column = e.target.closest('.kb-column');
    if (!column) return;
    // dragleave fires on every child boundary — only clear when actually leaving.
    if (!column.contains(e.relatedTarget)) column.classList.remove('drag-over');
  });
  kanbanEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const column = e.target.closest('.kb-column');
    if (!column) return;
    column.classList.remove('drag-over');
    const taskId = Number(e.dataTransfer.getData('text/plain'));
    if (!Number.isFinite(taskId)) return;
    moveKanbanCardToStatus(taskId, column.dataset.status);
  });

  // --- Toolbar buttons ---
  // New button branches on view: graph → cytoscape ghost flow; kanban →
  // createKanbanTask in the selected card's column (or Todo). Matches the
  // G hotkey's per-view behavior.
  document.getElementById('btn-new-node').addEventListener('click', () => {
    if (currentView === 'kanban') {
      const selected = document.querySelector('.kb-card.selected');
      const col = selected && selected.closest('.kb-column');
      createKanbanTask((col && col.dataset.status) || 'todo');
    } else {
      createNodeAtCenter();
    }
  });
  document.getElementById('btn-status').addEventListener('click', cycleSelectedNodeStatus);
  document.getElementById('btn-color-node').addEventListener('click', (e) => openColorPalette(e.currentTarget));
  document.getElementById('btn-color-edge').addEventListener('click', (e) => openColorPalette(e.currentTarget));
  document.getElementById('btn-color-selection').addEventListener('click', (e) => openColorPalette(e.currentTarget));
  document.getElementById('btn-connect').addEventListener('click', startEdgeCreation);
  document.getElementById('btn-direction-edge').addEventListener('click', cycleSelectedEdgeType);
  document.getElementById('btn-zoom-fit').addEventListener('click', () => {
    cy.fit(undefined, 50);
  });
  document.getElementById('btn-tidy').addEventListener('click', tidyAndFit);
  document.getElementById('btn-delete-node').addEventListener('click', deleteSelected);
  document.getElementById('btn-delete-edge').addEventListener('click', deleteSelected);
  document.getElementById('btn-delete-selection').addEventListener('click', deleteSelected);
  document.addEventListener('pointerdown', (e) => {
    if (!colorPaletteState.open) return;
    const palette = document.getElementById('color-palette');
    if (palette && palette.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#btn-color-node, #btn-color-edge, #btn-color-selection')) return;
    closeColorPalette();
  });
  window.addEventListener('resize', () => {
    if (colorPaletteState.open) positionColorPalette(getColorPaletteAnchor());
  });

  const curveHandle = document.getElementById('edge-curve-handle');
  curveHandle.addEventListener('pointerdown', (e) => {
    if (!curveHandleEdge) return;
    curveHandleDragging = true;
    curveHandle.classList.add('dragging');
    cy.userPanningEnabled(false);
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!curveHandleDragging || !curveHandleEdge) return;
    setEdgeCurveFromPointer(curveHandleEdge, e);
  });
  window.addEventListener('pointerup', () => {
    if (!curveHandleDragging) return;
    const edge = curveHandleEdge;
    curveHandleDragging = false;
    curveHandle.classList.remove('dragging');
    cy.userPanningEnabled(true);
    persistEdgeCurve(edge);
  });
  curveHandle.addEventListener('mouseleave', () => {
    if (!curveHandleEdge || curveHandleEdge.hasClass('selected')) return;
    scheduleCurveHandleHide(curveHandleEdge);
  });

  // --- Rich editor ---
  richEditor = createRichEditor();

  document.getElementById('mode-rich').addEventListener('click', () => setEditorMode('rich'));
  document.getElementById('mode-raw').addEventListener('click', () => setEditorMode('raw'));

  // --- Panel focus = edit mode for the selected node ---
  // Clicking into any panel field puts the selected node into edit mode (dashed border).
  // Leaving the panel — by clicking the canvas or another item — exits edit mode.
  const panelEl = document.getElementById('panel');
  panelEl.addEventListener('focusin', () => {
    cy.nodes('.selected').forEach((n) => n.addClass('editing'));
  });
  panelEl.addEventListener('focusout', () => {
    setTimeout(() => {
      // Still focused inside the panel? (e.g., tabbing fields) → keep edit mode
      if (panelEl.contains(document.activeElement)) return;
      // Don't drop edit mode if the inline overlay is what's active
      const overlayVisible = !document.getElementById('node-title-overlay').classList.contains('hidden');
      if (overlayVisible) return;
      cy.nodes('.editing').forEach((n) => {
        n.removeClass('editing');
        n.removeStyle('width');
        n.removeStyle('height');
        // Image nodes own their height (plus background-height and
        // text-margin-y) via applyBgDimensions. Stripping height alone
        // collapses the frame and leaves the title shoved outside it — visible
        // when focus leaves the panel mid-edit, e.g. a confirm modal taking
        // focus. Re-apply their geometry from the cached image height.
        if (n.data('backgroundImage') && n.data('bgImageH')) {
          applyBgDimensions(n, n.data('bgImageH'));
        }
      });
    }, 0);
  });

  // --- Panel resize ---
  const panel = document.getElementById('panel');
  const handle = document.getElementById('panel-resize-handle');
  let resizing = false;
  handle.addEventListener('mousedown', (e) => {
    resizing = true;
    panel.classList.add('resizing');
    // Disable kanban transition during drag — every mousemove would otherwise
    // queue a 300ms animation, lagging behind the cursor.
    const kanban = document.getElementById('kanban');
    if (kanban) kanban.classList.add('kanban-no-transition');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const next = window.innerWidth - e.clientX;
    // Cap by the bumper rule (see computePanelMaxWidth) so the avatar bar
    // can't be pushed past the sidebar or into the play/pause button.
    const bumperMax = computePanelMaxWidth();
    const max = Math.min(
      window.innerWidth * 0.95,
      bumperMax != null ? bumperMax : window.innerWidth,
    );
    panel.style.width = Math.min(max, Math.max(PANEL_MIN_WIDTH, next)) + 'px';
    if (typeof adjustPresenceBarOffset === 'function') adjustPresenceBarOffset();
    // Panel width changed → kanban shift may need recompute.
    if (typeof adjustKanbanForPanel === 'function') adjustKanbanForPanel();
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    panel.classList.remove('resizing');
    const kanban = document.getElementById('kanban');
    if (kanban) kanban.classList.remove('kanban-no-transition');
  });

  // --- Autosave ---
  function showSaveStatus(text, kind) {
    const el = document.getElementById('save-status');
    el.textContent = text;
    el.classList.remove('saved-fade');
    el.dataset.kind = kind || '';
    clearTimeout(savedFadeTimer);
    if (kind === 'saved') {
      savedFadeTimer = setTimeout(() => el.classList.add('saved-fade'), 800);
    }
  }
  function clearSaveStatus() {
    const el = document.getElementById('save-status');
    el.textContent = '';
    el.dataset.kind = '';
    el.classList.remove('saved-fade');
    clearTimeout(savedFadeTimer);
  }

  async function performSave() {
    const titleVal = document.getElementById('field-title').value.trim();
    const statusVal = document.getElementById('field-status').value;
    const body = readEditorBody();
    if (!titleVal) return; // server requires a title

    const meta = { ...panelLoadedMeta, title: titleVal, status: statusVal };
    const content = buildContent(meta, body);
    if (content === lastSavedContent) return;

    if (saveInFlight) { pendingSave = true; return; }
    saveInFlight = true;
    showSaveStatus('Saving…', 'saving');

    try {
      const wasNew = !editingTaskId;
      const base = (panelLoadedVersion !== null && panelLoadedContent !== null)
        ? { version: panelLoadedVersion, content: panelLoadedContent }
        : null;
      const res = wasNew
        ? await createTask(content)
        : await updateTask(editingTaskId, content, base);
      if (!res.ok) {
        if (handleConflictStatus(res, 'task')) {
          showSaveStatus('', '');
          await fetchGraph();
          return;
        }
        if (maybeForbid(res)) return;
        showSaveStatus('Save failed', 'error');
        return;
      }
      const saved = await res.json();
      // Refresh the OCC base so the next edit is anchored to what just landed.
      if (saved && typeof saved.version === 'number') {
        panelLoadedVersion = saved.version;
        panelLoadedContent = saved.content;
      }
      if (wasNew && saved && saved.id) {
        // Lazy graph just got real content — don't auto-clean it.
        if (_lazyCreatedGraphId === activeGraphId) _lazyCreatedGraphId = null;
        editingTaskId = saved.id;
        // Now that the node has a stable id, surface the background-image
        // row. (loadIntoEditor isn't called on the new-node commit path —
        // the panel was populated from the user's keystrokes, not from a
        // round-trip — so we sync here explicitly.)
        if (typeof syncBackgroundImageRow === 'function') syncBackgroundImageRow();
        const edgeIntent = pendingEdgesForNewNode;
        removePendingEdgePreviews(edgeIntent);
        pendingEdgesForNewNode = null;
        const overlayVisible = !document.getElementById('node-title-overlay').classList.contains('hidden');
        // Swap the ghost (if any) for the real node, preserving position
        let pos = pendingPosition;
        if (pendingNode && pendingNode.id() === '__pending__' && !pendingNode.removed()) {
          pos = pendingNode.position();
          pendingNode.remove();
        }
        pendingNode = null;
        pendingViewportBeforeCreate = null;
        addGraphNode(saved);
        const real = cy.getElementById(String(saved.id));
        if (real && !real.empty()) {
          if (pos) real.position(pos);
          real.addClass('selected');
          if (overlayVisible) {
            real.addClass('editing');
            real.addClass('inline-title-edit');
          }
          pendingNode = real; // keep tracking so the overlay stays anchored
        }
        await createPendingEdgesForSavedNode(saved.id, edgeIntent);
        await updateLeafHighlights();
        syncNodeToOverlay();
        positionTitleOverlay();
        updateToolbar();
      } else if (saved && saved.id) {
        updateGraphNode(saved);
        await updateLeafHighlights();
      }
      lastSavedContent = content;
      showSaveStatus('✓ Saved', 'saved');
    } catch (err) {
      showSaveStatus('Save failed', 'error');
    } finally {
      saveInFlight = false;
      if (pendingSave) {
        pendingSave = false;
        scheduleSave();
      }
    }
  }

  function scheduleSave() {
    // Suppress saves caused by loadIntoEditor's synthetic editor change.
    if (Date.now() < _editorSaveSuppressedUntil) return;
    if (!editingTaskId && !pendingNode) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(performSave, 200);
  }

  // Explicit "create the new node now" — wired to Enter in the title overlay,
  // title field, and Cmd+Enter globally.
  window.__commitNewNode = async () => {
    if (editingTaskId) return;
    if (!pendingNode) return;
    const titleVal = document.getElementById('field-title').value.trim();
    if (!titleVal) {
      showHint('Title required');
      return;
    }
    await performSave();
    if (editingTaskId) hideTitleOverlay();
  };

  // Allow hidePanel() to flush a pending save synchronously (existing nodes only)
  window.__flushSave = () => { performSave(); };

  // Title input is mirrored across the panel field, the inline overlay, and the cy node label
  function readTitleFrom(source, e) {
    if (source === 'overlay') {
      // Strip newlines and enforce 100 char cap
      let val = e.target.textContent.replace(/[\r\n]+/g, '');
      if (val.length > 100) {
        val = val.slice(0, 100);
        e.target.textContent = val;
        placeCaretAtEnd(e.target);
      }
      return val;
    }
    return e.target.value;
  }

  function onTitleInput(source) {
    return (e) => {
      const val = readTitleFrom(source, e);
      const overlay = document.getElementById('node-title-overlay');
      const overlayVisible = !overlay.classList.contains('hidden');

      // Mirror text between panel field and overlay
      if (source !== 'field') {
        const fld = document.getElementById('field-title');
        if (fld.value !== val) fld.value = val;
      }
      if (source !== 'overlay' && overlayVisible && overlay.textContent !== val) {
        overlay.textContent = val;
      }

      // Live-update the cytoscape node label ONLY while in edit mode.
      // In selected-only mode, the panel autosave round-trip will update it.
      if (overlayVisible) {
        const node = getActiveNode();
        if (node) node.data('title', val);
        syncNodeToOverlay();
        positionTitleOverlay();
      }

      scheduleSave();
    };
  }
  document.getElementById('field-title').addEventListener('input', onTitleInput('field'));
  document.getElementById('field-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !editingTaskId && pendingNode) {
      e.preventDefault();
      window.__commitNewNode();
    }
  });
  document.getElementById('node-title-overlay').addEventListener('input', onTitleInput('overlay'));
  document.getElementById('node-title-overlay').addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text').replace(/[\r\n]+/g, ' ');
    document.execCommand('insertText', false, text);
  });
  document.getElementById('node-title-overlay').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelPendingNode();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!editingTaskId && pendingNode) {
        // New node — Enter commits the create
        window.__commitNewNode();
      } else {
        // Existing node — just dismiss the inline title editor
        e.target.blur();
        hideTitleOverlay();
      }
    }
  });

  document.getElementById('field-status').addEventListener('change', scheduleSave);
  document.getElementById('raw-editor').addEventListener('input', scheduleSave);
  richEditor.on('change', scheduleSave);

  // Background image row: one field that handles click → file picker, drag &
  // drop, and Enter/Space for keyboard. The × button clears with a confirm.
  // Global paste (further down) also routes here when an image is on the
  // clipboard and a node is selected.
  const bgFileInput = document.getElementById('bg-image-input');
  const bgField = document.getElementById('bg-image-field');
  const bgClearBtn = document.getElementById('bg-image-clear');
  bgField.addEventListener('click', (e) => {
    if (e.target === bgClearBtn || bgClearBtn.contains(e.target)) return;
    bgFileInput.click();
  });
  bgField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      bgFileInput.click();
    }
  });
  bgField.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    bgField.classList.add('dragover');
  });
  bgField.addEventListener('dragleave', () => bgField.classList.remove('dragover'));
  bgField.addEventListener('drop', async (e) => {
    bgField.classList.remove('dragover');
    const file = Array.from(e.dataTransfer?.files || []).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    await setBackgroundFromFile(file);
  });
  bgFileInput.addEventListener('change', async () => {
    const file = bgFileInput.files && bgFileInput.files[0];
    // Reset so picking the same file twice in a row still triggers change.
    bgFileInput.value = '';
    if (!file) return;
    await setBackgroundFromFile(file);
  });
  bgClearBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (editingTaskId == null) return;
    const ok = await confirmDelete('This will clear the image from the node.', {
      title: 'Remove image?',
      confirmText: 'Remove',
    });
    if (!ok) return;
    const node = cy.getElementById(String(editingTaskId));
    if (!node || node.empty()) return;
    try {
      await persistNodeBackgroundImage(node, null);
    } catch (err) {
      showHint(err.message || 'Could not remove image');
    }
  });

  // Document-level paste: if the user has copied an image and has a single
  // task selected (panel-open or canvas-only), set it as that node's
  // background. Skips when a real text input has focus so normal text paste
  // keeps working in fields, the markdown editor, and contenteditables.
  document.addEventListener('paste', async (e) => {
    const ae = document.activeElement;
    const inTextInput = ae && (
      (ae.tagName === 'INPUT' && ae.type !== 'file') ||
      ae.tagName === 'TEXTAREA' ||
      ae.isContentEditable
    );
    // The bg-image-field is focusable but it IS the paste target, so don't
    // treat it as "in a text input."
    const inBgField = ae && ae.id === 'bg-image-field';
    if (inTextInput && !inBgField) return;
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const imageItem = items.find((it) => it.type && it.type.startsWith('image/'));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    const taskId = pickedTaskIdForBgPaste();
    if (taskId == null) {
      showHint('Select a node first to set its background image');
      return;
    }
    e.preventDefault();
    // Pasted images rarely carry a filename. Derive one from the MIME so the
    // panel has something better than "Image" to show.
    const ext = (file.type.split('/')[1] || 'png').toLowerCase();
    const fallbackName = file.name || `Pasted image.${ext}`;
    await setBackgroundFromFile(file, taskId, fallbackName);
  });

  async function setBackgroundFromFile(file, explicitTaskId = null, nameOverride = null) {
    const taskId = explicitTaskId != null ? explicitTaskId : editingTaskId;
    if (taskId == null) return;
    const node = cy.getElementById(String(taskId));
    if (!node || node.empty()) return;
    // Replacing an existing image — confirm before wasting an upload on bytes
    // the user might cancel out of. Covers paste, click-to-choose, and a drop
    // onto the panel field; the canvas-level drop has its own matching confirm.
    if (node.data('backgroundImage')) {
      const ok = await confirmDelete('This will delete your current image.', {
        title: 'Replace image?',
        confirmText: 'Replace',
      });
      if (!ok) return;
    }
    let upload;
    try {
      upload = await uploadImageFile(file);
    } catch (err) {
      showHint(err.message || 'Image upload failed');
      return;
    }
    const filename = nameOverride || file.name || '';
    const url = filename ? `${upload.url}?name=${encodeURIComponent(filename)}` : upload.url;
    try {
      await persistNodeBackgroundImage(node, url);
    } catch (err) {
      showHint(err.message || 'Could not save image');
    }
  }

  function pickedTaskIdForBgPaste() {
    if (editingTaskId != null) return editingTaskId;
    if (!cy) return null;
    const sel = cy.nodes('.selected').filter((n) => Number.isFinite(n.data('taskId')));
    if (sel.length !== 1) return null;
    return sel[0].data('taskId');
  }

  // Keep the empty-state placeholder in sync with whether anything (pending
  // node included) is on the canvas, and trigger lazy-graph cleanup when the
  // canvas drops back to zero nodes.
  cy.on('add remove', 'node', () => updateEmptyState());
  cy.on('remove', 'node', () => maybeCleanupLazyGraph());

  // Multi-peer presence: broadcast our local cytoscape selection so peers
  // see what we have selected/are editing on this graph. The .selected CSS
  // class is set by the tap handlers above (line ~5716, ~5744) and by
  // data-refresh at line ~5454; we hook tap with a 0ms defer so our read
  // sees the post-handler class state. postLocalSelection is debounced +
  // dedup'd so shift-selecting a range doesn't spam POSTs.
  cy.on('tap', () => setTimeout(() => {
    postLocalSelection();
    peerCursorRefresh();
  }, 0));
  cy.on('cxttap', () => setTimeout(() => {
    postLocalSelection();
    peerCursorRefresh();
  }, 0));

  // Drag-drop an image onto the canvas. Drop on a node sets/replaces its
  // background-image; drop on empty canvas creates a fresh node with the
  // image. Bytes go through /api/graphs/:gid/uploads so the resulting task
  // PATCH stays small and the editor and canvas share one storage model.
  const cyContainer = document.getElementById('cy');
  cyContainer.addEventListener('dragover', (e) => {
    // Only intercept file drags. dataTransfer.types is a DOMStringList in
    // some browsers; coerce to an array for the .includes() check.
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  cyContainer.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    const imageFile = files.find((f) => f.type.startsWith('image/'));
    if (!imageFile) return;
    e.preventDefault();
    if (!cy || !activeGraphId) return;

    const rect = cyContainer.getBoundingClientRect();
    const rendered = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    let dropTarget = null;
    try {
      const hit = cy.elementsAt(rendered);
      dropTarget = hit
        .filter((el) => el.isNode() && Number.isFinite(el.data('taskId')))
        .first();
      if (dropTarget && dropTarget.empty()) dropTarget = null;
    } catch {}

    // Hitting an existing node with an image already set — confirm before
    // wasting an upload on bytes the user might cancel out of.
    if (dropTarget && dropTarget.data('backgroundImage')) {
      const ok = await confirmDelete('This will delete your current image.', {
        title: 'Replace image?',
        confirmText: 'Replace',
      });
      if (!ok) return;
    }

    let upload;
    try {
      upload = await uploadImageFile(imageFile);
    } catch (err) {
      showHint(err.message || 'Image upload failed');
      return;
    }

    const filenameForUrl = imageFile.name
      ? `${upload.url}?name=${encodeURIComponent(imageFile.name)}`
      : upload.url;
    if (dropTarget) {
      try {
        await persistNodeBackgroundImage(dropTarget, filenameForUrl);
      } catch (err) {
        showHint(err.message || 'Could not save image');
      }
      return;
    }

    // Empty canvas: create a new node at the drop position, image pre-set.
    // World coords go into meta.x/y so the fetchGraph reload places the new
    // node exactly where it was dropped (same convention as click-create).
    const pan = cy.pan();
    const zoom = cy.zoom();
    const wx = Math.round((rendered.x - pan.x) / zoom);
    const wy = Math.round((rendered.y - pan.y) / zoom);
    const content = `---\ntitle: Untitled\nstatus: todo\nx: ${wx}\ny: ${wy}\nbackground-image: ${filenameForUrl}\n---\n`;
    const res = await createTask(content);
    if (!res.ok) {
      if (!maybeForbid(res)) showHint('Create failed');
      return;
    }
    await fetchGraph();
  });

  // Reposition the inline overlay when the canvas moves or the active node moves
  cy.on('pan zoom resize', () => {
    syncNodeToOverlay();
    positionTitleOverlay();
    updateCurveHandlePosition();
    // Peer cursors are anchored in rendered coordinates — pan/zoom shifts
    // every anchor. Keep refresh cheap; the simulation snaps to rest fast.
    if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
  });
  cy.on('position', 'node', (evt) => {
    const node = getActiveNode();
    if (node && evt.target.id() === node.id()) positionTitleOverlay();
    updateCurveHandlePosition();
    // A peer cursor anchored to a node should follow it as the user drags.
    if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
  });
  window.addEventListener('resize', () => {
    positionTitleOverlay();
    updateCurveHandlePosition();
    // Viewport width feeds into the panel cap (computePanelMaxWidth). A
    // shrunk window can push the avatar bar over the play/pause button
    // if we don't re-clamp.
    if (typeof adjustPresenceBarOffset === 'function') adjustPresenceBarOffset();
    if (typeof fitBottomBar === 'function') fitBottomBar();
    // Kanban peer-cursor anchors are viewport-relative — resize shifts them.
    if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
    // Kanban shift depends on panel left edge which moves with the viewport.
    if (typeof adjustKanbanForPanel === 'function') adjustKanbanForPanel();
  });

  // --- Kanban scroll repositioning for peer cursors. Each column's card
  //     list scrolls vertically; the whole kanban scrolls horizontally on
  //     mobile. Both shift `.kb-card.getBoundingClientRect()` and therefore
  //     the cursor positions anchored off them. ---
  document.querySelectorAll('.kb-column-cards').forEach((c) => {
    c.addEventListener('scroll', () => {
      if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
    }, { passive: true });
  });
  document.getElementById('kanban').addEventListener('scroll', () => {
    if (typeof peerCursorRefresh === 'function') peerCursorRefresh();
  }, { passive: true });

  // --- Hide-presence eye toggle. Click hides/shows both #presence-bar and
  //     #btn-follow-toggle; state is per-user (localStorage), applies to
  //     both views. Eye fades in on hover over either presence element or
  //     itself; stays faintly visible while the cluster is hidden so the
  //     user can un-hide. ---
  const presenceEye = document.getElementById('presence-eye');
  const presenceBar = document.getElementById('presence-bar');
  const followBtn = document.getElementById('btn-follow-toggle');
  function setPresenceHidden(hidden) {
    document.body.classList.toggle('presence-hidden', !!hidden);
    try { localStorage.setItem('graphtask:presence-hidden', hidden ? '1' : '0'); } catch {}
    if (!presenceEye) return;
    // Icon swap is CSS-driven off `body.presence-hidden` + `:hover`.
    // Only the label/title need updating here.
    const label = hidden ? 'Show collaborators' : 'Hide collaborators';
    presenceEye.setAttribute('aria-label', label);
    presenceEye.title = label;
  }
  try {
    if (localStorage.getItem('graphtask:presence-hidden') === '1') setPresenceHidden(true);
  } catch {}
  if (presenceEye) {
    presenceEye.addEventListener('click', () => {
      setPresenceHidden(!document.body.classList.contains('presence-hidden'));
    });
    const showEye = () => presenceEye.classList.add('is-visible');
    const hideEye = () => {
      // Don't remove `.is-visible` while the cluster is hidden — the eye
      // needs to stay reachable to un-hide. CSS handles the faded state
      // via body.presence-hidden.
      if (!document.body.classList.contains('presence-hidden')) {
        presenceEye.classList.remove('is-visible');
      }
    };
    [presenceBar, followBtn, presenceEye].forEach((el) => {
      if (!el) return;
      el.addEventListener('mouseenter', showEye);
      el.addEventListener('mouseleave', hideEye);
      el.addEventListener('focusin', showEye);
      el.addEventListener('focusout', hideEye);
    });
  }

  document.getElementById('task-form').addEventListener('submit', (e) => e.preventDefault());

  document.getElementById('panel-close').addEventListener('click', hidePanel);

  // --- Settings overlay (Cmd+K) wiring ---
  document.getElementById('btn-settings').addEventListener('click', openGraphSettings);
  document.getElementById('settings-search').addEventListener('input', () => {
    settingsState.activeIndex = 0;
    renderSettings();
  });
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'settings-overlay') closeSettings();
  });
  applySettings();

  // Sidebar wiring. The "+ New Graph" header button creates graphs; the
  // collapsed-only `+` button does the same from the skinny strip. The
  // bottom-pinned gear opens app-level Defaults.
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  const expandBtn = document.getElementById('sidebar-expand-btn');
  const newBtn = document.getElementById('sidebar-new-btn');
  const newBtnCollapsed = document.getElementById('sidebar-new-btn-collapsed');
  const appSettingsBtn = document.getElementById('app-settings-btn');
  if (collapseBtn) collapseBtn.addEventListener('click', () => setSidebarCollapsed(true));
  if (expandBtn) expandBtn.addEventListener('click', () => setSidebarCollapsed(false));
  if (newBtn) newBtn.addEventListener('click', () => { createGraphFromUI(); });
  if (newBtnCollapsed) newBtnCollapsed.addEventListener('click', () => { createGraphFromUI(); });
  if (appSettingsBtn) appSettingsBtn.addEventListener('click', () => {
    if (isSidebarCollapsed()) setSidebarCollapsed(false);
    openSettings();
  });
  applySidebarCollapsedFromStorage();

  // Boot sidebar — fetches graphs, resolves active graph, loads its data.
  // Replaces the old single-graph fetchGraph() bootstrap.
  bootSidebar().then(() => {
    if (activeGraphId != null) updateToolbar();
  });
});
