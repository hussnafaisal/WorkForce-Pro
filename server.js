require('fs').existsSync('.env') && require('fs').readFileSync('.env', 'utf8').split('\n').forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim(); });
const compression = require('compression'), express = require('express'), helmet = require('helmet'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const { get, all, run, ins, tx, init, seed, newCompany } = require('./db');
const SECRET = process.env.JWT_SECRET || 'dev-secret'; const OFF = +(process.env.TZ_OFFSET_MIN || 0);
if (SECRET === 'dev-secret' || SECRET.startsWith('change-this')) console.warn('WARNING: set a strong JWT_SECRET');
const app = express();
['get', 'post', 'put', 'patch', 'delete'].forEach(m => { const o = app[m].bind(app); app[m] = (...a) => { if (a.length < 2) return o(...a); const f = a.pop();
  a.push((req, res, next) => Promise.resolve(f(req, res, next)).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Server error' }); })); return o(...a); }; });
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
app.use(compression()); app.use(express.json({ limit: '100kb' })); app.use(express.static('public', { maxAge: '1d' }));
const local = () => { const d = new Date(Date.now() + OFF * 60000).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) }; };
const audit = (u, a) => { run('INSERT INTO audit(company_id,at,actor,action) VALUES(?,?,?,?)', u.cid, new Date().toISOString(), u.name, a).catch(e => console.error('audit', e.message)); }; // non-blocking
// short-lived cache for user/company rows (cleared on every write) to avoid a DB round-trip per request
const UC = new Map(), CC = new Map(), TTL = 15000;
const cached = async (m, k, f) => { const e = m.get(k), t = Date.now(); if (e && e.x > t) return e.v; const v = await f(); if (v) m.set(k, { v, x: t + TTL }); return v; };
const getUser = id => cached(UC, id, () => get('SELECT * FROM users WHERE id=? AND active=1', id));
const getCo = cid => cached(CC, cid, () => get('SELECT * FROM companies WHERE id=?', cid));
app.use((req, res, next) => { if (req.method !== 'GET' && req.method !== 'OPTIONS') { UC.clear(); CC.clear(); res.on('finish', () => { UC.clear(); CC.clear(); }); } next(); });
const tries = new Map();
function limit(req, res, next) { const k = req.ip, t = Date.now(), a = (tries.get(k) || []).filter(x => t - x < 900000);
  if (a.length >= 10) return res.status(429).json({ error: 'Too many attempts, try again in 15 minutes' }); a.push(t); tries.set(k, a); next(); }
const auth = (...roles) => async (req, res, next) => { let p, u;
  try { p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); } catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }
  try { u = await getUser(p.id); } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.u = { id: u.id, cid: u.company_id, name: u.name, role: u.role, u }; if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'Forbidden' }); next(); };
const mgr = auth('admin', 'manager'), any = auth();
const token = u => jwt.sign({ id: u.id }, SECRET, { expiresIn: '12h' });
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept, title: u.title, active: u.active, policy: u.policy, shift_start: u.shift_start, annual: u.annual, sick: u.sick });
require('./extra')(app, { get, all, run, ins, tx, auth, mgr, any, audit, local, OFF, bcrypt, jwt, SECRET, getUser, getCo });
const isM = r => ['admin', 'manager'].includes(r);

app.post('/api/auth/login', limit, async (req, res) => { const { email = '', password = '' } = req.body;
  const u = await get('SELECT * FROM users WHERE email=? AND active=1', email.toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password, u.hash)) return res.status(401).json({ error: 'Invalid email or password' });
  await audit({ cid: u.company_id, name: u.name }, 'Signed in'); res.json({ token: token(u), user: pub(u) }); });
app.post('/api/auth/signup', limit, async (req, res) => { const { company, name, email, password } = req.body;
  if (!company || !name || !/^\S+@\S+$/.test(email || '') || (password || '').length < 8) return res.status(400).json({ error: 'Company, name, valid email and 8+ char password required' });
  if (await get('SELECT 1 FROM users WHERE email=?', email.toLowerCase())) return res.status(409).json({ error: 'Email already registered' });
  const cid = await newCompany(company); const id = await ins("INSERT INTO users(company_id,name,email,hash,role) VALUES(?,?,?,?,'admin')", cid, name, email.toLowerCase(), bcrypt.hashSync(password, 12));
  await audit({ cid, name }, 'Company created'); res.json({ token: token({ id }) }); });
app.get('/api/me', any, async (req, res) => res.json({ ...pub(req.u.u), company: await getCo(req.u.cid) }));

app.get('/api/employees', mgr, async (req, res) => res.json((await all('SELECT * FROM users WHERE company_id=? ORDER BY name', req.u.cid)).map(pub)));
app.post('/api/employees', mgr, async (req, res) => { const b = req.body;
  if (!b.name || !/^\S+@\S+$/.test(b.email || '') || (b.password || '').length < 8) return res.status(400).json({ error: 'Name, valid email, 8+ char password required' });
  if (await get('SELECT 1 FROM users WHERE email=?', b.email.toLowerCase())) return res.status(409).json({ error: 'Email exists' });
  if (!(await app.locals.canAdd(req.u.cid))) return res.status(402).json({ error: 'Employee limit for your plan reached. Upgrade the plan.' });
  const role = req.u.role === 'admin' && ['admin', 'manager', 'employee'].includes(b.role) ? b.role : 'employee';
  const id = await ins('INSERT INTO users(company_id,name,email,hash,role,dept,title,policy,shift_start) VALUES(?,?,?,?,?,?,?,?,?)', req.u.cid, b.name, b.email.toLowerCase(), bcrypt.hashSync(b.password, 12), role,
    b.dept || 'General', b.title || 'Staff', ['office', 'remote', 'field'].includes(b.policy) ? b.policy : 'office', b.shift_start || '09:00');
  await audit(req.u, 'Onboarded ' + b.name); res.json({ id }); });
app.patch('/api/employees/:id', mgr, async (req, res) => { const t = await get('SELECT * FROM users WHERE id=? AND company_id=?', req.params.id, req.u.cid);
  if (!t) return res.status(404).json({ error: 'Not found' }); const b = req.body;
  await run('UPDATE users SET active=?,dept=?,title=?,policy=?,shift_start=? WHERE id=?', b.active ?? t.active, b.dept ?? t.dept, b.title ?? t.title, b.policy ?? t.policy, b.shift_start ?? t.shift_start, t.id);
  await audit(req.u, 'Updated ' + t.name); res.json({ ok: 1 }); });

app.post('/api/attendance/checkin', any, async (req, res) => { const { date, time } = local(), u = req.u.u;
  const [dup, st, comp] = await Promise.all([get('SELECT 1 FROM attendance WHERE user_id=? AND date=?', u.id, date), app.locals.settings(u.company_id), getCo(u.company_id)]);
  if (dup) return res.status(409).json({ error: 'Already checked in today' });
  const gs = st.geo;
  if (gs.policies[u.policy] && gs.lat != null) { const { lat, lon } = req.body; if (lat == null || lon == null) return res.status(400).json({ error: 'Location required for your attendance policy' });
    if (app.locals.dist(lat, lon, gs.lat, gs.lon) > gs.radius + 150) return res.status(403).json({ error: 'You are outside the allowed work location' }); }
  const g = comp.grace, [h, m] = u.shift_start.split(':').map(Number);
  const [ch, cm] = time.split(':').map(Number), late = ch * 60 + cm > h * 60 + m + g ? 1 : 0;
  await run('INSERT INTO attendance(company_id,user_id,date,in_at,late,lat,lon,device) VALUES(?,?,?,?,?,?,?,?)', u.company_id, u.id, date, new Date().toISOString(), late,
    req.body.lat ?? null, req.body.lon ?? null, String(req.body.device || '').slice(0, 80)); await audit(req.u, 'Check-in'); res.json({ late }); });
app.post('/api/attendance/checkout', any, async (req, res) => { const n = await run('UPDATE attendance SET out_at=? WHERE user_id=? AND date=? AND out_at IS NULL', new Date().toISOString(), req.u.id, local().date);
  if (!n) return res.status(409).json({ error: 'No open check-in today' }); await audit(req.u, 'Check-out'); res.json({ ok: 1 }); });
app.get('/api/attendance', any, async (req, res) => { const from = req.query.from || local().date, to = req.query.to || from;
  res.json(await all(`SELECT a.*,u.name FROM attendance a JOIN users u ON u.id=a.user_id WHERE a.company_id=? AND a.date BETWEEN ? AND ? ${isM(req.u.role) ? '' : 'AND a.user_id=' + req.u.id} ORDER BY a.date DESC,a.in_at DESC`, req.u.cid, from, to)); });
app.get('/api/dashboard', mgr, async (req, res) => { const { date } = local(), c = req.u.cid;
  const [active, rows, absent, pl, pc] = await Promise.all([get('SELECT COUNT(*) n FROM users WHERE company_id=? AND active=1', c),
    all('SELECT a.*,u.name FROM attendance a JOIN users u ON u.id=a.user_id WHERE a.company_id=? AND a.date=?', c, date),
    all('SELECT name,dept FROM users WHERE company_id=? AND active=1 AND id NOT IN (SELECT user_id FROM attendance WHERE company_id=? AND date=?)', c, c, date),
    get("SELECT COUNT(*) n FROM leave WHERE company_id=? AND status='Pending'", c), get("SELECT COUNT(*) n FROM corrections WHERE company_id=? AND status='Pending'", c)]);
  res.json({ date, active: active.n, present: rows.length, late: rows.filter(r => r.late), absent, pendingLeave: pl.n, pendingCorr: pc.n }); });
app.get('/api/reports/attendance.csv', mgr, async (req, res) => { const f = req.query.from || '0000-00-00', t = req.query.to || '9999-12-31';
  const rows = await all('SELECT a.date,u.name,u.dept,a.in_at,a.out_at,a.late,a.corrected FROM attendance a JOIN users u ON u.id=a.user_id WHERE a.company_id=? AND a.date BETWEEN ? AND ? ORDER BY a.date', req.u.cid, f, t);
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"'; res.type('text/csv').send(['date,name,department,check_in,check_out,late,corrected', ...rows.map(r => [r.date, r.name, r.dept, r.in_at, r.out_at, r.late ? 'Y' : 'N', r.corrected ? 'Y' : 'N'].map(q).join(','))].join('\n')); });

const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5) + 1;
app.post('/api/leave', any, async (req, res) => { const { type, from, to, reason } = req.body, n = days(from, to);
  if (!['annual', 'sick'].includes(type) || !(n > 0) || n > req.u.u[type]) return res.status(400).json({ error: 'Invalid dates or insufficient balance' });
  await run('INSERT INTO leave(company_id,user_id,type,from_d,to_d,days,reason) VALUES(?,?,?,?,?,?,?)', req.u.cid, req.u.id, type, from, to, n, reason || ''); await audit(req.u, 'Leave requested'); res.json({ ok: 1 }); });
app.get('/api/leave', any, async (req, res) => res.json(await all(`SELECT l.*,u.name FROM leave l JOIN users u ON u.id=l.user_id WHERE l.company_id=? ${isM(req.u.role) ? '' : 'AND l.user_id=' + req.u.id} ORDER BY l.id DESC`, req.u.cid)));
app.post('/api/leave/:id/decision', mgr, async (req, res) => { const l = await get("SELECT * FROM leave WHERE id=? AND company_id=? AND status='Pending'", req.params.id, req.u.cid);
  if (!l) return res.status(404).json({ error: 'Not found or already decided' }); const ok = !!req.body.approve;
  await tx(async t => { await t.run('UPDATE leave SET status=?,decided_by=? WHERE id=?', ok ? 'Approved' : 'Rejected', req.u.name, l.id);
    if (ok) await t.run(`UPDATE users SET ${l.type}=${l.type}-? WHERE id=?`, l.days, l.user_id); }); await audit(req.u, (ok ? 'Approved' : 'Rejected') + ' leave #' + l.id); res.json({ ok: 1 }); });
app.post('/api/corrections', any, async (req, res) => { const { date, in_t, out_t, reason } = req.body; if (!date || !in_t || !reason) return res.status(400).json({ error: 'date, in_t, reason required' });
  await run('INSERT INTO corrections(company_id,user_id,date,in_t,out_t,reason) VALUES(?,?,?,?,?,?)', req.u.cid, req.u.id, date, in_t, out_t || null, reason); await audit(req.u, 'Correction requested for ' + date); res.json({ ok: 1 }); });
app.get('/api/corrections', any, async (req, res) => res.json(await all(`SELECT c.*,u.name FROM corrections c JOIN users u ON u.id=c.user_id WHERE c.company_id=? ${isM(req.u.role) ? '' : 'AND c.user_id=' + req.u.id} ORDER BY c.id DESC`, req.u.cid)));
app.post('/api/corrections/:id/decision', mgr, async (req, res) => { const c = await get("SELECT * FROM corrections WHERE id=? AND company_id=? AND status='Pending'", req.params.id, req.u.cid);
  if (!c) return res.status(404).json({ error: 'Not found or already decided' }); const ok = !!req.body.approve, iso = t => new Date(new Date(c.date + 'T' + t + ':00Z').getTime() - OFF * 60000).toISOString();
  await tx(async t => { await t.run('UPDATE corrections SET status=?,decided_by=? WHERE id=?', ok ? 'Approved' : 'Rejected', req.u.name, c.id);
    if (ok) { const a = await t.get('SELECT id FROM attendance WHERE user_id=? AND date=?', c.user_id, c.date);
      if (a) await t.run('UPDATE attendance SET in_at=?,out_at=COALESCE(?::text,out_at),late=0,corrected=1 WHERE id=?', iso(c.in_t), c.out_t ? iso(c.out_t) : null, a.id);
      else await t.run('INSERT INTO attendance(company_id,user_id,date,in_at,out_at,late,corrected) VALUES(?,?,?,?,?,0,1)', c.company_id, c.user_id, c.date, iso(c.in_t), c.out_t ? iso(c.out_t) : null); } });
  await audit(req.u, (ok ? 'Approved' : 'Rejected') + ' correction #' + c.id); res.json({ ok: 1 }); });
app.get('/api/audit', mgr, async (req, res) => res.json(await all('SELECT * FROM audit WHERE company_id=? ORDER BY id DESC LIMIT 200', req.u.cid)));
app.get('/health', (q, r) => r.json({ ok: 1 }));
init().then(seed).then(() => { app.locals.purge().catch(() => {}); setInterval(() => app.locals.purge().catch(() => {}), 864e5).unref();
  app.listen(process.env.PORT || 3000, () => console.log('WorkForce Pro on :' + (process.env.PORT || 3000))); }).catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
