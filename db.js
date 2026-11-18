// PostgreSQL layer (works with Supabase). Placeholders use ? and are converted to $1,$2...
const { Pool, types } = require('pg'); const bcrypt = require('bcryptjs');
types.setTypeParser(20, v => parseInt(v, 10)); // COUNT(*) as number
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required (your Supabase/Postgres connection string)'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }, max: 10, keepAlive: true, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
pool.on('error', e => console.error('pg pool error', e.message));
const conv = s => { let i = 0; return s.replace(/\?/g, () => '$' + (++i)); };
const mk = c => ({ all: async (s, ...p) => (await c.query(conv(s), p)).rows, get: async (s, ...p) => (await c.query(conv(s), p)).rows[0],
  run: async (s, ...p) => (await c.query(conv(s), p)).rowCount, ins: async (s, ...p) => (await c.query(conv(s) + ' RETURNING id', p)).rows[0].id });
const base = mk(pool);
async function tx(fn) { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(mk(c)); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } }
async function init() { await pool.query(`
CREATE TABLE IF NOT EXISTS companies(id SERIAL PRIMARY KEY, name TEXT NOT NULL, grace INTEGER DEFAULT 10, created TEXT, plan TEXT DEFAULT 'trial', trial_ends TEXT);
CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee', dept TEXT DEFAULT 'General', title TEXT DEFAULT 'Staff', active INTEGER DEFAULT 1, policy TEXT DEFAULT 'office', shift_start TEXT DEFAULT '09:00',
  annual INTEGER DEFAULT 14, sick INTEGER DEFAULT 8, shift_id INTEGER);
CREATE TABLE IF NOT EXISTS attendance(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, user_id INTEGER NOT NULL, date TEXT, in_at TEXT, out_at TEXT, late INTEGER DEFAULT 0,
  lat DOUBLE PRECISION, lon DOUBLE PRECISION, device TEXT, corrected INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS leave(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, user_id INTEGER NOT NULL, type TEXT, from_d TEXT, to_d TEXT, days INTEGER, reason TEXT, status TEXT DEFAULT 'Pending', decided_by TEXT);
CREATE TABLE IF NOT EXISTS corrections(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, user_id INTEGER NOT NULL, date TEXT, in_t TEXT, out_t TEXT, reason TEXT, status TEXT DEFAULT 'Pending', decided_by TEXT);
CREATE TABLE IF NOT EXISTS audit(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, at TEXT, actor TEXT, action TEXT);
CREATE TABLE IF NOT EXISTS shifts(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, name TEXT, start TEXT, "end" TEXT);
CREATE TABLE IF NOT EXISTS shift_requests(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, user_id INTEGER NOT NULL, shift_id INTEGER, status TEXT DEFAULT 'Pending', decided_by TEXT);
CREATE TABLE IF NOT EXISTS holidays(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, date TEXT, name TEXT);
CREATE TABLE IF NOT EXISTS announcements(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, title TEXT, body TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS settings(company_id INTEGER PRIMARY KEY, json TEXT);
CREATE TABLE IF NOT EXISTS salary(user_id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, basic DOUBLE PRECISION DEFAULT 0, allowance DOUBLE PRECISION DEFAULT 0, deduction DOUBLE PRECISION DEFAULT 0, ot_rate DOUBLE PRECISION DEFAULT 0, tax_pct DOUBLE PRECISION DEFAULT 0);
CREATE TABLE IF NOT EXISTS payslips(id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, user_id INTEGER NOT NULL, month TEXT, json TEXT, created TEXT, UNIQUE(user_id, month));
CREATE INDEX IF NOT EXISTS ix_att ON attendance(company_id, date);
CREATE INDEX IF NOT EXISTS ix_users_co ON users(company_id);
CREATE INDEX IF NOT EXISTS ix_att_user ON attendance(user_id, date);
CREATE INDEX IF NOT EXISTS ix_leave_co ON leave(company_id, status);
CREATE INDEX IF NOT EXISTS ix_corr_co ON corrections(company_id, status);
CREATE INDEX IF NOT EXISTS ix_audit_co ON audit(company_id, id);
`);
  // Supabase exposes the public schema over its REST API. Lock every table (RLS on, no policies) so only this server (direct Postgres login) can read/write.
  for (const t of ['companies', 'users', 'attendance', 'leave', 'corrections', 'audit', 'shifts', 'shift_requests', 'holidays', 'announcements', 'settings', 'salary', 'payslips'])
    await pool.query('ALTER TABLE ' + t + ' ENABLE ROW LEVEL SECURITY'); }
async function newCompany(name) {
  const cid = await base.ins('INSERT INTO companies(name,created,plan,trial_ends) VALUES(?,?,?,?)', name, new Date().toISOString(), 'trial', new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10));
  await base.run('INSERT INTO shifts(company_id,name,start,"end") VALUES(?,?,?,?)', cid, 'Day', '09:00', '17:00'); return cid;
}
async function seed() {
  if ((await base.get('SELECT COUNT(*) c FROM users')).c) return; const e = process.env;
  if (!e.ADMIN_EMAIL || !e.ADMIN_PASSWORD) return console.log('No ADMIN_EMAIL/ADMIN_PASSWORD set; skipping seed');
  const cid = await newCompany(e.COMPANY_NAME || 'My Company');
  await base.run("INSERT INTO users(company_id,name,email,hash,role,dept,title) VALUES(?,?,?,?,'admin','Management','Administrator')", cid, e.ADMIN_NAME || 'Admin', e.ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(e.ADMIN_PASSWORD, 12));
  console.log('Seeded admin account:', e.ADMIN_EMAIL);
}
module.exports = { ...base, tx, init, seed, newCompany };
