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
clients/ ntfy-send   ntfy-send.conf.example   (optional curl wrapper)   monit-ntfy[-urgent] (OPNsense Monit hooks)
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
- **OPNsense** — same script (POSIX sh), triggered by Monit. See the next section.

## OPNsense: Monit → ntfy

OPNsense's Monit can only *mail* alerts or *execute* a program. We use **Execute** with
`clients/monit-ntfy`, a tiny wrapper that turns Monit's `MONIT_SERVICE` / `MONIT_EVENT` /
`MONIT_DESCRIPTION` variables into an `ntfy-send` call.

Why not put an `ntfy-send …` command straight into Monit's *Path* field? Monit runs that field
**without a shell**: no quoting (a title with spaces gets split), no pipes, no `$MONIT_*` expansion,
and its `PATH` doesn't include `/usr/local/bin`, so `curl` isn't found. The wrapper takes care of that.

### 1. Install the scripts (one-time, over SSH)

The OPNsense web UI has no way to upload files or edit arbitrary files, so this step is CLI only.
Enable SSH under **System → Settings → Administration → Secure Shell** (enable, allow root login or
use an admin user with sudo; you can turn it off again afterwards). From this repo:

```sh
FW=root@192.168.1.1
scp clients/ntfy-send clients/monit-ntfy clients/monit-ntfy-urgent $FW:/usr/local/bin/
ssh $FW 'cd /usr/local/bin && chmod 755 ntfy-send monit-ntfy monit-ntfy-urgent'
# config: router LAN IP + the opnsense token from clients.env
ssh $FW 'umask 077; cat > /etc/ntfy-send.conf' <<EOF
NTFY_URL=http://192.168.1.1:8080
NTFY_TOKEN=$(sed -n 's/^NTFY_TOKEN_OPNSENSE=//p' clients.env)
EOF
```

`NTFY_URL` is the router's own LAN IP, because that's where HAProxy listens (`127.0.0.1` only works if
you add `127.0.0.1:8080` to the Public Service listen addresses). `curl` is part of the base install.

These files survive reboots and firmware updates, but they are **not** in the `config.xml` backup —
after a reinstall/restore, run the commands above again.

### 2. Configure Monit (web UI)

**Services → Monit → Settings**

- **General Settings**: *Enable Monit* on. *Polling Interval* (default 120 s) is how often tests run —
  and so the worst-case delay before a notification; lower it (e.g. 30 s) for quicker gateway alerts.
  Mail server settings aren't needed.

- **Service Tests Settings**: add tests whose **Action = Execute** and **Path = `/usr/local/bin/monit-ntfy`**.
  The defaults (`CPUUsage`, `SpaceUsage`, …) use action *Alert* (mail), so create ntfy copies:

  | Name | Condition | Action | Path |
  |---|---|---|---|
  | `ntfy_cpu` | `cpu usage is greater than 90% for 5 cycles` | Execute | `/usr/local/bin/monit-ntfy` |
  | `ntfy_mem` | `memory usage is greater than 85% for 3 cycles` | Execute | `/usr/local/bin/monit-ntfy` |
  | `ntfy_load` | `loadavg (5min) is greater than 4` | Execute | `/usr/local/bin/monit-ntfy` |
  | `ntfy_space` | `space usage is greater than 80%` | Execute | `/usr/local/bin/monit-ntfy` |
  | `ntfy_status` | `status != 0` | Execute | `/usr/local/bin/monit-ntfy` |
  | `ntfy_changed` | `changed status` | Execute | `/usr/local/bin/monit-ntfy-urgent` |

  The *Path* field accepts no spaces, so it can't take arguments. `monit-ntfy` sends to topic `opnsense`
  with priority `high`; `monit-ntfy-urgent` is the same with priority `urgent`. For another topic or
  priority, copy `monit-ntfy-urgent` and change the `exec` line.
  `for N cycles` means "only if it stays true for N polls" — use it to avoid noise from short spikes.
  If your version asks for a test *Type*, pick the one matching the condition (or *Custom*).

- **Service Settings**: attach the tests to services (edit a service → *Tests*):

  | Service (shipped by default) | Type | Watches | Tests |
  |---|---|---|---|
  | `$HOST` | System | the firewall itself | `ntfy_cpu`, `ntfy_mem`, `ntfy_load` |
  | `RootFs` | Filesystem, path `/` | disk full | `ntfy_space` |
  | `gateway_alert` | Custom (runs OPNsense's `gateway_alert.php`) | WAN gateway down / packet loss, down **and** recovered | `ntfy_changed` |
  | `carp_status_change` | Custom (only with CARP) | CARP failover | `ntfy_status` |

  Your own checks work the same way: any script that exits non-zero on a problem → service type
  *Custom*, its path, test `ntfy_status`.

  The default services may be disabled — enable the ones you use, and remove their mail-only tests if
  you don't use mail. Then **Apply**.

  `gateway_alert` fires when **any** monitored gateway is down or over its loss/delay limits — also a
  single WAN in a gateway group (gateways with *Disable Gateway Monitoring* are skipped). With one WAN
  of several down, the message still goes out via the VPS; only when all WANs are down does it go to
  the **home** server (phone on Wi-Fi), to be backfilled to the VPS later.

#### Recovered notifications

Monit runs the action once, when a test **starts** failing; the OPNsense UI doesn't expose Monit's
`else if succeeded` branch. Two ways to still get "recovered" messages:

- **`changed status` (recommended, used above)** — one test that fires whenever the script's exit
  code changes, i.e. on down *and* on recovery. Nothing is sent when Monit starts (the first run only
  sets the baseline). Both messages have the same title; the body shows the transition,
  e.g. `status changed (1 -> 0)`, plus the script's output on the way down.
- **A second, opposite test** — keep `ntfy_status` (`status != 0`) on the service and add
  `ntfy_ok` (`status = 0`, Execute) next to it. `status = 0` "fails" exactly when the check recovers.
  Drawbacks: it also fires after every Monit start (Apply, reboot) while all is fine, the service
  shows as failed in **Services → Monit → Status**, and Monit calls the event "Status failed", so point
  it at its own script with a fixed title, e.g. `/usr/local/bin/monit-ntfy-ok`:
  ```sh
  #!/bin/sh
  PATH=/usr/local/bin:/bin:/usr/bin; export PATH
  exec ntfy-send -t "${MONIT_SERVICE:-monit}: recovered" -p low -g white_check_mark opnsense \
    "${MONIT_DESCRIPTION:-recovered}"
  ```

Things to know:

- Monit executes the action **once per state change** (when the test starts failing), not every cycle.
  With `changed status`, a second WAN going down while the first is still down changes the output but
  not necessarily the exit code, so it may not send a second message.
- `MONIT_DESCRIPTION` contains Monit's text, and for Custom (program) services also the script's output,
  e.g. `status failed (1) -- WAN_DHCP: down`.
- If sending fails (router proxy down…), `ntfy-send` logs `ntfy-send failed [...]` to syslog.

### 3. Test it

1. **Script works** (SSH on the firewall):
   ```sh
   ntfy-send -t "test" opnsense "hello from opnsense"; echo "exit $?"   # expect exit 0 + phone notification
   ```
   `exit 1` + `curl: (7) Failed to connect` → wrong `NTFY_URL` / HAProxy not listening there.
   `curl: (22) … 401/403` → wrong token.

2. **Wrapper works with Monit's environment** (empty env, Monit's PATH):
   ```sh
   env -i PATH=/bin:/usr/bin:/sbin:/usr/sbin MONIT_SERVICE=test MONIT_EVENT="Status failed" \
     MONIT_DESCRIPTION="manual wrapper test" /usr/local/bin/monit-ntfy; echo "exit $?"
   ```

3. **End-to-end through Monit**: in **Service Settings** add a throw-away service
   `ntfy_selftest`, type *Custom*, path `/usr/bin/false`, test `ntfy_status`. Apply. Within one polling
   interval you get *"ntfy_selftest: Status failed"*. Watch it in **Services → Monit → Status**, or on the
   shell `monit status ntfy_selftest`. Delete the service afterwards.
   (Alternative: temporarily set `ntfy_space` to `space usage is greater than 1%`.)

4. **Failover path**: on the VPS `docker compose stop ntfy` (or unplug the WAN), repeat step 1. The message
   arrives from the **home** server (**Services → HAProxy → Statistics** shows `vps` DOWN). Start the VPS
   again → within a minute a silent `[delayed HH:MM]` copy appears on the VPS plus a "reachable again" note on `relay`.

Nothing arrives? Check the Monit log (**Services → Monit → Log File**, or `System → Log Files → General`
filtered by `monit` / `ntfy-send`), and that the test's *Action* really is *Execute* (not *Alert*).

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
