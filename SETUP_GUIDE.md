# Setup guide (Supabase database + any Node host)

## 1. Supabase (database)
1. supabase.com > New project. Choose a simple database password (letters+numbers). Wait until it is ready.
2. Click "Connect" > copy the connection string. Prefer the *Session pooler* string (works over IPv4). Replace [YOUR-PASSWORD] with your password
   (special characters must be URL-encoded, e.g. @ becomes %40).
3. That string is your DATABASE_URL. Never share it or commit it to GitHub.
Tables are created automatically the first time the server starts. Free projects pause after 7 days of inactivity; Pro ($25/mo) removes that and adds backups.

## 2. Run locally (test)
Install Node 20. Edit `.env` (DATABASE_URL, admin email/password). Then: `npm install` and `npm start`. Open http://localhost:3000.

## 3. Put the server online (any one)
- Render: push the folder to a private GitHub repo WITHOUT `.env`, then Render > New > Blueprint. Enter DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD when asked.
  Free plan works because data is in Supabase, but it sleeps after idle so the first request is slow.
- Railway / Fly.io / VPS with Docker: set the same environment variables from `.env.example`.
Use the https:// address in the Android app.

## 4. Before real customers
- Change the admin password (Settings > Change my password).
- Supabase Pro for backups and no pause; keep JWT_SECRET and SUPER_KEY secret.
- Own Android signing key; privacy policy covering location use and retention (Settings).
- Payroll tax/deduction figures are entered manually; have a qualified local expert validate before offering payroll as compliant.

## 5. Billing (manual)
New companies get a 14-day trial (10 employees). Activate a plan:
curl -X POST https://YOUR-URL/api/superadmin/plan -H "x-super-key: YOUR_SUPER_KEY" -H "Content-Type: application/json" -d '{"company_id":1,"plan":"growth","valid_until":"2027-01-31"}'
Plans: starter 10, growth 50, business 200, enterprise unlimited employees. Expired companies become read-only.

## 6. Not included
Push notifications (needs Firebase + native Android code), online payment gateway keys, password-reset email, SSO.

## 7. Speed tips (important)
- Render FREE services sleep after 15 minutes idle; the first request then takes 30-60 seconds. Fix: use a paid instance, or add a free uptime monitor (UptimeRobot) that opens https://YOUR-URL/health every 5 minutes.
- Put Supabase and the server in the SAME region, and choose a region close to your staff (for Pakistan, Singapore or Frankfurt are usually closest). Cross-region database calls are the next biggest cause of slowness.
- Use the Supabase Session/Transaction pooler string in DATABASE_URL.
