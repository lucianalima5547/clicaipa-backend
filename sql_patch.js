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

  // 1) Garante a tabela básica (caso não exista)
  const sqlCreate =
    "CREATE TABLE IF NOT EXISTS secure_links (" +
    " token TEXT PRIMARY KEY," +
    " external_ref TEXT NOT NULL," +
    " expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 HOURS'," +
    " used_at TIMESTAMPTZ NULL," +
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()" +
    ");";
  await client.query(sqlCreate);

  // 2) Garante colunas que possam faltar
  await client.query("ALTER TABLE secure_links ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();");
  await client.query("ALTER TABLE secure_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 HOURS';");
  await client.query("ALTER TABLE secure_links ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL;");

  // 3) Índice para reuso/expiração
  const sqlIndex = [
    "DO $$",
    "BEGIN",
    "  IF NOT EXISTS (",
    "    SELECT 1 FROM pg_indexes",
    "    WHERE schemaname = 'public' AND indexname = 'idx_secure_links_extref'",
    "  ) THEN",
    "    CREATE INDEX idx_secure_links_extref ON secure_links (external_ref, expires_at DESC, created_at DESC);",
    "  END IF;",
    "END $$;"
  ].join("\n");
  await client.query(sqlIndex);

  console.log("Patch OK");
  await client.end();
})().catch(e => { console.error("Patch FAIL:", e.message); process.exit(1); });
