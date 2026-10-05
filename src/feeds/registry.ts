import { join } from "node:path";
import { blocklistDe } from "./blocklist-de";
import { cymruFullbogons } from "./cymru-fullbogons";
import { feodoTracker } from "./feodo-tracker";
import { ianaAddressSpace } from "./iana-address-space";
import { iptoasn } from "./iptoasn";
import { cloudFeed } from "./ipverse-cloud";
import { spamhausDrop } from "./spamhaus-drop";
import { torExit } from "./tor-exit";
import type { FeedDefinition } from "./types";
import { x4bnetDatacenter } from "./x4bnet-datacenter";

/** The reviewed public-cloud ASN list (spec 005); a missing file gives a feed whose runs fail. */
export const CLOUD_ASN_LIST = join(import.meta.dir, "..", "..", "config", "cloud", "asns.csv");
const cloudList = await Bun.file(CLOUD_ASN_LIST).text().catch(() => null);

/**
 * The seven stage 1 feeds (research R1), the stage 2 IANA allocation feed (002 research R6) and
 * the public-cloud feed (spec 005).
 */
export const FEEDS: FeedDefinition[] = [
  iptoasn,
  x4bnetDatacenter,
  torExit,
  cymruFullbogons,
  spamhausDrop,
  feodoTracker,
  blocklistDe,
  ianaAddressSpace,
  cloudFeed(cloudList),
];

export function getFeed(id: string): FeedDefinition | undefined {
  return FEEDS.find((f) => f.id === id);
}
