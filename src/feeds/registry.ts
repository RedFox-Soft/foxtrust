import { blocklistDe } from "./blocklist-de";
import { cymruFullbogons } from "./cymru-fullbogons";
import { feodoTracker } from "./feodo-tracker";
import { iptoasn } from "./iptoasn";
import { spamhausDrop } from "./spamhaus-drop";
import { torExit } from "./tor-exit";
import type { FeedDefinition } from "./types";
import { x4bnetDatacenter } from "./x4bnet-datacenter";

/** The seven stage 1 feeds (research R1). */
export const FEEDS: FeedDefinition[] = [
  iptoasn,
  x4bnetDatacenter,
  torExit,
  cymruFullbogons,
  spamhausDrop,
  feodoTracker,
  blocklistDe,
];

export function getFeed(id: string): FeedDefinition | undefined {
  return FEEDS.find((f) => f.id === id);
}
