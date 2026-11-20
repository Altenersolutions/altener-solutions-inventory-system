# Deployment, migration, backup and rollback - Release 1.0.0

## Vercel (serverless Express)
1. Import the backend repository with the Express preset and repository root as the project root. Leave Build and Output settings at their defaults; use Node.js 24.x (the package supports Node.js 20 through 24).
2. Set `MONGO_URI`, a strong `JWT_SECRET`, `CORS_ORIGINS` to the frontend origin, `REQUIRE_TRANSACTIONS=true`, and `SERVE_LEGACY=false` in Production. Add `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` only when the database has no users and needs its first administrator. Keep secret values out of the repository.
3. Vercel uses `src/app.js` as the Express handler. Local and Render startup continue through `src/index.js`. Check `/api/health` after deployment; keep the existing Render service until login and inventory workflows are verified.

## Before you deploy
1. **Backup** (always): `mongodump --uri "$MONGO_URI" --gzip --archive=backup-$(date +%F).gz`. Keep it until the release is accepted.
2. Set environment: `NODE_ENV=production`, `JWT_SECRET` (random, 32+ chars, not the example), `SEED_ON_START=false`, `SERVE_LEGACY` as before.
   Optional: `HANDOVER_WITNESS_REQUIRED=true`.
3. Use a MongoDB **replica set / Atlas** so multi-document transactions are available (**required in production**: the server now refuses to start on a standalone MongoDB unless `REQUIRE_TRANSACTIONS=false`; Atlas free M0 supports transactions). Set `CORS_ORIGINS` to your Netlify URL..

## Deploy (backend and frontend together - the old frontend cannot receive material any more)
1. Deploy the backend. On first boot it migrates automatically (serial claims, `FINAL_QC` -> `FINAL_QC_FAILED`). No manual step.
2. Deploy the frontend (the service-worker cache name changed, so browsers pick it up). The sidebar must show `Version 1.0.0 - server 1.0.0`.
3. Permissions: roles saved in the database do not receive new permissions automatically. On the Roles screen grant **`vehicle.release`** (e.g. supervisor) and **`vehicle.dispatch`** (e.g. store). Admin has both.
4. Temporary data already in your database (TMP-xxxxx part numbers, temporary BOMs, invented DEMO- stock). Render's free plan has no shell, so run this **on your own computer**:
   `cd backend && npm install`, then set the same variables the app uses for one terminal session (`MONGO_URI` = your Atlas string, `JWT_SECRET` = any 32+ character text), and run:
   - `npm run cleanup:bom -- --demo-stock --temp-parts --demo-vehicles`  -> **dry run**: lists what would be removed and what is KEPT and why. Read it.
   - `npm run cleanup:bom -- --demo-stock --temp-parts --demo-vehicles --apply`  -> does it (after your backup from step 1).
   Anything that real work refers to (a real stock item, an installation, a kit, a vehicle in production) is kept and listed with the reason. Run it again later and it removes nothing more.
   Then upload and approve your original BOM (BOM > Import) and refresh the browser.
5. Smoke check: receive one item with an invoice PDF; open a vehicle; confirm "No approved BOM uploaded yet." appears until a BOM is approved.

## Backup / recovery
- Restore: `mongorestore --uri "$MONGO_URI" --gzip --archive=backup-YYYY-MM-DD.gz --drop` (restores the whole database - stop the app first).
- Uploaded invoices live in the database (`wmsfiles`), so they are included in the backup.

## Rollback
- The migration only adds data (serial claims) and relabels vehicles `FINAL_QC` -> `FINAL_QC_FAILED`. To go back: deploy the previous backend + frontend, then
  `db.vehicles.updateMany({status:"FINAL_QC_FAILED"},{$set:{status:"FINAL_QC"}})` and, if vehicles already moved to the new states (`REWORK`, `PENDING_RETEST`, `QC_APPROVED`, `DISPATCHED`),
  restore the backup instead - the old version does not know those states.
- Receipts made with an attachment keep working in the old version (extra field ignored). Temporary BOMs removed by cleanup come back only from the backup.

## Security checklist verified in code / tests
bcrypt password hashes (`select:false`), JWT secret required and checked at start (production: 32+ chars), role re-read from the database on every request, role checks on the server for every route above,
login rate limit, upload content checks (PDF/JPEG/PNG/WebP by file signature, 5 MB), `nosniff` on downloads, files readable only with a permission, demo seed refuses production.
Not verified here: behaviour on a real MongoDB replica set, TLS/CORS configuration of your host, penetration testing.
