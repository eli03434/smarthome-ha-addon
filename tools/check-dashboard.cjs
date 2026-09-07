// בדיקת קצה-לקצה אמיתית: טוען את הדף האמיתי בדפדפן-וירטואלי, עם לקוח socket.io אמיתי,
// מול השרת האמיתי שרץ — ובודק את הדבר היחיד שמעניין: האם הרשימה הנפתחת במסך הכניסה
// מתמלאת בשם משתמש. זה בדיוק מה שנשבר אצל המשתמש.
//
// שימוש:  node e2e.cjs <html> <socket.io.min.js> <port> [pathname]

const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const [htmlPath, ioBundlePath, port, pathname = '/'] = process.argv.slice(2);

let html = fs.readFileSync(htmlPath, 'utf8');
const ioBundle = fs.readFileSync(ioBundlePath, 'utf8');

// לקוח socket.io אמיתי, מוטמע במקום ה-CDN (ה-CSP/רשת לא רלוונטיים לבדיקה).
html = html.replace(
  /<script[^>]*src="https:\/\/cdn\.socket\.io[^"]*"[^>]*><\/script>/g,
  `<script>${ioBundle}</script>`
);
// לוח השנה — 20MB שלא נחוצים כדי לבדוק את מסך הכניסה.
html = html.replace(
  /<script[^>]*src="calendar_data\.js"[^>]*><\/script>/g,
  '<script>window.HOLIDAY_CALENDAR = [];</script>'
);

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e.detail?.message || e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: `http://127.0.0.1:${port}${pathname}`,
  virtualConsole: vc,
  pretendToBeVisual: true,
});

setTimeout(() => {
  const w = dom.window;
  const sel = w.document.getElementById('login-user-select');
  const options = sel ? [...sel.options].map((o) => o.value).filter(Boolean) : [];
  const statusText = w.document.getElementById('status-text')?.textContent?.trim();
  const buildMarks = w.document.getElementById('build-version-indicator')?.textContent?.trim();

  const cards = w.document.querySelectorAll('.relay-card');
  const groups = [...w.document.querySelectorAll('.ctrl-sep-label')].map((e) => e.textContent.trim());
  const grid = w.document.getElementById('relay-grid');
  const gridText = grid ? grid.textContent.replace(/\s+/g, ' ').trim() : '';
  const pills = [...w.document.querySelectorAll('#controller-pills .status-pill')].map(
    (e) => e.textContent.replace(/\s+/g, ' ').trim()
  );
  // programs/modes מוצהרים כ-const בסקופ הסקריפט ולכן אינם על window — נספרים מה-DOM,
  // שזה ממילא מה שהמשתמש רואה בפועל.
  const progCount = w.document.querySelectorAll('#prog-list .prog-card').length;
  const modeNames = [...w.document.querySelectorAll('#mode-select option')].map((o) => o.textContent.trim());

  console.log(`\n── מסך הכניסה, pathname: ${pathname} ──`);
  console.log('   סימוני בנייה:   ', buildMarks || '(ריק)');
  console.log('   משתמשים ברשימה:', options.length ? options.join(', ') : '❌ ריקה');
  console.log('   כרטיסי ממסר:   ', cards.length);
  console.log('   קבוצות בקרים:  ', groups.join(' | ') || '(אין)');
  console.log('   נוריות בסרגל:  ', pills.join(' | ') || '(אין)');
  console.log('   תוכניות:       ', progCount, '| מצבים:', modeNames.join(', ') || '(אין)');
  if (!cards.length && gridText) console.log('   הודעת המסך:    ', gridText.slice(0, 90) + '…');
  else if (gridText) {
    const note = gridText.match(/ממסרים מוגדרים:.*?\./);
    if (note) console.log('   שורת הסיכום:   ', note[0]);
  }
  // הערה: סרגל המצב (statusText) מציג את חיבור ה-MQTT, לא את ה-socket — בסביבת בדיקה בלי
  // ברוקר הוא תמיד יראה "מנותק", ולכן הוא לא קריטריון. ההוכחה שה-socket עבד היא שסימוני
  // הבנייה ורשימת המשתמשים הגיעו בכלל: שניהם מגיעים אך ורק דרכו.
  console.log('   (מצב MQTT בסרגל:', (statusText || '—') + ' — לא רלוונטי בבדיקה)');

  const fail = [];
  if (errors.length) fail.push('שגיאת JS: ' + errors.join(' | '));
  if (!options.includes('admin')) fail.push('admin לא מופיע ברשימה הנפתחת');
  if (!buildMarks || /\?/.test(buildMarks)) fail.push('סימוני הבנייה לא התקבלו מהשרת — ה-socket לא עבד');
  if (progCount !== 0) fail.push(`נמצאו ${progCount} תוכניות — הדמו לא נמחק`);
  if (modeNames.length !== 1 || modeNames[0] !== 'רגיל') fail.push('מצבי הדמו לא נמחקו: ' + modeNames.join(', '));

  // מספר הממסרים הצפוי נמסר כארגומנט — כך אפשר לבדוק תצורות שונות של controllers
  const expected = process.env.EXPECT_RELAYS ? Number(process.env.EXPECT_RELAYS) : null;
  if (expected !== null && cards.length !== expected) {
    fail.push(`צפוי ${expected} כרטיסי ממסר, נמצאו ${cards.length} — הרשימה לא נבנתה מהגדרות התוסף`);
  }
  if (expected !== null && expected > 0 && pills.length !== groups.length) {
    fail.push(`${groups.length} קבוצות אבל ${pills.length} נוריות בסרגל`);
  }

  if (fail.length) {
    console.log('\n❌ נכשל:');
    fail.forEach((f) => console.log('   ' + f));
    process.exit(1);
  }
  console.log('\n✅ אפשר לבחור את admin ולהתחבר');
  process.exit(0);
}, 6000);
