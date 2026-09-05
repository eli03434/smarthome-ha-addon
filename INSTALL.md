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
3. עבור ללשונית **Configuration** ומלא:
   - `admin_password` — סיסמת המנהל. **שנה בכל התקנה.**
   - `controllers` — בקר אחד לכל לוח ממסרים:
     ```yaml
     controllers:
       - id: main
         name: בית
         topic: tasmota_D3D204
         relay_count: 6
     ```
     ה-`topic` הוא שם ה-MQTT של הבקר (ראה שלב 7), ו-`relay_count` מספר הממסרים בו.
   - את שדות `yemot_*` ו-`mqtt_*` השאר ריקים אלא אם יש שליטה טלפונית או ברוקר חיצוני.
   → Save.
4. הפעל "Start on boot" + "Watchdog".
5. Start.
6. בדוק את לשונית **Log** — אמורות להופיע השורות "מחובר ל-MQTT המקומי של HA",
   "בקרים מוגדרים: ..." ו-"שרת בית חכם פועל".

## שלב 7 — הגדרת בקרי Tasmota

בכל בקר Tasmota: Configuration → Configure MQTT:

| שדה | ערך |
|-----|-----|
| Host | כתובת ה-IP של ה-Pi |
| Port | 1883 |
| User | מהגדרות Mosquitto (אם הגדרת משתמש) |
| Password | מהגדרות Mosquitto |
| Topic | שם הבקר (למשל `tasmota_D3D204`) — חייב להתאים ל-`topic` שהוגדר בשלב 6 |

> כדי להוסיף/לשנות בקרים אין צורך לגעת בקוד: ערוך את `controllers` בלשונית
> **Configuration** של התוסף, שמור, והפעל מחדש (Restart).

## שלב 8 — כניסה לממשק

פתח את התוסף מ**תפריט הצד של HA** — הכניסה עוברת דרך Ingress ומאובטחת באימות של HA.
לגישה ישירה (למשל מהטלפון מחוץ ל-HA, או ל-webhook של "ימות המשיח"):
`http://<IP-של-ה-Pi>:3000`.

התחבר עם המשתמש `admin` והסיסמה שהגדרת ב-`admin_password`. הסיסמה הזו תמיד תקפה,
גם אם ייווצרו משתמשים נוספים עם סיסמאות משלהם.

## שלב 9 — חיבור התקני Home Assistant (אופציונלי)

בממשק → לשונית **🏠 התקנים** → **רענן** → סמן התקנים → **הוסף נבחרים**.
כל התקן מקבל מספר ממסר משלו וניתן לשבצו בתוכניות, בהרשאות ובשליטה הטלפונית.
אין צורך בטוקן — התוסף מדבר עם HA דרך ה-Supervisor.

---

## עדכון גרסה אצל לקוחות קיימים

1. עדכן את הקוד ב-`addon/` והעלה ל-GitHub עם מספר גרסה חדש ב-`config.yaml`.
2. אצל הלקוח: Settings → Add-ons → Smart Home Controller → לחצן Update יופיע אוטומטית.

הקוד נצרב לתמונת הקונטיינר בזמן הבנייה — אין הורדת קבצים מהאינטרנט בכל הפעלה,
ולכן מה שנבנה ונבדק הוא בדיוק מה שרץ אצל הלקוח, גם אחרי הפסקת חשמל או נפילת רשת.

## גיבוי

Settings → System → Backups → Create backup. הגיבוי כולל את כל ההגדרות
(`/data` של התוסף) וניתן לשחזור על Pi חדש.
