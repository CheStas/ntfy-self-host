# ntfy: VPS primary, home backup, failover on the router

```
 HA / OPNsense / Linux ──► router :8080 (HAProxy) ──► VPS ntfy ──► phone, anywhere
                                   │ VPS unreachable
                                   └──► home ntfy ──► phone on home Wi-Fi
                                            └── backfill ──► VPS (when it's back, silent "[delayed]" copies)
```

Reliability order assumed: VPS > internet link > home server. So the home server is never in the
normal path: if it dies, nothing changes. It only matters when the link (or VPS) is down.
The switch lives on OPNsense because the router going down already means the link is down —
it adds no new failure mode.

| Situation | Result |
|---|---|
| All up | Router → VPS. Home server unused. |
| Home server down | Nothing changes. |
| Link / VPS down, you're home | Router health check marks the VPS down (~5–10 s), sends to the home server; phone gets it on Wi-Fi. Backfill posts "VPS unreachable" on `relay`. When the link returns, everything is copied to the VPS as silent `[delayed HH:MM]` messages, plus a "reachable again" notice. |
| Link down, you're away | Delivered late via backfill; nothing lost. |
| First seconds of an outage | The first request to the dead VPS fails to connect (≤3 s), HAProxy marks it down and retries that same request on the home server. Nothing lost. |
| Router down, or both servers down | Messages are lost (senders get an error). The router being down means the link is down anyway; both servers down at once is rare enough to accept. |

## Configuration layout

Everything is set through env files; the compose files and `haproxy.cfg` contain no values.

```
vps/     config.env  (commit)   secrets.env (generated, gitignored)   docker-compose.yml  Caddyfile
home/    config.env  (commit)   secrets.env (generated, gitignored)   docker-compose.yml  backfill/
router/  config.env  (commit)   haproxy.cfg                           docker-compose.yml (Linux alternative)
clients/ ntfy-send   ntfy-send.conf.example   (optional curl wrapper)
init.sh  → writes vps/secrets.env, home/secrets.env, clients.env
```

`config.env` = all ntfy/HAProxy/backfill settings and ACLs. `secrets.env` = password hashes and tokens only.
`*.example` files show the shape of the secrets.

## Setup

1. Edit the three `config.env` files (domain, LAN IPs, router IP, topics, TZ). Commit.
2. `./init.sh` — prompts for your password, generates secrets. Each sender gets one token that
   works on **both** servers, so the router can send the same request to either.
3. VPS: copy `vps/` incl. `secrets.env` → `docker compose up -d`. Needs DNS + ports 80/443; Caddy does TLS.
4. Home: copy `home/` incl. `secrets.env` → `docker compose up -d`.
5. Router: configure HAProxy (below).

Adding a sender: append a `publisher:tk_…:name` entry (any `tk_` + 29 lowercase alphanumerics)
to `NTFY_AUTH_TOKENS` in both `secrets.env` files, then `docker compose up -d` on both.
Adding a topic: just use it. Add it to `BACKFILL_TOPICS` if outage messages on it should reach the VPS later.

## Router: HAProxy on OPNsense

Install `os-haproxy`, then under **Services → HAProxy → Settings** (labels may differ slightly between plugin versions).
The values are the ones in `router/config.env`; `router/haproxy.cfg` is the equivalent config to compare against.

- **Real Servers**
  - `vps`: FQDN `NTFY_VPS_HOST`, port 443, mode *active*, SSL on, verify SSL on, SNI = `NTFY_VPS_HOST`.
    For the CA, import *ISRG Root X1* under System → Trust → Authorities and select it.
  - `home`: address/port from `NTFY_HOME_ADDR`, mode **backup**, no SSL.
- **Health Monitor**: type HTTP, method GET, path `/v1/health`, HTTP host `NTFY_VPS_HOST`,
  interval `CHECK_INTERVAL`.
  In the `vps` server's advanced/pass-through options add `observe layer4 error-limit 1 on-error mark-down`
  (fast failover: the first failed connection marks the VPS down).
- **Backend Pool**: mode HTTP, servers `vps` + `home`, the health monitor above, and in the advanced
  pass-through options: `http-request set-header Host <NTFY_VPS_HOST>` (Caddy routes by Host),
  `option redispatch` and `retries 2` (retry a failed request on the home server).
- **Public Service**: listen on `<LAN IP>:8080` (add each VLAN IP that has senders), type HTTP, default backend = the pool.
- **Firewall**: allow sender networks → router TCP 8080. Optional: Unbound host override `ntfy.lan` → router IP.

Not on OPNsense? `cd router && docker compose up -d` on any Linux box runs `haproxy.cfg` with `config.env`.

## Senders

All senders use **one URL** (`http://<router>:8080`) and their own token from `clients.env`.

- **Home Assistant** — built-in ntfy integration: URL `http://<router>:8080`, topic `homeassistant`,
  token `NTFY_TOKEN_HOMEASSISTANT`. Or a `rest_command` posting to the same URL with
  `Authorization: Bearer <token>`.
- **Linux** — plain `curl -H "Authorization: Bearer <token>" -d "msg" http://<router>:8080/<topic>` works.
  Or install `clients/ntfy-send` to `/usr/local/bin` and `clients/ntfy-send.conf.example` → `/etc/ntfy-send.conf` (chmod 600):
  ```sh
  ntfy-send -t "Backup failed" -p high -g warning servers "restic exit 1"
  journalctl -u foo -n 20 | ntfy-send -t "foo crashed" servers -
  ```
- **OPNsense** — same script (POSIX sh) with `NTFY_URL=http://127.0.0.1:8080`, called from Monit
  (*Execute* action) or cron.

## Phone

Add both servers in the ntfy app and subscribe to the **same topics on both** (`homeassistant`, `opnsense`,
`servers`, `relay`). There are no duplicates: messages only reach the home server when the VPS was unreachable;
the later VPS copy is silent (`BACKFILL_PRIORITY=2`). Android: enable *instant delivery* for the home server.

## Notes

- **Rate limits**: ntfy limits requests per client IP. Behind the router all senders share one IP, so
  `config.env` raises the limits on both servers and exempts the router on the home server
  (`NTFY_VISITOR_REQUEST_LIMIT_EXEMPT_HOSTS`). Without this an alert storm gets HTTP 429.
- **iOS**: push for self-hosted servers goes via ntfy.sh/APNs and needs internet, so with the link
  down home messages only show when the app is open. Android is unaffected.
- **Placement**: run the home ntfy on a different box from Home Assistant if you can.
- **Attachments** uploaded during an outage stay on the home server; attachment URLs are backfilled.
- **LAN leg is plain HTTP** (tokens in clear on your LAN). Add a TLS frontend on HAProxy if that matters.
- **Versions**: image tags are pinned in the compose files; change them there.
- **Backfill** is a single dependency-free Node file (`home/backfill/backfill.mjs`). `TZ` takes normal names (`Europe/Berlin`).

Tested with ntfy v2.14.0 + HAProxy 2.8 + Node 24: normal path, VPS outage → immediate failover of the
in-flight request → home → backfill (repeated outages).
