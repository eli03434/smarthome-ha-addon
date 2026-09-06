// טוען את smart_home_v3.html בדפדפן-וירטואלי (jsdom) ובודק את מה ששום בדיקת-שרת לא תופסת:
// שהסקריפט של הדף רץ עד הסוף בלי שגיאה, שהוא באמת יוצר חיבור socket, ושהוא מבקש את רשימת
// המשתמשים — כלומר שרשימת-הבחירה במסך-הכניסה תתמלא.
//
// שימוש:  node loadpage.cjs <נתיב-ל-html> [pathname]
// ה-pathname מדמה איפה הדף יושב: "/" גישה ישירה, "/api/hassio_ingress/TOKEN/" דרך Ingress.

const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const file = process.argv[2];
const pathname = process.argv[3] || '/';

let html = fs.readFileSync(file, 'utf8');

// מנתקים משאבים חיצוניים (socket.io מ-CDN, calendar_data.js של 20MB) ומזריקים במקומם בדלים.
html = html.replace(/<script[^>]*src="https:\/\/cdn\.socket\.io[^"]*"[^>]*><\/script>/g, '');
html = html.replace(/<script[^>]*src="calendar_data\.js"[^>]*><\/script>/g, '');

const stub = `<script>
  window.__emits = [];
  window.__ioArgs = null;
  window.HOLIDAY_CALENDAR = [];
  window.io = function (...args) {
    window.__ioArgs = args;
    const handlers = {};
    const sock = {
      on(ev, fn) { handlers[ev] = fn; return this; },
      once(ev, fn) { handlers[ev] = fn; return this; },
      emit(ev, payload) { window.__emits.push(ev); return this; },
      close() {}, disconnect() {},
      connected: false,
    };
    // מדמים חיבור מוצלח: get_users נשלח מתוך מטפל ה-connect, אז בלי לירות אותו הבדיקה
    // לא יכולה לראות אם רשימת המשתמשים בכלל נדרשת.
    setTimeout(() => {
      sock.connected = true;
      try { handlers.connect && handlers.connect(); }
      catch (e) { window.__connectError = e.message; }
    }, 0);
    return sock;
  };
</script>`;
html = html.replace('</head>', stub + '</head>');
if (!html.includes('window.__ioArgs')) html = stub + html; // אין <head> מפורש בקובץ הזה

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://192.168.1.24:3000' + pathname,
  virtualConsole: vc,
  pretendToBeVisual: true,
});

setTimeout(() => {
  const w = dom.window;
  const fail = [];

  if (errors.length) {
    fail.push('שגיאת JavaScript בטעינת הדף:');
    errors.forEach((e) => fail.push('   ' + (e.detail?.message || e.message)));
  }
  if (!w.__ioArgs) fail.push('io() לא נקראה — לא נוצר חיבור socket כלל');
  if (w.__connectError) fail.push('שגיאה בתוך מטפל ה-connect: ' + w.__connectError);
  if (!w.__emits?.includes('get_users')) fail.push("get_users לא נשלח — רשימת המשתמשים לעולם לא תתמלא");

  const sel = w.document.getElementById('login-user-select');
  if (!sel) fail.push('לא נמצא אלמנט רשימת-המשתמשים במסך הכניסה');

  console.log(`\n── pathname: ${pathname} ──`);
  if (w.__ioArgs) {
    const opts = w.__ioArgs.find((a) => a && typeof a === 'object');
    console.log('   io() נקראה עם path:', JSON.stringify(opts?.path ?? w.__ioArgs[0]));
  }
  console.log('   אירועים שנשלחו לשרת:', w.__emits?.join(', ') || '(אין)');

  if (fail.length) {
    console.log('\n❌ נכשל:');
    fail.forEach((f) => console.log('   ' + f));
    process.exit(1);
  }
  console.log('\n✅ הדף נטען במלואו, ה-socket נוצר, ורשימת המשתמשים תתמלא');
  process.exit(0);
}, 2500);
