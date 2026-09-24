import { openDb } from "../../db/client";
import { migrate } from "../../db/migrate";
import { EXIT, printJson, printLine, rejectUnknown, type Context } from "../util";

export async function dbMigrate(args: string[], ctx: Context): Promise<number> {
  rejectUnknown(args);
  const sql = openDb();
  try {
    const applied = await migrate(sql);
    if (ctx.json) printJson({ applied });
    else printLine(applied.length === 0 ? "Schema is up to date." : `Applied: ${applied.join(", ")}`);
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}
