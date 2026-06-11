# Smart Home Add-ons — מאגר תוספים ל-Home Assistant

מאגר תוספים (Add-on Repository) להתקנת מערכת הבית החכם על גבי Home Assistant.
מיועד למתקינים: כל לקוח מקבל Raspberry Pi עם HAOS, מוסיף את המאגר הזה, ולוחץ "התקן".

## מה יש כאן

| תוסף | תיאור |
|------|-------|
| [Smart Home Controller](addon/) | בקרת ממסרים (Tasmota/MQTT), תזמון זמנים הלכתיים, ניהול משתמשים והרשאות, ממשק עברי |

## התקנה אצל לקוח חדש (תהליך מקוצר)

1. **חומרה:** Raspberry Pi 4 (2GB+) עם כרטיס SD 32GB+.
2. **צריבת HAOS:** עם Raspberry Pi Imager — בחר Home Assistant OS.
3. **גישה ראשונית:** `http://homeassistant.local:8123` → צור משתמש אדמין.
4. **התקן Mosquitto broker:** Settings → Add-ons → Store → Mosquitto broker → Install → Start.
5. **הוסף את המאגר הזה:** Add-on Store → ⋮ (פינה עליונה) → Repositories →
   הדבק `https://github.com/eli03434/smarthome-ha-addon` → Add.
6. **התקן את התוסף:** מצא "Smart Home Controller" → Install → Start.
7. **הגדר את בקרי ה-Tasmota** להתחבר ל-MQTT של ה-Pi (IP של HA, פורט 1883).
8. **פתח את הממשק:** `http://<IP-של-ה-Pi>:3000`.

מדריך מלא: [INSTALL.md](INSTALL.md)

## ארכיטקטורה

```
Raspberry Pi + HAOS
├─ Mosquitto broker (MQTT מקומי)
├─ Smart Home Controller (התוסף הזה) ──► שכבת הניהול: משתמשים, הרשאות, תזמון, UI
└─ אינטגרציות נייטיב של HA ──────────► מוצרים מסחריים: Shelly, מצלמות, חיישנים...
        ▲
        │ MQTT (1883)
   בקרי Tasmota / ESPHome (החומרה שאתה בונה)
```

## פיתוח

קוד התוסף נמצא ב-[addon/](addon/). קוד האפליקציה עצמו (Node.js) ב-[addon/rootfs/app/](addon/rootfs/app/).
כדי לשנות בקרים, משתמשים או לוגיקה — ערוך את [addon/rootfs/app/index.js](addon/rootfs/app/index.js),
העלה גרסה חדשה ב-[addon/config.yaml](addon/config.yaml), ודחוף ל-GitHub. אצל הלקוחות יופיע כפתור Update.
