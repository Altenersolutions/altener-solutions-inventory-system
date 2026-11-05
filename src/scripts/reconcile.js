// npm run reconcile   - prints the stock accuracy check (balances vs transactions) and exits 1 when something is off.
const db = require("../db"); const config = require("../config"); const { stockReconciliation } = require("../domain/reconcile");
(async () => { await db.connect(config.mongoUri); const r = await stockReconciliation(); console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })().catch((e) => { console.error(e); process.exit(2); });
