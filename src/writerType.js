// Reads the X-Writer-Type request header and attaches `req.writerType`
// ('human' | 'agent') for downstream routes. Defaults to 'human' on missing
// or unrecognized values so an unidentified request never silently wins as
// an agent (matters for human-wins-on-same-field conflict resolution).
export function writerType(req, _res, next) {
  const raw = req.headers['x-writer-type'];
  req.writerType = raw === 'agent' ? 'agent' : 'human';
  next();
}
