require("dotenv").config();
const { Client } = require("pg");

(async () => {
  const ssl =
    process.env.DATABASE_URL &&
    (process.env.DATABASE_URL.includes("render") || process.env.DATABASE_URL.includes("neon"))
      ? { rejectUnauthorized: false }
      : undefined;

  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl });
  await client.connect();

  const ext = "PED-20250920-22h30m-QKHU7U";
  const sql = "UPDATE orders SET status = $1, payment_id = COALESCE(payment_id, $2), merchant_order_id = COALESCE(merchant_order_id, $3), updated_at = NOW() WHERE external_ref = $4";
  const r = await client.query(sql, ["pago", "PAY-MOCK-123", "MOCK-ORDER-123", ext]);

  console.log("OK: status=pago + ids preenchidos | rows affected =", r.rowCount);
  await client.end();
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
