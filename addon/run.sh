#!/usr/bin/with-contenv bashio
# ──────────────────────────────────────────────────────────
#  Smart Home Controller — סקריפט הפעלה של ה-Add-on
#  בונה את CONFIG_JSON שהשרת קורא, מפרטי ה-Add-on ומשירות ה-MQTT של HA.
# ──────────────────────────────────────────────────────────
set -e

OPTIONS="/data/options.json"

# ── ברוקר MQTT ────────────────────────────────────────────
# ברירת המחדל: Mosquitto המקומי של HA — פרטי החיבור מוזרקים אוטומטית, בלי שהמשתמש
# יקליד כלום. אם מולאה כתובת ב-mqtt_url בהגדרות, היא גוברת (ברוקר חיצוני).
if bashio::config.has_value 'mqtt_url'; then
    MQTT_URL="$(bashio::config 'mqtt_url')"
    MQTT_USER="$(bashio::config 'mqtt_user')"
    MQTT_PASS="$(bashio::config 'mqtt_pass')"
    bashio::log.info "משתמש בברוקר MQTT חיצוני: ${MQTT_URL}"
elif bashio::services.available "mqtt"; then
    MQTT_URL="mqtt://$(bashio::services mqtt 'host'):$(bashio::services mqtt 'port')"
    MQTT_USER="$(bashio::services mqtt 'username')"
    MQTT_PASS="$(bashio::services mqtt 'password')"
    bashio::log.info "מחובר ל-MQTT המקומי של HA: ${MQTT_URL}"
else
    MQTT_URL=""
    MQTT_USER=""
    MQTT_PASS=""
    bashio::log.warning "אין ברוקר MQTT — התקן והפעל את התוסף 'Mosquitto broker', או מלא mqtt_url בהגדרות."
    bashio::log.warning "בקרי Tasmota לא יגיבו עד שזה יוסדר. התקני Home Assistant ימשיכו לעבוד כרגיל."
fi

ADMIN_PASSWORD="$(bashio::config 'admin_password')"

# ── CONFIG_JSON — נבנה ב-jq ולא בשרשור מחרוזות ────────────
# jq דואג לבריחה (escaping) נכונה של כל ערך: שמות בקרים בעברית, סיסמאות עם גרשיים
# או תווים מיוחדים, וכו'. שרשור ידני היה מייצר JSON שבור בדיוק במקרים האלה.
# ה-CONTROLLERS מומרים כאן מ-relay_count (הפורמט של הגדרות התוסף) ל-relayCount שהשרת מצפה לו.
# EMERGENCY_PASSWORD = admin_password: תמיד תקף לכניסה כמנהל, גם אם נשכחו הסיסמאות שבממשק —
# לכן שינוי הערך הזה בהגדרות התוסף הוא תמיד דרך החזרה למערכת.
CONFIG_JSON="$(jq -n \
    --arg mqtt_url  "${MQTT_URL}" \
    --arg mqtt_user "${MQTT_USER}" \
    --arg mqtt_pass "${MQTT_PASS}" \
    --arg admin_pw  "${ADMIN_PASSWORD}" \
    --slurpfile opts "${OPTIONS}" \
    '{
       MQTT_URL: $mqtt_url,
       MQTT_USER: $mqtt_user,
       MQTT_PASS: $mqtt_pass,
       YEMOT_PHONE_MAP: {},
       CONTROLLERS: [ (($opts[0].controllers // [])[]) | {
         id, name, topic, relayCount: .relay_count
       } ],
       USERS: [ { name: "admin", password: $admin_pw, role: "admin", relays: [range(1;65)] } ],
       EMERGENCY_PASSWORD: $admin_pw
     }')"
export CONFIG_JSON

bashio::log.info "בקרים מוגדרים: $(jq -r 'if ((.controllers // []) | length) > 0 then [.controllers[].name] | join(", ") else "אין" end' "${OPTIONS}")"

# ── ימות המשיח (אופציונלי) ────────────────────────────────
YEMOT_API_TOKEN=""
YEMOT_API_LINK_URL=""
if bashio::config.has_value 'yemot_api_token'; then
    YEMOT_API_TOKEN="$(bashio::config 'yemot_api_token')"
    bashio::log.info "שילוב 'ימות המשיח' פעיל."
fi
if bashio::config.has_value 'yemot_api_link_url'; then
    YEMOT_API_LINK_URL="$(bashio::config 'yemot_api_link_url')"
fi
export YEMOT_API_TOKEN
export YEMOT_API_LINK_URL

# ── סביבת ריצה ────────────────────────────────────────────
# /data הוא הנפח הקבוע של התוסף — ההגדרות, התוכניות והמשתמשים נשמרים כאן ושורדים
# הפעלה-מחדש ועדכון-גרסה. אין הורדת קוד מ-GitHub בהפעלה: מה שנבנה בתמונה הוא מה שרץ.
export DATA_DIR="/data"
export PORT="3000"

bashio::log.info "מפעיל את שרת הבית החכם..."
cd /app
exec node index.js
