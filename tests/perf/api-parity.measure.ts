import { Reader } from "mmdb-lib";
import { bearer } from "../helpers/api";
import { withStage2Api } from "./api.bench";
import { dataLabel } from "./stage2-data";
import type { Measurement } from "./util";

const SAMPLE = 1000;

type Record_ = {
  risk: number; level: string; categories: string[];
  reasons: { code: string; last_seen: number; contribution: number }[];
  network: { asn?: number; org?: string; country?: string };
};

/**
 * Spec 010 SC-003: for 1,000 addresses (listed and unlisted, both families), the API answer equals
 * the record a standard MMDB reader finds in the same snapshot file.
 */
export async function measureApiParity(): Promise<Measurement[]> {
  return withStage2Api(SAMPLE, async ({ api, key, addresses, snapshotPath }) => {
    const reader = new Reader(Buffer.from(await Bun.file(snapshotPath).bytes()));
    let equal = 0;
    const mismatches: string[] = [];
    for (const address of addresses) {
      const body = (await (await api.get(`/v1/ip/${address}`, bearer(key))).json()) as Record<string, unknown>;
      const record = reader.get(address) as unknown as Record_ | null;
      const expected = {
        risk: record?.risk ?? 0,
        level: record?.level ?? "low",
        categories: record?.categories ?? [],
        reasons: (record?.reasons ?? []).map((r) => ({ code: r.code, lastSeen: new Date(r.last_seen * 1000).toISOString(), contribution: r.contribution })),
        network: { asn: record?.network.asn ?? null, org: record?.network.org ?? null, country: record?.network.country ?? null },
      };
      const actual = { risk: body.risk, level: body.level, categories: body.categories, reasons: body.reasons, network: body.network };
      if (JSON.stringify(actual) === JSON.stringify(expected)) equal++;
      else if (mismatches.length < 3) mismatches.push(address);
    }
    return [{
      criterion: `010 SC-003 API equals the snapshot record (${dataLabel()})`,
      target: "100 %",
      measured: `${equal}/${addresses.length}${mismatches.length ? `; first mismatches ${mismatches.join(", ")}` : ""}`,
      pass: equal === addresses.length,
    }];
  });
}
