import { formatCidr, parseCidr, rangeToCidrs } from "../ip/cidr";
import { parseIpv4, parseIpv6, type IpValue } from "../ip/parse";
import { decodeText, type FeedDefinition, type NetworkEntry } from "./types";

const parseAddress = (text: string): IpValue | null => {
  if (text.includes(":")) {
    const value = parseIpv6(text);
    return value === null ? null : { family: 6, value };
  }
  const value = parseIpv4(text);
  return value === null ? null : { family: 4, value };
};

/** iptoasn.com: `range_start range_end AS_number country_code AS_description` (TSV). */
export const iptoasn: FeedDefinition = {
  id: "iptoasn",
  kind: "network",
  codes: [],
  schedule: "0 */6 * * *",
  timestamps: "run",
  files: [{ name: "ip2asn-combined.tsv.gz", url: "https://iptoasn.com/data/ip2asn-combined.tsv.gz" }],
  limits: { maxCompressedBytes: 100 * 1024 * 1024 },
  parse(files) {
    const entries: NetworkEntry[] = [];
    let invalidLines = 0;
    for (const line of decodeText(files[0]!.body).split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const [startText, endText, asnText, countryText, ...rest] = line.split("\t");
      const start = startText ? parseAddress(startText) : null;
      const end = endText ? parseAddress(endText) : null;
      const asnNumber = Number(asnText);
      if (!start || !end || start.family !== end.family || start.value > end.value || !Number.isInteger(asnNumber)) {
        invalidLines++;
        continue;
      }
      const routed = asnNumber > 0;
      const description = rest.join("\t").trim();
      const country = countryText && /^[A-Za-z]{2}$/.test(countryText) ? countryText.toUpperCase() : null;
      for (const cidr of rangeToCidrs(start, end)) {
        // Re-parse to turn IPv4-mapped IPv6 blocks into IPv4 prefixes.
        const normalised = parseCidr(formatCidr(cidr))!;
        entries.push({
          prefix: formatCidr(normalised),
          asn: routed ? asnNumber : null,
          org: routed && description !== "" ? description : null,
          country,
        });
      }
    }
    return { entries, invalidLines };
  },
};
