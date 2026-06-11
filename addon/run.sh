#!/usr/bin/with-contenv bashio
# ──────────────────────────────────────────────────────────
#  Smart Home Controller — סקריפט הפעלה של ה-Add-on
#  מזריק את פרטי החיבור ל-MQTT המקומי ומפעיל את שרת Node.
# ──────────────────────────────────────────────────────────

# ── פרטי חיבור ל-MQTT המקומי של Home Assistant (Mosquitto) ──
if bashio::services.available "mqtt"; then
    export MQTT_HOST="$(bashio::services mqtt 'host')"
    export MQTT_PORT="$(bashio::services mqtt 'port')"
    export MQTT_USER="$(bashio::services mqtt 'username')"
    export MQTT_PASS="$(bashio::services mqtt 'password')"
    bashio::log.info "מחובר ל-MQTT מקומי: ${MQTT_HOST}:${MQTT_PORT}"
else
    bashio::log.warning "שירות MQTT לא זמין — התקן והפעל את התוסף 'Mosquitto broker'."
fi

# ── סיסמת אדמין ומספרים מורשים (מתוך הגדרות התוסף) ──
export ADMIN_PASSWORD="$(bashio::config 'admin_password')"
if bashio::config.has_value 'allowed_phones'; then
    export ALLOWED_PHONES="$(bashio::config 'allowed_phones')"
fi

# ── מיגרציה אופציונלית מ-GitHub (השאר ריק לשמירה מקומית בלבד) ──
if bashio::config.has_value 'github_token'; then
    export GITHUB_TOKEN="$(bashio::config 'github_token')"
    export GITHUB_OWNER="$(bashio::config 'github_owner')"
    export GITHUB_REPO="$(bashio::config 'github_repo')"
    bashio::log.info "מצב מיגרציה מ-GitHub פעיל."
fi

# ── סביבת ריצה ──
export DATA_DIR="/data"   # נפח קבוע — ההגדרות נשמרות כאן בין הפעלות
export PORT="3000"

bashio::log.info "מפעיל את שרת הבית החכם..."
cd /app
exec node index.js
