# API v1

One request, one address, one verdict. The API answers from the newest published, signed snapshot, the same data you can download, so an answer can always be reproduced from that snapshot.

## Look up an address

```sh
curl -H "Authorization: Bearer ftk_..." {{apiUrl}}/v1/ip/203.0.113.7
```

`GET {{apiUrl}}/v1/ip/{ip}` takes an IPv4 address (dotted quad, no leading zeros) or an IPv6 address (no zone id). An IPv4-mapped IPv6 address is answered as the IPv4 address.

## Keys

Every request needs a key, sent in a header:

- `Authorization: Bearer ftk_<id>_<secret>`, or
- `X-API-Key: ftk_<id>_<secret>`.

A key in the query string is refused, so keys do not end up in proxy and browser logs. Call the API from your server rather than from a public web page. Sign in to create and revoke your keys; a key is shown once, when it is created.

## Free tier

| Limit | Per key |
|-------|---------|
| Lookups per day (UTC) | {{freeDaily}} |
| Burst | {{freeBurst}} per second |

Every answer to a valid key carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds of the next 00:00 UTC). Over a limit, the answer is `429` with `Retry-After`.

## Answer

```json
{
  "ip": "203.0.113.7",
  "risk": 64,
  "level": "high",
  "categories": ["hosting"],
  "reasons": [
    { "code": "ssh_bruteforce", "lastSeen": "2026-10-06T21:14:00Z", "contribution": 52 },
    { "code": "hosting", "lastSeen": "2026-10-07T00:00:00Z", "contribution": 12 }
  ],
  "network": { "asn": 64500, "org": "Example Hosting", "country": "NL" },
  "data": { "version": "f20261007", "delta": "d20261007T09", "builtAt": "2026-10-07T09:05:12Z", "stale": false },
  "disputeUrl": "https://foxtrust.dev/dispute"
}
```

| Field | Meaning |
|-------|---------|
| `risk` | 0–100 |
| `level` | `low`, `medium` or `high` |
| `categories` | network categories of the address |
| `reasons` | what the address was seen as or doing (`code`), when it was last seen (`lastSeen`), and how much it adds to the risk (`contribution`) |
| `network` | ASN, organisation and country, or `null` when unknown |
| `data` | the snapshot the answer comes from; `stale` is `true` when that data is older than 26 hours |
| `disputeUrl` | where the owner of a listed address can dispute it |

An address that is not listed gets risk 0, level `low` and no reasons. That is an answer, not an error.

## Errors

Errors have the body `{"error": {"code": "...", "message": "..."}}`.

| Status | Code | When |
|--------|------|------|
| 400 | `invalid_ip` | the path is not a single address |
| 400 | `key_in_query` | a key was sent in the query string |
| 401 | `key_missing` | no key header |
| 401 | `key_invalid` | the key is malformed, unknown or revoked, or its account is disabled |
| 429 | `quota_exceeded` | the daily quota is used up |
| 429 | `rate_limited` | the burst rate is exceeded |
| 503 | `no_data` | no snapshot is loaded yet; retry after `Retry-After` seconds |

Only lookups that get a verdict count against the quota.
