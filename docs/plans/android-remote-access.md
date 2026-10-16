# ASB phone access away from home: ZeroTier and Tailscale

Status: approved request, 2026-10-15. Builds on `docs/plans/android-companion.md`.
Do not write machine values into code, tests, docs, or commits: no real LAN,
ZeroTier, or Tailscale addresses, network IDs, node IDs, interface names from
this PC, or device serials. Use sample values such as `192.168.50.4`,
`10.147.17.4`, `100.101.102.103`, `enp0s1`, `ztabcdef12`, `tailscale0`.

## 1. Goal

The phone reaches ASB at home (LAN) and away from home (ZeroTier or Tailscale),
with one pairing, the same pinned certificate, and the same token. The app
picks a working path by itself and shows it.

## 2. Address kinds (PC)

`listAddresses()` returns `{ address, interface, kind }` for each usable IPv4
address, sorted by kind (lan, zerotier, tailscale), then interface name:

| Kind | Rule |
| --- | --- |
| `tailscale` | Interface name starts with `tailscale` and the address is in `100.64.0.0/10`. |
| `zerotier` | Interface name starts with `zt` and the address is RFC 1918 private. |
| `lan` | Any other interface with an RFC 1918 private address. |

A `100.64.0.0/10` address on any interface that is not Tailscale is never
listed (carrier NAT and mobile hotspots use this range; binding there exposes
the gateway to the carrier network). Loopback and public addresses are never
listed.

## 3. Gateway (PC, worker C)

- Settings schema 2 in `phone.json`: `bindAddresses` (array of 0..8 address
  strings, no duplicates) replaces `bindAddress`. Schema 1 files load and are
  converted (`bindAddress` "" gives `[]`), then saved as schema 2 at the next
  save. Keep `port`, `enabled`, `devices`.
- The gateway listens on every selected address that `listAddresses()` lists
  now, all on the same port, with one shared TLS context and one handler. A
  selected address that is missing now is skipped and reported in `status()`
  (`error` text names it); the others still listen. `running` is true when at
  least one listener listens.
- Caller check per listener: a `lan` or `zerotier` listener accepts RFC 1918
  and loopback callers (as now). A `tailscale` listener accepts
  `100.64.0.0/10` callers and RFC 1918 callers. No listener accepts public
  callers.
- `status()` lists `addresses` with `kind`, and `bindAddresses`.
- `GET /phone/v1/hello` adds `addresses: [{ "kind", "address" }]` for the
  listeners that listen now, and `port`. The app updates its saved list from
  this, so phones paired with a version 1 link get the overlay addresses with
  no new pairing.
- Pairing link version 2: `asb://pair?v=2&a=<list>&p=<port>&f=<fp>&c=<code>&n=<name>`
  where `<list>` is a comma-separated list of `kind:address` (URL-encoded as a
  whole), in the order of section 2. The app must still accept version 1 links
  (`h=<one address>`, kind `lan`).
- The allowlist does not change. `/api/sources`, `/api/phone*`, and
  `/api/palette` are never reachable from the gateway (add a test for each).
- Loopback route `POST /api/phone/settings` body becomes exactly
  `{"enabled", "bindAddresses", "port"}`; each address must be listed now.
- Preferences > Phone: replace the address combo with one check row per listed
  address: "Home network" (lan), "ZeroTier", or "Tailscale", the address, and
  for the overlay kinds the hint "Works away from home". Show a note when no
  ZeroTier or Tailscale address is listed: "Install and join ZeroTier or
  Tailscale on this PC and the phone to use ASB away from home." Status shows
  each listening address.
- Tests (Node): kind classification (LAN, ZeroTier, Tailscale, a 100.x address
  on a normal interface, loopback, public), schema 1 migration, multi-listener
  start with one missing address, caller rules per kind, hello `addresses`, v2
  link content, 404 for `/api/palette` and `/api/phone/settings` through the
  gateway. Python logic test for the new Phone page helpers.
- Docs: `AGENTS.md` rule becomes "bound only to selected private LAN or overlay
  (ZeroTier, Tailscale) addresses"; update `SYSTEM_OVERVIEW.md`,
  `docs/PRIVACY.md`, `ASB.md`, `README.md`, `CHANGELOG.md` Unreleased.

## 4. App (Android, worker D, after the themes and cards work)

- `Pairing.kt`: parse v1 and v2 links into `PairingInfo(addresses:
  List<Endpoint(kind, host)>, port, fingerprint, code, serverName)`. v2 kinds
  are `lan`, `zerotier`, `tailscale`; unknown kinds are dropped; at least one
  valid IPv4 address is required.
- `Store`: save the endpoint list; migrate the saved single `host` to one `lan`
  endpoint.
- Address choice in `AsbApi`:
  - Keep a current endpoint (the last one that answered). Start with it.
  - A GET (dashboard, hello) that fails with a network error tries the next
    endpoints in order (lan, zerotier, tailscale) with a short connect timeout
    (3 s each); the first that answers becomes current.
  - A POST (actions, settings, pair) goes only to the current endpoint and is
    never retried on another address, so an action cannot run twice. On a
    network error it reports Offline; the next GET finds a new path.
  - On an Android network change (`ConnectivityManager` default network
    callback), start again from the top of the order at the next request.
  - After each successful hello, replace the saved list with `hello.addresses`
    (keep the order of section 2).
- UI: the top bar subtitle shows the path: "superuserpc · Live · Home network"
  (or "ZeroTier", "Tailscale"). When no endpoint answers: "Could not reach
  ASB." plus, when the pairing has overlay endpoints, "Away from home? Turn on
  ZeroTier (or Tailscale) on this phone." Settings > Connection lists the
  endpoints with kinds and marks the current one.
- Notifications, worker, and notification actions use the same address choice.
- Tests: v1 and v2 parse, kind order, fallback order for GET, no retry for
  POST, network-change reset, hello list update, messages.

## 5. Order

1. Worker C (PC) now, in parallel with the Android themes work (no shared files).
2. Worker D (Android) after the themes, cards, and motion work is committed.
3. Device check when the phone is connected: LAN, then Wi-Fi off with ZeroTier
   or Tailscale on the phone (the user installs and joins the overlay app).
