# Release 1.0.0 (Version 1)

## Project hardening updates
- Replaced vulnerable transitive dependencies; `npm audit` now reports zero vulnerabilities.
- Added Node 20–24 engine guidance and Docker-based MongoDB replica-set scripts.
- Added unit/integration test commands.
- Added Redis-backed shared API/login rate limiting when `REDIS_URL` is configured.
- Added pagination and total-count headers to legacy list endpoints.
- Improved legacy mass-assignment filtering and backup verification with automatic collection-count checks.

Version numbers: package.json (`1.0.0`) is the single source; the API reports it at `GET /api/version`, the frontend shows it in the sidebar
(`config.js` -> `WMS_VERSION`) and warns if the MAJOR numbers differ. Nothing bumps it automatically. Database migrations are independent of it.

## Temporary BOM data removed
- The seed no longer creates BOMs, BOM revisions or vehicles, and refuses to run in production. `SEED_ON_START` is ignored in production and is `false` in render.yaml.
- Deleted: `src/data/bom.json`, `src/scripts/loadPresentation.js`, `PRESENTATION_DATA_NOTES.md`. New `npm run load:assets` loads only the capital assets register.
- `npm run cleanup:bom` (dry run by default; `-- --apply`) removes temporary BOM revisions only when nothing refers to them, and audits it. Options: `--temp-parts` (TMP-xxxxx / provisional part numbers nothing real uses), `--demo-stock` (invented DEMO- receipts, stock, QC and NCRs), `--demo-vehicles`. Referenced items are kept and listed with the reason.
- No approved BOM -> "No approved BOM uploaded yet."; installation and kitting are blocked (`BOM_NOT_APPROVED`, not overridable). A DRAFT revision never drives production.
  BOM import, management and approval are unchanged. New `GET /api/bom-status`.

## Critical fixes (all enforced on the server)
- Final QC: FAIL -> `FINAL_QC_FAILED` -> rework (`POST /vehicles/:id/rework`) -> `REWORK` -> `rework-complete` -> `PENDING_RETEST` -> retest/final PASS -> `QC_APPROVED`
  -> `release` (permission `vehicle.release`) -> `RELEASED` -> `dispatch` (permission `vehicle.dispatch`) -> `DISPATCHED`. Final QC is refused on a vehicle that is not assembled.
  Removing parts during rework needs no override; on an approved/released vehicle it needs one and withdraws the approval.
- Dispatch: a gate pass naming a vehicle (`vehicleNumber`, or a vehicle number in serial/part/name) is refused unless that vehicle is QC-approved and released.
- Invoice: receiving requires `invoiceFileId` - a real PDF/JPEG/PNG uploaded with `POST /api/files` (`purpose: "INVOICE"`), one document per receipt. File bytes are checked, not just the declared type.
- Concurrency: QC, disposition, serial installation, vehicle state changes and handover answers claim the record version first (unique `WmsTransitionClaim`); duplicate serials are blocked by a unique `WmsSerialClaim`.
- Blocked components: pending-QC, Hold and Rejected material cannot be installed, issued or handed over (an override cannot bypass this).
- Handover: statuses PENDING / ACKNOWLEDGED / REFUSED / RETURNED; several items per handover (`lines`, group acknowledge/refuse); returns (partial or full) go back to Receiving.
  Someone other than the recipient needs the override right + written reason (recorded in the override register and audit trail); `HANDOVER_WITNESS_REQUIRED=true` also demands a witness.

## Data migration (runs at boot, idempotent, never deletes)
- Serial claims for every existing serial; legacy vehicle status `FINAL_QC` -> `FINAL_QC_FAILED`.

## Tests
- New: `v1.regression`, `v1.bom`, `v1.cleanup`. Stale tests corrected (password hash is `select:false`; legacy `/bom` needs an engineering permission; gate pass layout; vehicle QC flow).
- `test/helpers/setup.js` (test-only) wraps seed() with BOM/vehicle fixtures and attaches a PDF to receiving calls. Nothing in `src/` uses it.

## 1.0.1 - hardening release
- Auth: invalid/expired/revoked tokens now return 401 (permission denied stays 403); frontend signs out on 401 only.
- Atomic first-admin creation (unique claim row) - no duplicate admins under parallel requests.
- Production refuses to start without MongoDB transactions (REQUIRE_TRANSACTIONS); CORS warning when CORS_ORIGINS empty.
- Account lockout after 5 wrong passwords (423), passwords need a letter + digit, admin password/role/disable revokes sessions.
- Idempotency-Key supported on put-away, issue, issue-fifo, return, transfer, adjust, handover, install, remove, gate pass.
- JSON request log with X-Request-Id, /api/ready probe, graceful SIGTERM shutdown, crash handlers, extra indexes.
- Tests: test/hardening.test.js (needs a local MongoDB).
- Reservations: issue, handover and kit creation now re-check reserved stock inside the transaction under a per-item lock (uow `ctx.lock`), so concurrent requests cannot take stock reserved for a kit or double-reserve it. Test H11 fails without the lock (verified).
- Install-onto-vehicle now re-checks reservations under the same lock (issue, handover, kit, install all covered).
- Frontend 1.0.2: camera scanning works on iPhone Safari/Firefox (bundled ZXing decoder, verified on this app's Code 128 labels); frontend static tests (`node --test tests/static.test.js`).
- Ops: scripts/smoke.js (post-deploy check), scripts/loadtest.js, GitHub Actions CI (replica set) and nightly backup, render.staging.yaml, docs/GO_LIVE.md.
