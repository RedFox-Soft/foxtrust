# Disputing a FoxTrust listing

FoxTrust publishes IP reputation verdicts in signed snapshot files that are read by the sites
and services using them. This page explains what a listing means, how to find out why an address is
listed, and how to have a wrong listing removed. Every snapshot and its manifest link to this page.

## What a listing means

A listing is a statement about an address, not about a person. It says one of two things:

- **Network category**: the address belongs to a kind of network, for example a hosting provider,
  a Tor exit relay or space that should not appear on the internet (`bogon`). Categories describe
  the network, not its users.
- **Observed behaviour**: the address was seen doing something, for example SSH brute-force
  attempts. Behaviour fades over time: every day without a new sighting lowers its weight.

Each verdict has a risk from 0 to 100 and a level (`low`, `medium` or `high`). Whether a request
is allowed, challenged or blocked is decided by the site using FoxTrust, not by FoxTrust.

## Why is my address listed?

Look the address up in the current snapshot with any MaxMind DB reader, for example:

```sh
mmdblookup --file f20261001.mmdb --ip 203.0.113.7
```

The record lists `reasons`. Each reason has:

| Field | Meaning |
|-------|---------|
| `code` | what the address was seen as or doing, for example `hosting`, `tor_exit`, `ssh_bruteforce`, `botnet_c2` |
| `last_seen` | when it was last seen (Unix time, UTC) |
| `contribution` | how much this reason adds to the risk |

The snapshot does not say who reported an observation. FoxTrust keeps that record internally and
checks it when you ask.

## How to dispute a listing

Email **disputes@foxtrust.dev** with:

1. the address or prefix;
2. the snapshot version you looked at (for example `f20261001`) and the `code` you dispute;
3. why the listing is wrong, for example "this address was reassigned to us on 2026-09-01" or
   "this is a residential line, not hosting".

You do not need to prove who you are to ask why an address is listed. To have it excluded, we may
ask you to show that you control the address, for example with its reverse DNS or a WHOIS contact.

**Response time**: we answer within 5 working days.

## What happens next

- **The dispute is accepted**: we correct the data so that the address is no longer listed for
  the disputed reason, and the next release reflects it. Updates are published every hour, so
  this is usually within one hour of the correction. We tell you the version of that release.
  Disputes are handled by hand for now; a self-service delisting process is planned.
- **The listing is correct**: we tell you which reasons still apply and when each was last seen.
  Behaviour reasons fade on their own once the activity stops.

Snapshots that were already published stay in the one-year archive unchanged, because they record
what was published at the time. The archive index shows when each file was replaced.
