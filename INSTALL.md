# מדריך התקנה מלא — מערכת בית חכם על Home Assistant

מדריך זה מיועד **למתקין**. בסוף התהליך הלקוח מקבל מערכת עצמאית, פרטית,
שרצה כולה על Raspberry Pi בביתו — ללא תלות בענן.

---

## שלב 1 — חומרה

- **Raspberry Pi 4** (מומלץ 4GB) או Mini-PC.
- כרטיס **microSD 32GB** (מומלץ Class A2) או SSD דרך USB.
- ספק כוח רשמי, כבל רשת (מומלץ על פני Wi-Fi ליציבות).

## שלב 2 — צריבת Home Assistant OS

1. הורד את [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. CHOOSE OS → Other specific-purpose OS → Home Assistant → Home Assistant OS (לפי הדגם).
3. CHOOSE STORAGE → כרטיס ה-SD → WRITE.
4. הכנס את הכרטיס ל-Pi, חבר רשת וכוח.

## שלב 3 — הגדרה ראשונית של HA

1. המתן 5–10 דקות לאתחול ראשון.
2. בדפדפן: `http://homeassistant.local:8123` (או כתובת ה-IP של ה-Pi).
3. צור משתמש אדמין, הגדר מיקום ואזור זמן (Asia/Jerusalem).

## שלב 4 — התקנת Mosquitto broker (שרת ה-MQTT המקומי)

1. Settings → Add-ons → Add-on Store.
2. חפש **Mosquitto broker** → Install → Start.
3. ודא ש-"Start on boot" ו-"Watchdog" מופעלים.

## שלב 5 — הוספת מאגר התוספים

1. Settings → Add-ons → Add-on Store.
2. לחץ על ⋮ (פינה ימנית עליונה) → **Repositories**.
3. הדבק: `https://github.com/eli03434/smarthome-ha-addon`
4. Add → Close.

## שלב 6 — התקנת Smart Home Controller

1. רענן את החנות → מצא **Smart Home Controller**.
2. Install (לוקח כמה דקות — בונה את הקונטיינר).
3. הפעל "Start on boot" + "Watchdog".
4. Start.
5. בדוק את לשונית **Log** — אמור להופיע "מחובר ל-MQTT מקומי" ו-"שרת בית חכם פועל".

## שלב 7 — הגדרת בקרי Tasmota

בכל בקר Tasmota: Configuration → Configure MQTT:

| שדה | ערך |
|-----|-----|
| Host | כתובת ה-IP של ה-Pi |
| Port | 1883 |
| User | מהגדרות Mosquitto (אם הגדרת משתמש) |
| Password | מהגדרות Mosquitto |
| Topic | שם הבקר (למשל `tasmota_D3D204`) — חייב להתאים ל-`CONTROLLERS` בקוד |

> כדי להוסיף/לשנות בקרים, ערוך את מערך `CONTROLLERS` בקובץ
> [addon/rootfs/app/index.js](addon/rootfs/app/index.js) ובנה גרסה חדשה.

## שלב 8 — כניסה לממשק

פתח `http://<IP-של-ה-Pi>:3000` והתחבר עם משתמש מהמערכת.

---

## עדכון גרסה אצל לקוחות קיימים

1. עדכן את הקוד ב-`addon/` והעלה ל-GitHub עם מספר גרסה חדש ב-`config.yaml`.
2. אצל הלקוח: Settings → Add-ons → Smart Home Controller → לחצן Update יופיע אוטומטית.

## גיבוי

Settings → System → Backups → Create backup. הגיבוי כולל את כל ההגדרות
(`/data` של התוסף) וניתן לשחזור על Pi חדש.
