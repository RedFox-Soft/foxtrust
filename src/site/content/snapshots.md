# Signed snapshots

The whole data set is published as MaxMind DB (MMDB) files: a full file every day and a delta every hour. Any standard MMDB reader can open them, and every record is the same verdict the API gives: risk, level, categories and reasons, without sources.

## Where

Files are published under `{{publicationUrl}}/v1/`:

| Path | What |
|------|------|
| `manifest.json` | the current full and delta versions, their sizes and SHA-256 hashes, and the dispute page |
| `keys.json` | the signing keys (for information only; see below) |
| `full/` | daily full files |
| `delta/` | hourly delta files |
| `archive/index.json` | one year of earlier releases |
| `reports/` | the report of each release |

Every file has a detached signature next to it: `<file>.sig`, the 64-byte raw Ed25519 signature of the exact file bytes.

## Check a signature

```sh
openssl pkeyutl -verify -rawin -pubin -inkey foxtrust.pub.pem -in f20261007.mmdb -sigfile f20261007.mmdb.sig
```

`foxtrust.pub.pem` is a trusted key below in PEM form. Check the manifest's signature first, then compare each file's SHA-256 and size with the manifest.

## Trusted keys

Pin these public keys (base64, raw 32-byte Ed25519) in your verifier, for example in `FOXTRUST_TRUSTED_KEYS` for `/verify`:

{{trustedKeys}}

A verifier trusts only the keys it pins, never the keys a publication lists, so a changed publication cannot bring its own key. When the key changes, the new key is listed here first; trust both, and remove the old one after the switch.

## Look an address up

```sh
mmdblookup --file f20261007.mmdb --ip 203.0.113.7
```

If an address you control is listed and the listing is wrong, [dispute it](/dispute).
