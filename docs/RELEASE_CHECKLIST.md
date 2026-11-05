# Release checklist (Phase 5 + 6) - tick every box before production approval

## A. Environment (Render + Atlas + Netlify)
- [ ] Atlas cluster is a replica set (M0 free is fine); `/api/ready` shows `"transactions": true`
- [ ] Render env: `NODE_ENV=production`, `JWT_SECRET` (32+ random), `MONGO_URI`, `CORS_ORIGINS=https://<site>.netlify.app`, `BOOTSTRAP_ADMIN_*` (first deploy only, then delete them), `SEED_ON_START=false`
- [ ] Netlify: publish the frontend folder as-is (`_headers` is picked up automatically). `config.js` `WMS_API` and the `connect-src` line in `_headers` both name the Render URL
- [ ] Staging: a second Render service + second Atlas database (`inventory_staging`) with the same blueprint; deploy here first
- [ ] Render plan is `starter` or higher for go-live (free plan sleeps)
- [ ] Monitoring: UptimeRobot (or similar) pings `https://<api>/api/health` every 5 min; Render email alerts on failed deploy; read logs for `"status":5xx`
- [ ] Backups: Atlas scheduled snapshots ON (M10+) or `scripts/backup.sh` run daily by cron/Actions; restore drill done (below)
- [ ] Rollback: previous Render deploy kept ("Rollback" button); last pre-release backup file stored; Netlify previous deploy can be "Published" again

## B0. One-command deployment check
- [ ] `node scripts/smoke.js https://<api> https://<site> <email> <password>` -> all PASS

## B. Automated tests (needs MongoDB on 127.0.0.1:27017)
- [ ] `npm test` all green on a REPLICA SET (single-node `--replSet rs0` is enough); the suite also runs on a standalone mongod but reservation-locking test H11 is skipped there (includes `test/hardening.test.js`: auth 401, lockout, first-admin race, idempotent issue, concurrent issue)

## C. Manual tests (record name/date)
- [ ] Auth: wrong password, locked account (423), session expiry -> redirected to login with message, log in on a second device then "sign out everywhere"
- [ ] Roles: log in as each role (store, store assistant, purchase executive, qc, assembly, engineer, supervisor, viewer); confirm menus and a forbidden action is refused
- [ ] Full workflow: receive with invoice PDF -> QC pass -> put-away -> reserve -> issue (FIFO) -> install on vehicle -> final QC -> release -> gate pass -> dispatch; ledger totals equal bin totals (Reports > stock reconciliation = 0 differences)
- [ ] FIFO: two lots of a FIFO part; issuing the newer one is blocked without an override
- [ ] FIFO concurrency: two phones issue the last units at the same moment - one succeeds, one gets INSUFFICIENT_STOCK
- [ ] Double-tap every submit button on a phone: only one record is created
- [ ] Browsers: Chrome, Edge, Safari (iPhone), Chrome (Android). Install as app. Camera scan on an iPhone (uses the bundled ZXing decoder) and on Android; hardware scanner too. The camera needs https
- [ ] Performance: `node scripts/loadtest.js https://<api> <email> <password> 20 20` prints RESULT: PASS (no errors, p95 < 1.5 s). Run it against STAGING with realistic data, not the sleeping free plan
- [ ] Backup restore: `scripts/backup.sh`, then `scripts/backup.sh --verify`; counts match production
- [ ] Offline: turn Wi-Fi off, press a button -> clear "offline" message, nothing half-saved

## D. Approval
- [ ] No open critical/high defects. Signed: ______________ (QC)  ______________ (Operations)  Date: ________
