#!/usr/bin/env python3
"""
ntfy backfill: home ntfy -> VPS ntfy, after an outage.

The router proxy sends to the home server only while the VPS is unreachable, so
everything that lands here was a fallback delivery. This service:
  - copies those messages to the VPS once it's reachable again, at BACKFILL_PRIORITY
    with a "[delayed HH:MM]" title, so history is complete without a second buzz
    (BACKFILL_PRIORITY=0 disables copying);
  - posts "VPS unreachable" to BACKFILL_STATUS_TOPIC on the home server after
    BACKFILL_NOTICE_AFTER seconds of failed health checks, and "reachable again"
    on the VPS when it recovers.
Queue and cursor persist in /data/state.json. Stdlib only.
"""
import json
import logging
import os
import time
import urllib.parse
import urllib.request

E = os.environ
LOCAL = E["BACKFILL_LOCAL_URL"].rstrip("/")
LOCAL_TOKEN = E["BACKFILL_LOCAL_TOKEN"]
LOCAL_BASE = E.get("NTFY_BASE_URL", LOCAL).rstrip("/")  # public URL of the home server
VPS = E["BACKFILL_VPS_URL"].rstrip("/")
VPS_TOKEN = E["BACKFILL_VPS_TOKEN"]
TOPICS = [t.strip() for t in E["BACKFILL_TOPICS"].split(",") if t.strip()]
PRIORITY = int(E.get("BACKFILL_PRIORITY", "2"))
STATUS_TOPIC = E.get("BACKFILL_STATUS_TOPIC", "relay")
NOTICE_AFTER = float(E.get("BACKFILL_NOTICE_AFTER", "30"))
HEALTH_INTERVAL = float(E.get("BACKFILL_HEALTH_INTERVAL", "15"))
POLL_INTERVAL = float(E.get("BACKFILL_POLL_INTERVAL", "2"))
TIMEOUT = float(E.get("BACKFILL_HTTP_TIMEOUT", "5"))
STATE_FILE = E.get("BACKFILL_STATE_FILE", "/data/state.json")

logging.basicConfig(level=E.get("BACKFILL_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill")


def http(method, url, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode()


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        # First start: don't replay the existing cache.
        return {"cursor": str(int(time.time())), "queue": [], "down_since": None, "notified": False}


def save_state(s):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE_FILE)


def poll_local(cursor):
    q = urllib.parse.urlencode({"poll": "1", "since": cursor})
    out = http("GET", f"{LOCAL}/{','.join(TOPICS)}/json?{q}", LOCAL_TOKEN)
    msgs = [json.loads(l) for l in out.splitlines() if l.strip()]
    return [m for m in msgs if m.get("event") == "message"]


def delayed_copy(m):
    at = time.strftime("%H:%M", time.localtime(m["time"]))
    p = {"topic": m["topic"], "message": m.get("message", ""),
         "title": f"[delayed {at}] " + (m.get("title") or m["topic"]),
         "priority": PRIORITY, "tags": list(m.get("tags") or []) + ["hourglass"]}
    for k in ("click", "icon"):
        if m.get(k):
            p[k] = m[k]
    if m.get("actions"):
        p["actions"] = [{k: v for k, v in a.items() if k != "id"} for a in m["actions"]]
    if m.get("content_type") == "text/markdown":
        p["markdown"] = True
    att = m.get("attachment") or {}
    # Files uploaded to the home server aren't reachable from outside; keep only external URLs.
    if att.get("url") and not att["url"].startswith((LOCAL, LOCAL_BASE)):
        p["attach"] = att["url"]
        if att.get("name"):
            p["filename"] = att["name"]
    return p


def vps_healthy():
    try:
        return json.loads(http("GET", f"{VPS}/v1/health", VPS_TOKEN)).get("healthy") is True
    except Exception as e:
        log.debug("VPS health check failed: %s", e)
        return False


def main():
    s = load_state()
    last_health = 0.0
    log.info("watching %s on %s, backfilling to %s (priority %s)", TOPICS, LOCAL, VPS, PRIORITY or "off")

    while True:
        now = time.time()
        dirty = False

        # 1. Collect anything that landed on the home server.
        try:
            for m in poll_local(s["cursor"]):
                if PRIORITY:
                    s["queue"].append(m)
                s["cursor"] = m["id"]
                dirty = True
                log.info("fallback delivery seen: %s/%s", m["topic"], m["id"])
        except Exception as e:
            log.warning("local poll failed: %s", e)

        # 2. Health check (more often while there's a backlog).
        vps_ok = None
        busy = s["queue"] or s["down_since"] is not None
        if now - last_health >= (POLL_INTERVAL if busy else HEALTH_INTERVAL):
            last_health = now
            vps_ok = vps_healthy()

        # 3. Outage tracking + notices.
        if vps_ok is False and s["down_since"] is None:
            s["down_since"], dirty = now, True
            log.warning("VPS unreachable")
        if s["down_since"] is not None and not s["notified"] and now - s["down_since"] >= NOTICE_AFTER:
            try:
                http("POST", LOCAL, LOCAL_TOKEN, {"topic": STATUS_TOPIC, "title": "VPS unreachable",
                                                  "message": "Home notifications are delivered by the home server until it's back.",
                                                  "tags": ["warning"], "priority": 3})
                s["notified"], dirty = True, True
            except Exception as e:
                log.warning("status notice failed: %s", e)

        # 4. Backfill in order once the VPS answers.
        if vps_ok:
            sent = 0
            while s["queue"]:
                try:
                    http("POST", VPS, VPS_TOKEN, delayed_copy(s["queue"][0]))
                    s["queue"].pop(0)
                    sent, dirty = sent + 1, True
                except Exception as e:
                    log.warning("backfill failed: %s", e)
                    break
            if s["down_since"] is not None and not s["queue"]:
                mins = int((now - s["down_since"]) / 60)
                if s["notified"] or sent:
                    try:
                        http("POST", VPS, VPS_TOKEN, {"topic": STATUS_TOPIC, "title": "VPS reachable again",
                                                      "message": f"Outage ~{mins} min, {sent} message(s) backfilled.",
                                                      "tags": ["white_check_mark"], "priority": 2})
                    except Exception:
                        pass
                log.info("VPS reachable again (~%d min, %d backfilled)", mins, sent)
                s["down_since"], s["notified"], dirty = None, False, True

        if dirty:
            save_state(s)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
