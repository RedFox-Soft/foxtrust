import type { SQL } from "bun";

/** The admin audit trail (spec 011 research R5): who changed what, never a secret, cookie or token. */

export type AuditAction =
  | "account.create" | "account.disable" | "key.issue" | "key.limits" | "key.revoke"
  | "release.request" | "run.confirm.request" | "session.signin" | "session.denied";

export type AuditRecord = { at: Date; subject: string; name: string; action: AuditAction; item: string | null; note: string | null; details: Record<string, unknown> };

const FORBIDDEN = /^(key|secret|token|cookie|id_?token|access_?token|password)$/i;

function checkDetails(value: unknown, path = "details"): void {
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN.test(k)) throw new Error(`${path}.${k}: audit details must not hold secrets`);
    checkDetails(v, `${path}.${k}`);
  }
}

export async function audit(
  sql: SQL,
  entry: { subject: string; name: string; action: AuditAction; item?: string | null; note?: string | null; details?: Record<string, unknown> },
  at: Date = new Date(),
): Promise<void> {
  checkDetails(entry.details ?? {});
  await sql`
    INSERT INTO admin_audit (at, subject, name, action, item, note, details)
    VALUES (${at}, ${entry.subject}, ${entry.name.slice(0, 200)}, ${entry.action}, ${entry.item ?? null}, ${entry.note ?? null},
            ${JSON.stringify(entry.details ?? {})}::jsonb)`;
}

export async function latestAudit(sql: SQL, limit = 100): Promise<AuditRecord[]> {
  const rows = (await sql`
    SELECT at, subject, name, action, item, note, details FROM admin_audit ORDER BY at DESC, id DESC LIMIT ${limit}`) as {
    at: Date; subject: string; name: string; action: AuditAction; item: string | null; note: string | null; details: unknown;
  }[];
  return rows.map((r) => ({
    ...r, details: (typeof r.details === "string" ? JSON.parse(r.details) : r.details) as Record<string, unknown>,
  }));
}
