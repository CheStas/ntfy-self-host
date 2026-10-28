// ntfy backfill: home ntfy -> VPS ntfy, after an outage.
//
// The router proxy sends to the home server only while the VPS is unreachable, so
// everything that lands here was a fallback delivery. This service:
//   - copies those messages to the VPS once it's reachable again, at BACKFILL_PRIORITY
//     with a "[delayed HH:MM]" title, so history is complete without a second buzz
//     (BACKFILL_PRIORITY=0 disables copying);
//   - posts "VPS unreachable" to BACKFILL_STATUS_TOPIC on the home server after
//     BACKFILL_NOTICE_AFTER seconds of failed health checks, and "reachable again"
//     on the VPS when it recovers.
// Queue and cursor persist in /data/state.json. No dependencies (Node 24).
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const E = process.env;
const LOCAL = E.BACKFILL_LOCAL_URL.replace(/\/+$/, "");
const LOCAL_TOKEN = E.BACKFILL_LOCAL_TOKEN;
const LOCAL_BASE = (E.NTFY_BASE_URL || LOCAL).replace(/\/+$/, ""); // public URL of the home server
const VPS = E.BACKFILL_VPS_URL.replace(/\/+$/, "");
const VPS_TOKEN = E.BACKFILL_VPS_TOKEN;
const TOPICS = E.BACKFILL_TOPICS.split(",").map((t) => t.trim()).filter(Boolean);
const PRIORITY = Number(E.BACKFILL_PRIORITY ?? 2);
const STATUS_TOPIC = E.BACKFILL_STATUS_TOPIC || "relay";
const NOTICE_AFTER = Number(E.BACKFILL_NOTICE_AFTER ?? 30);
const HEALTH_INTERVAL = Number(E.BACKFILL_HEALTH_INTERVAL ?? 15);
const POLL_INTERVAL = Number(E.BACKFILL_POLL_INTERVAL ?? 2);
const TIMEOUT = Number(E.BACKFILL_HTTP_TIMEOUT ?? 5) * 1000;
const STATE_FILE = E.BACKFILL_STATE_FILE || "/data/state.json";
const DEBUG = (E.BACKFILL_LOG_LEVEL || "INFO").toUpperCase() === "DEBUG";

const log = (level, msg) => console.log(`${new Date().toISOString()} ${level} ${msg}`);
// All times are in seconds, as in state.json.
const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));
const nowSec = () => Date.now() / 1000;

async function http(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${text.trim()}`);
  return text;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // First start: don't replay the existing cache.
    return { cursor: String(Math.floor(nowSec())), queue: [], down_since: null, notified: false };
  }
}

function saveState(s) {
  writeFileSync(STATE_FILE + ".tmp", JSON.stringify(s));
  renameSync(STATE_FILE + ".tmp", STATE_FILE);
}

async function pollLocal(cursor) {
  const q = new URLSearchParams({ poll: "1", since: cursor });
  const out = await http("GET", `${LOCAL}/${TOPICS.join(",")}/json?${q}`, LOCAL_TOKEN);
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((m) => m.event === "message");
}

// HH:MM in the container's TZ (IANA names like Europe/Berlin work).
const hhmm = (unix) => new Date(unix * 1000).toTimeString().slice(0, 5);

function delayedCopy(m) {
  const p = {
    topic: m.topic,
    message: m.message ?? "",
    title: `[delayed ${hhmm(m.time)}] ` + (m.title || m.topic),
    priority: PRIORITY,
    tags: [...(m.tags || []), "hourglass"],
  };
  for (const k of ["click", "icon"]) if (m[k]) p[k] = m[k];
  if (m.actions?.length) p.actions = m.actions.map(({ id, ...a }) => a);
  if (m.content_type === "text/markdown") p.markdown = true;
  const att = m.attachment || {};
  // Files uploaded to the home server aren't reachable from outside; keep only external URLs.
  if (att.url && !att.url.startsWith(LOCAL) && !att.url.startsWith(LOCAL_BASE)) {
    p.attach = att.url;
    if (att.name) p.filename = att.name;
  }
  return p;
}

async function vpsHealthy() {
  try {
    return JSON.parse(await http("GET", `${VPS}/v1/health`, VPS_TOKEN)).healthy === true;
  } catch (e) {
    if (DEBUG) log("DEBUG", `VPS health check failed: ${e.message}`);
    return false;
  }
}

async function main() {
  const s = loadState();
  let lastHealth = 0;
  log("INFO", `watching ${TOPICS} on ${LOCAL}, backfilling to ${VPS} (priority ${PRIORITY || "off"})`);

  for (;;) {
    const now = nowSec();
    let dirty = false;

    // 1. Collect anything that landed on the home server.
    try {
      for (const m of await pollLocal(s.cursor)) {
        if (PRIORITY) s.queue.push(m);
        s.cursor = m.id;
        dirty = true;
        log("INFO", `fallback delivery seen: ${m.topic}/${m.id}`);
      }
    } catch (e) {
      log("WARNING", `local poll failed: ${e.message}`);
    }

    // 2. Health check (more often while there's a backlog).
    let vpsOk = null;
    const busy = s.queue.length > 0 || s.down_since !== null;
    if (now - lastHealth >= (busy ? POLL_INTERVAL : HEALTH_INTERVAL)) {
      lastHealth = now;
      vpsOk = await vpsHealthy();
    }

    // 3. Outage tracking + notices.
    if (vpsOk === false && s.down_since === null) {
      s.down_since = now;
      dirty = true;
      log("WARNING", "VPS unreachable");
    }
    if (s.down_since !== null && !s.notified && now - s.down_since >= NOTICE_AFTER) {
      try {
        await http("POST", LOCAL, LOCAL_TOKEN, {
          topic: STATUS_TOPIC, title: "VPS unreachable",
          message: "Home notifications are delivered by the home server until it's back.",
          tags: ["warning"], priority: 3,
        });
        s.notified = dirty = true;
      } catch (e) {
        log("WARNING", `status notice failed: ${e.message}`);
      }
    }

    // 4. Backfill in order once the VPS answers.
    if (vpsOk) {
      let sent = 0;
      while (s.queue.length) {
        try {
          await http("POST", VPS, VPS_TOKEN, delayedCopy(s.queue[0]));
        } catch (e) {
          log("WARNING", `backfill failed: ${e.message}`);
          break;
        }
        s.queue.shift();
        sent++;
        dirty = true;
      }
      if (s.down_since !== null && !s.queue.length) {
        const mins = Math.floor((now - s.down_since) / 60);
        if (s.notified || sent) {
          await http("POST", VPS, VPS_TOKEN, {
            topic: STATUS_TOPIC, title: "VPS reachable again",
            message: `Outage ~${mins} min, ${sent} message(s) backfilled.`,
            tags: ["white_check_mark"], priority: 2,
          }).catch(() => {});
        }
        log("INFO", `VPS reachable again (~${mins} min, ${sent} backfilled)`);
        s.down_since = null;
        s.notified = false;
        dirty = true;
      }
    }

    if (dirty) saveState(s);
    await sleep(POLL_INTERVAL);
  }
}

// As PID 1 in the container, Node ignores SIGTERM unless handled. State writes are atomic.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));

main();
