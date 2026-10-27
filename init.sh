#!/bin/sh
# Generates the only non-committed files: vps/secrets.env, home/secrets.env, clients.env.
# Settings live in the committed */config.env files; edit those first.
#
#   ./init.sh
#
# Optional env: NTFY_USER (default stas), NTFY_PASSWORD (prompted if unset),
#               CLIENTS - one publisher token per sender (default homeassistant,opnsense,servers)
#
# Publisher tokens are identical on both servers, so the router proxy can send the same
# request to either one.
set -eu
cd "$(dirname "$0")"

USER_NAME=${NTFY_USER:-stas}
CLIENTS=${CLIENTS:-homeassistant,opnsense,servers}
NTFY_IMAGE=${NTFY_IMAGE:-binwiederhier/ntfy:v2.14.0}

for f in vps/secrets.env home/secrets.env clients.env; do
  [ -e "$f" ] && { echo "$f already exists - remove it to regenerate" >&2; exit 1; }
done

if [ -z "${NTFY_PASSWORD:-}" ]; then
  printf 'Password for %s (phone/web login): ' "$USER_NAME"; stty -echo; read -r NTFY_PASSWORD; stty echo; echo
fi

rand() { LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c "$1"; }
token() { echo "tk_$(rand 29)"; }
hash() {
  if [ -n "${NTFY_BIN:-}" ]; then printf '%s\n%s\n' "$1" "$1" | "$NTFY_BIN" user hash 2>/dev/null
  else printf '%s\n%s\n' "$1" "$1" | docker run --rm -i "$NTFY_IMAGE" user hash 2>/dev/null
  fi | grep -o '\$2[aby]\$.*'
}

# Service accounts get random passwords; they only ever use tokens.
USERS="'$USER_NAME:$(hash "$NTFY_PASSWORD"):admin,publisher:$(hash "$(rand 32)"):user,backfill:$(hash "$(rand 32)"):user"

PUB_TOKENS=""; CLIENT_LINES=""
for c in $(echo "$CLIENTS" | tr ',' ' '); do
  t=$(token)
  PUB_TOKENS="$PUB_TOKENS,publisher:$t:$c"
  CLIENT_LINES="${CLIENT_LINES}NTFY_TOKEN_$(echo "$c" | tr 'a-z-' 'A-Z_')=$t
"
done

PHONE_VPS=$(token); PHONE_HOME=$(token); BF_VPS=$(token); BF_HOME=$(token)

umask 077
cat > vps/secrets.env <<EOF
NTFY_AUTH_USERS=$USERS'
NTFY_AUTH_TOKENS='$USER_NAME:$PHONE_VPS:phone,backfill:$BF_VPS:backfill$PUB_TOKENS'
EOF

cat > home/secrets.env <<EOF
NTFY_AUTH_USERS=$USERS'
NTFY_AUTH_TOKENS='$USER_NAME:$PHONE_HOME:phone,backfill:$BF_HOME:backfill$PUB_TOKENS'
BACKFILL_LOCAL_TOKEN=$BF_HOME
BACKFILL_VPS_TOKEN=$BF_VPS
EOF

cat > clients.env <<EOF
# Publisher tokens - one per sender, valid on both servers. Senders use NTFY_URL=http://<router>:8080.
${CLIENT_LINES}
# Phone/web: log in as '$USER_NAME' with your password, or use these tokens.
PHONE_VPS_TOKEN=$PHONE_VPS
PHONE_HOME_TOKEN=$PHONE_HOME
EOF

echo "Wrote vps/secrets.env, home/secrets.env, clients.env (all gitignored)."
