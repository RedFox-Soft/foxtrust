# IP reputation that explains itself

FoxTrust tells you what an IP address is and what it has been seen doing, and why it thinks so.

## Two kinds of signal, kept apart

- **Network categories** say what kind of network an address belongs to: a hosting provider, a public cloud, a Tor exit relay, address space that should not appear on the internet. A category describes the network, not the people using it, so a category alone never makes an address high risk.
- **Observed behaviour** says what the address was seen doing, for example SSH brute-force attempts, spam or scanning. Behaviour fades: every day without a new sighting lowers its weight.

Every verdict has a risk from 0 to 100, a level (`low`, `medium` or `high`) and its reasons. Each reason says what the address was seen as or doing, when it was last seen, and how much it adds to the risk. Verdicts do not say who reported an observation.

Whether a request is allowed, challenged or blocked is your decision, written as a policy over the verdict. FoxTrust does not block anyone by itself.

## Ways to use it

- **API**: look up one address with a free key. See the [API documentation](/docs/api).
- **Signed snapshots**: download the whole data set as a MaxMind DB file, updated every hour, and look addresses up locally. See [snapshots](/docs/snapshots).
- **`/verify`**: a forward-auth service for reverse proxies that applies your policy to every request, with an optional challenge page instead of a captcha.

## Is your address listed?

If FoxTrust lists an address you control and the listing is wrong, [dispute it](/dispute). We answer within 5 working days.
