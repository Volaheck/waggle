import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export type Sql = postgres.Sql;
export type Queryable = postgres.Sql | postgres.TransactionSql;

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    onnotice: () => {},
    types: {
      bigintAsNumber: {
        to: 20,
        from: [20],
        serialize: (value: number | bigint) => value.toString(),
        parse: (value: string) => Number(value),
      },
    },
  });
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(sql: Sql, dir: string = migrationsDir): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((row) => row.name));
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(path.join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
