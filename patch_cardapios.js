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
  const payloadCardapios = JSON.stringify([{ titulo: "Cardápio em preparação", receitas: [] }]);

  const sql =
    "UPDATE orders " +
    "SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('cardapios', $1::jsonb) " +
    "WHERE external_ref = $2";

  const r = await client.query(sql, [payloadCardapios, ext]);
  console.log("OK: cardapios definido | rows affected =", r.rowCount);

  await client.end();
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
