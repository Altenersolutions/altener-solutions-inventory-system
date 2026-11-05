# Go-live guide (follow in order)

You need: a MongoDB Atlas account, a Render account, a Netlify account, a GitHub repo for each of backend and frontend.

## 1. Database (Atlas)
1. Create a cluster (M0 free works; it is a replica set, so transactions work). Create **two databases** by using two connection strings: `inventory_staging` and `inventory_prod`.
2. Database user with read/write; Network Access: allow `0.0.0.0/0` (Render IPs change).
3. Copy the connection strings (`mongodb+srv://...`) and add the database name before the `?`.

## 2. Backend (Render) - do STAGING first
1. Push the backend zip contents to GitHub. Render > New > Blueprint > pick `render.staging.yaml` (production later: `render.yaml`).
2. Set the secret variables Render asks for:
   - `MONGO_URI` - staging connection string
   - `JWT_SECRET` - 32+ random characters (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   - `CORS_ORIGINS` - your Netlify URL, exactly, no trailing slash (e.g. `https://my-wms.netlify.app`)
   - `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (letter + digit, 8+ chars) - first deploy only; delete both after the admin exists
3. Open `https://<api>/api/ready` - must show `"db":"connected"` and `"transactions":true`.

## 3. Frontend (Netlify)
1. Edit `config.js` -> your Render URL. Edit `_headers` -> the same URL in `connect-src`. (The frontend test `node --test tests/static.test.js` fails if these two disagree.)
2. Push to GitHub, Netlify > New site from Git (publish directory = the repo root, no build command). Drag-and-drop of the folder also works.

## 4. Verify (one command)
```
node scripts/smoke.js https://<api> https://<site>.netlify.app admin@yourcompany.com 'AdminPassword1'
```
Every line must say PASS. Then: `node scripts/loadtest.js https://<api> <email> <password> 20 20` (RESULT: PASS).

## 5. Manual acceptance
Work through `docs/RELEASE_CHECKLIST.md` section C on staging (phones, roles, full workflow, double-tap, offline).

## 6. Production
Repeat steps 1-4 with `render.yaml` + the production database + a paid Render plan (free plan sleeps). Create the GitHub secret `MONGO_URI` so `.github/workflows/backup.yml` takes a nightly backup; do one restore drill (`scripts/backup.sh --verify`). Add an uptime monitor on `/api/health`.

## 7. Rollback
Render: Deploys > previous deploy > Rollback. Netlify: Deploys > previous deploy > Publish deploy. Data: restore the last backup into a NEW database, point `MONGO_URI` at it.
