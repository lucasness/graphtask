// /api/me/* — per-user surface area. Currently just agent_tokens CRUD; will
// host other "this user's data" endpoints (preferences, profile) later.
//
// Permission model:
// - GET tokens — any authed request (including via agent token itself). Lets
//   the agent confirm what it's running as.
// - POST / DELETE tokens — only browser sessions. An agent token CANNOT mint
//   new tokens or revoke peers, so a leaked token's blast radius is limited
//   to graph access, not credential escalation.
import { Router } from 'express';
import { createToken, listTokens, revokeToken } from '../auth/agent_tokens.js';

const router = Router();

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'sign in required' });
  next();
}

function requireBrowserUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'sign in required' });
  if (req.viaAgentToken) {
    return res.status(403).json({ error: 'agent tokens cannot manage tokens' });
  }
  next();
}

const LABEL_MAX = 64;

router.post('/agent_tokens', requireBrowserUser, async (req, res) => {
  let label = req.body?.label;
  if (label !== undefined && label !== null) {
    if (typeof label !== 'string') {
      return res.status(400).json({ error: 'label must be a string' });
    }
    label = label.trim().slice(0, LABEL_MAX);
    if (label.length === 0) label = null;
  } else {
    label = null;
  }
  const { token, row } = await createToken(req.user.id, label);
  res.status(201).json({
    token,
    record: {
      id: row.id,
      label: row.label,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
    },
  });
});

router.get('/agent_tokens', requireUser, async (req, res) => {
  res.json(await listTokens(req.user.id));
});

router.delete('/agent_tokens/:id', requireBrowserUser, async (req, res) => {
  const revoked = await revokeToken(req.params.id, req.user.id);
  if (!revoked) return res.status(404).json({ error: 'not found or already revoked' });
  res.json(revoked);
});

export default router;
