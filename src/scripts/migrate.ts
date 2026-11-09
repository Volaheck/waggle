import { createSql, migrate } from "../core/db.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
const sql = createSql(databaseUrl);
const applied = await migrate(sql);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "All migrations are already applied");
await sql.end();
