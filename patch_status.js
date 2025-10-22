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
  const sql = "UPDATE orders SET status = $1, updated_at = NOW() WHERE external_ref = $2";
  const r = await client.query(sql, ["pago", ext]);

  console.log("OK: status=pago | rows affected =", r.rowCount);
  await client.end();
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
