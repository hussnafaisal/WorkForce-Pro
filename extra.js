// Shifts, holidays, announcements, settings/geofence, payroll, billing, passwords, retention (PostgreSQL)
module.exports = (app, { get, all, run, ins, tx, auth, mgr, any, audit, local, OFF, bcrypt, jwt, SECRET, getUser, getCo }) => {
  const adm = auth('admin'), isM = r => ['admin', 'manager'].includes(r);
  const DEF = { geo: { lat: null, lon: null, radius: 200, policies: { office: true, remote: false, field: false } }, retention_days: 90, overtime_hours: 8 };
  const settings = async cid => { const r = await get('SELECT json FROM settings WHERE company_id=?', cid); const s = r ? JSON.parse(r.json) : {};
    return { ...DEF, ...s, geo: { ...DEF.geo, ...(s.geo || {}), policies: { ...DEF.geo.policies, ...((s.geo || {}).policies || {}) } } }; };
  const dist = (a, b, c, d) => { const r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r, h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
  const LIM = { trial: 10, starter: 10, growth: 50, business: 200, enterprise: 1e9 };
  const co = getCo;
  const valid = c => !c.trial_ends || c.trial_ends >= local().date;
  app.locals.settings = settings; app.locals.dist = dist;
  app.locals.canAdd = async cid => (await get('SELECT COUNT(*) n FROM users WHERE company_id=? AND active=1', cid)).n < (LIM[(await co(cid)).plan] || 10);
  app.use('/api', async (req, res, next) => { if (req.method === 'GET' || req.method === 'OPTIONS' || /^\/(auth|superadmin)/.test(req.path)) return next();
    try { const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); const u = await getUser(p.id); if (u) u.company_id = u.company_id;
      if (u && !valid(await co(u.company_id))) return res.status(402).json({ error: 'Trial or subscription expired. Contact your administrator to renew.' }); } catch (e) {} next(); });
  const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) && v >= lo && v <= hi ? v : d; };
  app.get('/api/settings', mgr, async (q, r) => r.json({ ...(await settings(q.u.cid)), grace: (await co(q.u.cid)).grace }));
  app.put('/api/settings', adm, async (q, r) => { const o = await settings(q.u.cid), b = q.body, g = b.geo || {};
    const n = { geo: { lat: g.lat === null || g.lat === '' ? null : num(g.lat, -90, 90, o.geo.lat), lon: g.lon === null || g.lon === '' ? null : num(g.lon, -180, 180, o.geo.lon), radius: num(g.radius, 100, 5000, o.geo.radius),
      policies: { office: !!(g.policies || o.geo.policies).office, remote: !!(g.policies || o.geo.policies).remote, field: !!(g.policies || o.geo.policies).field } },
      retention_days: num(b.retention_days, 7, 365, o.retention_days), overtime_hours: num(b.overtime_hours, 1, 24, o.overtime_hours) };
    await run('INSERT INTO settings(company_id,json) VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET json=excluded.json', q.u.cid, JSON.stringify(n));
    if (b.grace !== undefined) await run('UPDATE companies SET grace=? WHERE id=?', num(b.grace, 0, 120, 10), q.u.cid); await audit(q.u, 'Settings updated'); r.json({ ok: 1 }); });
  app.post('/api/auth/password', any, async (q, r) => { const { old, password } = q.body; if ((password || '').length < 8) return r.status(400).json({ error: 'New password must be 8+ characters' });
    if (!bcrypt.compareSync(old || '', q.u.u.hash)) return r.status(401).json({ error: 'Current password is wrong' });
    await run('UPDATE users SET hash=? WHERE id=?', bcrypt.hashSync(password, 12), q.u.id); await audit(q.u, 'Password changed'); r.json({ ok: 1 }); });
  app.post('/api/employees/:id/password', adm, async (q, r) => { const t = await get('SELECT * FROM users WHERE id=? AND company_id=?', q.params.id, q.u.cid);
    if (!t || (q.body.password || '').length < 8) return r.status(400).json({ error: 'Invalid request (8+ char password)' });
    await run('UPDATE users SET hash=? WHERE id=?', bcrypt.hashSync(q.body.password, 12), t.id); await audit(q.u, 'Password reset for ' + t.name); r.json({ ok: 1 }); });
  app.get('/api/shifts', any, async (q, r) => r.json(await all('SELECT * FROM shifts WHERE company_id=? ORDER BY id', q.u.cid)));
  app.post('/api/shifts', mgr, async (q, r) => { const { name, start, end } = q.body; if (!name || !/^\d\d:\d\d$/.test(start || '') || !/^\d\d:\d\d$/.test(end || '')) return r.status(400).json({ error: 'name, start, end (HH:MM) required' });
    await run('INSERT INTO shifts(company_id,name,start,"end") VALUES(?,?,?,?)', q.u.cid, name, start, end); await audit(q.u, 'Shift template ' + name); r.json({ ok: 1 }); });
  const assign = async (uid, sid, cid) => { const s = await get('SELECT * FROM shifts WHERE id=? AND company_id=?', sid, cid); if (!s) return false;
    return (await run('UPDATE users SET shift_id=?,shift_start=? WHERE id=? AND company_id=?', s.id, s.start, uid, cid)) > 0; };
  app.post('/api/shifts/assign', mgr, async (q, r) => (await assign(q.body.user_id, q.body.shift_id, q.u.cid)) ? (await audit(q.u, 'Shift assigned to user #' + q.body.user_id), r.json({ ok: 1 })) : r.status(404).json({ error: 'Not found' }));
  app.post('/api/shift-requests', any, async (q, r) => { if (!(await get('SELECT 1 FROM shifts WHERE id=? AND company_id=?', q.body.shift_id, q.u.cid))) return r.status(400).json({ error: 'Invalid shift' });
    await run('INSERT INTO shift_requests(company_id,user_id,shift_id) VALUES(?,?,?)', q.u.cid, q.u.id, q.body.shift_id); await audit(q.u, 'Shift change requested'); r.json({ ok: 1 }); });
  app.get('/api/shift-requests', any, async (q, r) => r.json(await all(`SELECT s.*,u.name,h.name shift_name FROM shift_requests s JOIN users u ON u.id=s.user_id JOIN shifts h ON h.id=s.shift_id WHERE s.company_id=? ${isM(q.u.role) ? '' : 'AND s.user_id=' + q.u.id} ORDER BY s.id DESC`, q.u.cid)));
  app.post('/api/shift-requests/:id/decision', mgr, async (q, r) => { const s = await get("SELECT * FROM shift_requests WHERE id=? AND company_id=? AND status='Pending'", q.params.id, q.u.cid); if (!s) return r.status(404).json({ error: 'Not found or decided' });
    const ok = !!q.body.approve; await run('UPDATE shift_requests SET status=?,decided_by=? WHERE id=?', ok ? 'Approved' : 'Rejected', q.u.name, s.id); if (ok) await assign(s.user_id, s.shift_id, q.u.cid);
    await audit(q.u, (ok ? 'Approved' : 'Rejected') + ' shift change #' + s.id); r.json({ ok: 1 }); });
  app.get('/api/holidays', any, async (q, r) => r.json(await all('SELECT * FROM holidays WHERE company_id=? ORDER BY date', q.u.cid)));
  app.post('/api/holidays', mgr, async (q, r) => { if (!/^\d{4}-\d\d-\d\d$/.test(q.body.date || '') || !q.body.name) return r.status(400).json({ error: 'date and name required' });
    await run('INSERT INTO holidays(company_id,date,name) VALUES(?,?,?)', q.u.cid, q.body.date, q.body.name); await audit(q.u, 'Holiday ' + q.body.name); r.json({ ok: 1 }); });
  app.delete('/api/holidays/:id', mgr, async (q, r) => { await run('DELETE FROM holidays WHERE id=? AND company_id=?', q.params.id, q.u.cid); r.json({ ok: 1 }); });
  app.get('/api/announcements', any, async (q, r) => r.json(await all('SELECT * FROM announcements WHERE company_id=? ORDER BY id DESC LIMIT 20', q.u.cid)));
  app.post('/api/announcements', mgr, async (q, r) => { if (!q.body.title) return r.status(400).json({ error: 'title required' });
    await run('INSERT INTO announcements(company_id,title,body,at) VALUES(?,?,?,?)', q.u.cid, q.body.title, q.body.body || '', new Date().toISOString()); await audit(q.u, 'Announcement posted'); r.json({ ok: 1 }); });
  // payroll preparation (amounts configured by admin; tax % is NOT a statutory calculation)
  app.get('/api/salary', adm, async (q, r) => r.json(await all('SELECT u.id user_id,u.name,s.basic,s.allowance,s.deduction,s.ot_rate,s.tax_pct FROM users u LEFT JOIN salary s ON s.user_id=u.id WHERE u.company_id=? AND u.active=1 ORDER BY u.name', q.u.cid)));
  app.put('/api/salary/:uid', adm, async (q, r) => { if (!(await get('SELECT 1 FROM users WHERE id=? AND company_id=?', q.params.uid, q.u.cid))) return r.status(404).json({ error: 'Not found' }); const b = q.body;
    await run('INSERT INTO salary(user_id,company_id,basic,allowance,deduction,ot_rate,tax_pct) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET basic=excluded.basic,allowance=excluded.allowance,deduction=excluded.deduction,ot_rate=excluded.ot_rate,tax_pct=excluded.tax_pct',
      q.params.uid, q.u.cid, num(b.basic, 0, 1e9, 0), num(b.allowance, 0, 1e9, 0), num(b.deduction, 0, 1e9, 0), num(b.ot_rate, 0, 1e7, 0), num(b.tax_pct, 0, 60, 0)); await audit(q.u, 'Salary updated for user #' + q.params.uid); r.json({ ok: 1 }); });
  app.post('/api/payroll/run', adm, async (q, r) => { const m = q.body.month; if (!/^\d{4}-\d\d$/.test(m || '')) return r.status(400).json({ error: 'month as YYYY-MM' }); const ot = (await settings(q.u.cid)).overtime_hours; let n = 0;
    for (const s of await all('SELECT s.*,u.name FROM salary s JOIN users u ON u.id=s.user_id WHERE s.company_id=? AND u.active=1', q.u.cid)) {
      const at = await all('SELECT in_at,out_at FROM attendance WHERE user_id=? AND date LIKE ?', s.user_id, m + '-%'); let oh = 0;
      at.forEach(a => { if (a.in_at && a.out_at) oh += Math.max(0, (new Date(a.out_at) - new Date(a.in_at)) / 36e5 - ot); });
      const r2 = x => Math.round(x * 100) / 100, otp = r2(oh * s.ot_rate), gross = r2(s.basic + s.allowance + otp), tax = r2(gross * s.tax_pct / 100), net = r2(gross - tax - s.deduction);
      const j = { month: m, name: s.name, days: at.length, basic: s.basic, allowance: s.allowance, ot_hours: r2(oh), ot_pay: otp, gross, tax_pct: s.tax_pct, tax, deduction: s.deduction, net };
      await run('INSERT INTO payslips(company_id,user_id,month,json,created) VALUES(?,?,?,?,?) ON CONFLICT(user_id,month) DO UPDATE SET json=excluded.json,created=excluded.created', q.u.cid, s.user_id, m, JSON.stringify(j), new Date().toISOString()); n++; }
    await audit(q.u, 'Payroll run ' + m + ' (' + n + ' payslips)'); r.json({ payslips: n }); });
  app.get('/api/payslips', any, async (q, r) => r.json((await all(`SELECT id,user_id,month,json FROM payslips WHERE company_id=? ${q.u.role === 'admin' ? '' : 'AND user_id=' + q.u.id} ORDER BY month DESC,id DESC`, q.u.cid)).map(p => ({ id: p.id, user_id: p.user_id, ...JSON.parse(p.json) }))));
  app.get('/api/payslips/:id/html', any, async (q, r) => { const p = await get('SELECT * FROM payslips WHERE id=? AND company_id=?', q.params.id, q.u.cid); if (!p || (p.user_id !== q.u.id && q.u.role !== 'admin')) return r.status(404).json({ error: 'Not found' });
    const j = JSON.parse(p.json), e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), row = (a, b) => `<tr><td>${a}</td><td style="text-align:right">${b}</td></tr>`;
    r.type('html').send(`<!DOCTYPE html><meta charset="utf-8"><title>Payslip ${e(j.month)}</title><body style="font-family:sans-serif;max-width:480px;margin:20px auto"><h2>Payslip · ${e(j.month)}</h2><p>${e(j.name)} · days worked ${j.days}</p><table width="100%" cellpadding="6" border="1" style="border-collapse:collapse">${row('Basic', j.basic)}${row('Allowances', j.allowance)}${row('Overtime (' + j.ot_hours + ' h)', j.ot_pay)}${row('<b>Gross</b>', '<b>' + j.gross + '</b>')}${row('Tax (' + j.tax_pct + '% configured)', '-' + j.tax)}${row('Deductions', '-' + j.deduction)}${row('<b>Net pay</b>', '<b>' + j.net + '</b>')}</table><p style="font-size:12px;color:#666">Tax and statutory amounts are configured manually and must be validated by a qualified local expert.</p>`); });
  app.get('/api/billing', mgr, async (q, r) => { const c = await co(q.u.cid); r.json({ plan: c.plan, valid_until: c.trial_ends, valid: valid(c), limit: LIM[c.plan], active: (await get('SELECT COUNT(*) n FROM users WHERE company_id=? AND active=1', q.u.cid)).n }); });
  app.post('/api/superadmin/plan', async (q, r) => { const k = process.env.SUPER_KEY; if (!k || q.headers['x-super-key'] !== k) return r.status(403).json({ error: 'Forbidden' }); const { company_id, plan, valid_until } = q.body;
    if (!LIM[plan] || !/^\d{4}-\d\d-\d\d$/.test(valid_until || '')) return r.status(400).json({ error: 'plan and valid_until required' }); await run('UPDATE companies SET plan=?,trial_ends=? WHERE id=?', plan, valid_until, company_id); r.json({ ok: 1 }); });
  app.locals.purge = async () => { for (const c of await all('SELECT id FROM companies')) { const cut = new Date(Date.now() - (await settings(c.id)).retention_days * 864e5).toISOString().slice(0, 10);
    await run('UPDATE attendance SET lat=NULL,lon=NULL WHERE company_id=? AND date<? AND (lat IS NOT NULL OR lon IS NOT NULL)', c.id, cut); } };
};
