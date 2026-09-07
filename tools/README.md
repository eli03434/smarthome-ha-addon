# כלי בדיקה (לא נכללים ב-Add-on)

התיקייה הזו יושבת מחוץ ל-`addon/` בכוונה — היא לא נכנסת לתמונת הקונטיינר.

## check-page-loads.cjs

טוען את `smart_home_v3.html` בדפדפן וירטואלי (jsdom) ובודק שלושה דברים:
הסקריפט של הדף רץ עד הסוף בלי שגיאה, נוצר חיבור socket, ונשלחת בקשת
`get_users` שממלאת את רשימת המשתמשים במסך הכניסה.

הבדיקה נכתבה אחרי תקלה אמיתית: הצהרת `const` שהוצבה בקובץ **אחרי**
הקריאה ל-`connectMQTT()` יצרה `ReferenceError` בגלל TDZ, שהרג את כל
הסקריפט. התוצאה בממשק הייתה מסך כניסה עם רשימה נפתחת ריקה — בלי שום
דרך להיכנס. בדיקות מול השרת לבדו לא תופסות את זה, כי השרת היה תקין
לחלוטין; רק טעינה אמיתית של הדף חושפת את זה.

```sh
npm install jsdom          # פעם אחת
node tools/check-page-loads.cjs addon/rootfs/app/smart_home_v3.html /
node tools/check-page-loads.cjs addon/rootfs/app/smart_home_v3.html /api/hassio_ingress/TOKEN/
```

הפרמטר השני מדמה את מיקום הדף: `/` לגישה ישירה לפורט 3000, ונתיב
Ingress לכניסה מתפריט הצד של HA. שווה להריץ את שניהם — הם מפעילים
חישוב נתיב שונה בצד הלקוח.

יוצא עם קוד 0 בהצלחה, 1 בכישלון, כך שאפשר לשרשר אותו לפני push.

## check-dashboard.cjs

בדיקת קצה-לקצה מול שרת שרץ: טוען את הדף עם לקוח socket.io אמיתי ובודק
שרשימת המשתמשים מתמלאת, שסימוני הבנייה חוזרים מהשרת (כלומר שני הקבצים
שלמים), שאין תוכניות דמו, ושרשימת הממסרים נבנתה מהגדרות התוסף.

```sh
# בטרמינל אחד — שרת עם תצורת בדיקה
cd addon/rootfs/app
CONFIG_JSON='{"CONTROLLERS":[{"id":"main","name":"בית","topic":"t1","relayCount":6}],
              "USERS":[{"name":"admin","password":"x","role":"admin","relays":[1]}],
              "EMERGENCY_PASSWORD":"x"}' \
  DATA_DIR=/tmp/sh-test PORT=3199 node index.js

# בטרמינל שני
EXPECT_RELAYS=6 node tools/check-dashboard.cjs \
  addon/rootfs/app/smart_home_v3.html \
  addon/rootfs/app/node_modules/socket.io-client/dist/socket.io.min.js \
  3199 /
```

`EXPECT_RELAYS` הוא מספר כרטיסי הממסר הצפוי — סכום ה-relay_count של כל
הבקרים. שווה להריץ עם כמה תצורות (בקר אחד, שלושה, אפס) כדי לוודא
שהממשק באמת נגזר מההגדרות ולא מקוד קשיח.
