const express = require('express');
// bcryptjs — מימוש JS-טהור, תואם-פורמט מלא ל-bcrypt הנייטיב ($2a$/$2b$), כולל אימות האשים
// שכבר נשמרו. נבחר כי ל-bcrypt הנייטיב אין בינארי-מוכן ל-Alpine/musl (ובוודאי לא ל-aarch64 של
// Raspberry Pi) — הוא היה נופל לקומפילציה-מהמקור, שדורשת python3/make/g++ בתמונה, ונכשלת בבנייה.
// אותן קריאות בדיוק (hashSync/compareSync) — לא נדרש שינוי נוסף בקוד.
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const mqtt = require('mqtt');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { HOLIDAY_CALENDAR } = require('./calendar_data.js');

// ══ DEBUG ONLY — הזחת-זמן ממוקדת ללוגיקת-התזמון בלבד, לא נוגעת ב-Date הגלובלי ══════════════════
// (לא לגעת ב-Date הגלובלי! MQTT/Socket.io/HTTPS מסתמכים על שעון-אמיתי — פאץ' גלובלי ישבור אותם.)
// לקבוע DEBUG_OFFSET_MS לפער הרצוי (במילישניות) בין "עכשיו-אמיתי" ל"עכשיו-מדומה". דוגמה: קפיצה
// קדימה 2 שעות ו-11 דקות: (2*60*60*1000)+(11*60*1000). אפס = בלי הזחה בכלל (מצב-רגיל).
// **להסיר/לאפס (0) לפני פרודקשן!**
const DEBUG_OFFSET_MS = 0; // הגעה ל-2026-07-24 19:21 (יום שישי) — קדימה מ"עכשיו"
function debugNow() { return new Date(Date.now() + DEBUG_OFFSET_MS); }

// סימון-בנייה לבדיקת שלמות-קובץ (ראו IDX_BOTTOM_MARK בסוף הקובץ + BUILD_TOP_MARK/BUILD_BOTTOM_MARK
// ב-smart_home_v3.html) — ארבעתם אמורים להראות אותו מספר. אם מספר כלשהו שונה/חסר, זה סימן ברור
// שחלק מהעלאה לגיטהאב לא הגיע בשלמותו (למשל בגלל הדבקה חלקית של קובץ גדול, במקום Upload files).
const IDX_TOP_MARK = 57;

// ── CONFIG — נטען מ-config.json מקומי (ואם לא קיים — מ-CONFIG_JSON env) ──

// ── DATA DIR — /share/smarthome-data במצב add-on, ./data במצב ידני ──
// בתוך HAOS, /data הוא הנפח-הקבוע של התוסף — שורד הפעלה-מחדש, עדכון-גרסה והתקנה-מחדש, וזה
// הנתיב הרשמי לאחסון-מצב של add-on. /share (שהיה כאן קודם) דורש map: share:rw, משותף לכל
// התוספים, ואם הוא לא ממופה — הקוד היה נופל ל-./data *בתוך הקונטיינר*, ומאבד את כל ההגדרות
// בכל עדכון-גרסה. מחוץ ל-HAOS (הרצה ידנית לבדיקה) — ./data ליד הקוד.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const CONFIG_FILE_LOCAL = path.join(DATA_DIR, 'config.json');

try { 
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); 
} catch(e) { console.error('⚠️ לא ניתן ליצור תיקיית data:', e.message); }

console.log(`💾 תיקיית data: ${DATA_DIR}`);
// config בסיסי — קרא מ-env או מ-config_base.json
let config = {};
try {
  if (process.env.CONFIG_JSON) {
    config = JSON.parse(process.env.CONFIG_JSON);
    console.log('📂 config בסיסי נטען מ-CONFIG_JSON env');
  } else if (fs.existsSync(path.join(__dirname, 'config_base.json'))) {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config_base.json'), 'utf-8'));
    console.log('📂 config בסיסי נטען מ-config_base.json');
  }
  // אם CONTROLLERS חסר — נסה לטעון מ-/data/options.json (HA Add-on)
  if (!config.CONTROLLERS && fs.existsSync('/data/options.json')) {
    const opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf-8'));
    if (opts.controllers) {
      config.CONTROLLERS = opts.controllers;
      config.MQTT_URL = config.MQTT_URL || opts.mqtt_url;
      config.MQTT_USER = config.MQTT_USER || opts.mqtt_user;
      config.MQTT_PASS = config.MQTT_PASS || opts.mqtt_pass;
      console.log(`📂 CONTROLLERS נטענו ישירות מ-/data/options.json (${opts.controllers.length} בקרים)`);
    }
  }
} catch(e) {
  console.error('❌ שגיאה בטעינת config בסיסי:', e.message);
}

// ── שמירה/טעינה מקומית (במקום GitHub) ──────────────────
let _saveTimeout = null;

// כתיבה אטומית: קובץ-זמני + rename, לא כתיבה ישירה ליעד. מונע קובץ-פגום-חצי-כתוב אם נפילת-חשמל
// קורית **בדיוק** באמצע הכתיבה (אותו עיקרון בדיוק שכבר יושם ב-run.sh להורדת-הקבצים מגיטהאב).
function writeFileAtomic(filePath, content) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ── רשת-הצלה: קובץ-פעימה נפרד וזעיר (לא כל ה-config), נכתב בכל טיק ──────
// קובץ נפרד (לא בתוך config.json הגדול) כדי שהכתיבה תהיה זולה וקבועה-בגודלה, גם אם config.json
// עצמו גדול. משמש רק ל"מתי בפעם האחרונה השרת בטוח היה פעיל" — לא לשום דבר אחר.
const LAST_TICK_FILE = path.join(DATA_DIR, 'last_tick.json');
let _lastTickAtEpochMs = null;
// עותק-קפוא של הערך-שנטען-מהקובץ, לפני שכל schedulerTick דורס אותו — ראו הסבר מלא ב-runBootReconciliation
let _lastTickAtEpochMsBeforeThisBoot = null;
function loadLastTick() {
  try {
    if (!fs.existsSync(LAST_TICK_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(LAST_TICK_FILE, 'utf-8'));
    return d.lastTickAtEpochMs || null;
  } catch(e) { return null; }
}
function saveLastTick(epochMs) {
  try { writeFileAtomic(LAST_TICK_FILE, JSON.stringify({ lastTickAtEpochMs: epochMs })); }
  catch(e) { console.error('⚠️ לא ניתן לשמור last_tick.json:', e.message); }
}
// קופאים את הערך-שנטען **כאן, מיד**, ברגע-טעינת-הקובץ (לפני כל קוד אחר בקובץ, כולל הקריאה-
// המיידית ל-schedulerTick() בהמשך) — כי schedulerTick דורסת את _lastTickAtEpochMs (ואת הקובץ-
// עצמו, דרך saveLastTick) עם Date.now() נוכחי, בכל קריאה, כולל הקריאה-הראשונה-מיידית שקורית עוד
// לפני שה-IIFE-של-האתחול-בתחתית-הקובץ בכלל מתחיל לרוץ. בלי ה"הקפאה" הזו כאן-ומיד, שום ערך-אמיתי
// (מלפני-הכיבוי) לא היה שורד בכלל עד ש-runBootReconciliation מגיעה לקרוא אותו.
_lastTickAtEpochMsBeforeThisBoot = loadLastTick();
_lastTickAtEpochMs = _lastTickAtEpochMsBeforeThisBoot;

function loadConfigLocal() {
  try {
    if (!fs.existsSync(CONFIG_FILE_LOCAL)) {
      console.log('⚠️ אין קובץ config מקומי — מתחיל ריק');
      return;
    }
    const raw = fs.readFileSync(CONFIG_FILE_LOCAL, 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg.programs)  { schedulerPrograms = cfg.programs; console.log(`📂 נטענו ${schedulerPrograms.length} תוכניות`); }
    if (cfg.activeModeId !== undefined) schedulerActiveModeId = cfg.activeModeId;
    if (cfg.scheduledModes) { scheduledModes = cfg.scheduledModes; console.log(`🕐 נטענו ${scheduledModes.length} תזמוני מצב`); }
    if (cfg.serverConfig) serverConfig = cfg.serverConfig;
    if (cfg.yemotPermissions) { yemotPermissions = cfg.yemotPermissions; console.log(`📞 נטענו הרשאות IVR ל-${Object.keys(yemotPermissions).length} מזהים`); }
    if (cfg.ivrPendingTimers) { ivrPendingTimers = cfg.ivrPendingTimers; console.log(`⏱️ נטענו ${ivrPendingTimers.length} טיימרים ממתינים`); }
    if (cfg.ivrTodayEvents) { ivrTodayEvents = cfg.ivrTodayEvents; }
    if (cfg.haDevices) { 
      haDevices = cfg.haDevices; 
      // תיקון מאוחר — relayId יוקצה ב-rebuildHaRelayNames אחרי שה-CONTROLLERS נטענו
      console.log(`🏠 נטענו ${haDevices.length} התקני HA`); 
    }
    if (cfg.haToken) { haToken = cfg.haToken; }
    if (cfg.haUrl) { haUrl = cfg.haUrl; }
    if (cfg.yemotPhoneMap) { yemotPhoneMap = cfg.yemotPhoneMap; }
    if (cfg.modes) { modes = cfg.modes; console.log(`🗂️ נטענו ${modes.length} מצבים`); }
    if (cfg.externalTriggers) { externalTriggers = cfg.externalTriggers; console.log(`🔘 נטענו ${externalTriggers.length} טריגרים-חיצוניים`); }
    // מידע-טיימר-חזרה-ממתין (תזמון-מצב עם duration) — היה בזיכרון-בלבד קודם, ואבד לגמרי בקריסה.
    // בלי זה, שרת שקרס באמצע "חלון-חזרה-ממתינה" לא היה יודע בכלל שהיה אמור לחזור למצב-קודם.
    if (cfg.pendingRevertInfo) { _pendingRevertInfo = cfg.pendingRevertInfo; }
    // חשוב: .length ולא רק קיום המערך. [] הוא truthy ב-JS, ולכן config.json עם users ריק
    // (שנוצר אם ריצה קודמת עלתה בלי CONFIG_JSON) היה דורס את משתמש-האתחול לצמיתות —
    // ומאותו רגע רשימת-הבחירה במסך-הכניסה ריקה ואי-אפשר להיכנס למערכת בכלל.
    if (cfg.users && cfg.users.length) {
      runtimeUsers = cfg.users;
      let needsSave = false;
      runtimeUsers.forEach(u => {
        if (u.password && !u.password.startsWith('$2b$') && !u.password.startsWith('$2a$')) {
          u.password = bcrypt.hashSync(u.password, 10);
          console.log(`🔐 סיסמת "${u.name}" הוצפנה בטעינה`);
          needsSave = true;
        }
      });
      if (needsSave) saveConfigLocal();
    }
    console.log('✅ config נטען מקומית');
  } catch(e) {
    console.log(`❌ שגיאה בטעינת config: ${e.message}`);
  }
}

function saveConfigLocal() {
  clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    try {
      const cfg = {
        programs: schedulerPrograms,
        activeModeId: schedulerActiveModeId,
        scheduledModes,
        serverConfig,
        users: runtimeUsers,
        yemotPermissions,
        yemotPhoneMap,
        ivrPendingTimers,
        ivrTodayEvents,
        haDevices,
        haToken,
        haUrl,
        externalTriggers,
        modes,
        pendingRevertInfo: _pendingRevertInfo,
        savedAt: new Date().toISOString(),
      };
      writeFileAtomic(CONFIG_FILE_LOCAL, JSON.stringify(cfg, null, 2));
      console.log('💾 config נשמר מקומית');
    } catch(e) {
      console.error('❌ שגיאה בשמירת config:', e.message);
    }
  }, 2000);
}

// ── HOME ASSISTANT INTEGRATION ───────────────────────────
// התקני HA — רשימה שהמשתמש בחר להוסיף מ-/api/states
let haDevices = []; // [{ entity_id, friendly_name, domain, relayId }]
let haToken = ''; // Long-Lived Access Token של HA
let haUrl = 'http://homeassistant.local:8123'; // כתובת HA המקומית

// שליחת פקודה ל-HA (POST /api/services/switch/turn_on וכו')
// **תיקון-קריטי, מקור-הבאג-האמיתי-של-"fetch failed" שנמשך-כל-הלילה**: haUrl (ברירת-מחדל
// http://homeassistant.local:8123) מבוסס mDNS (סיומת .local) — פרוטוקול-גילוי-ברשת שידוע-כשביר
// אחרי שינוי-בממשק-הרשת (כבל-שנותק-וחובר-בחזרה) — הרזולוציה יכולה-להישאר-שבורה-לשעות, גם-אחרי-
// שהרשת-הפיזית-עצמה כבר-חזרה (בדיוק מה שראינו בלוג: שגיאות-fetch נמשכות שעות אחרי שהכבל חזר).
// הפתרון הרשמי-של-Home-Assistant לתקשורת-אד-און-מול-Core: http://supervisor/core/api — נתיב-
// Docker-פנימי-טהור (לא-תלוי-ב-mDNS/רשת-פיזית-בכלל, כי זו-תקשורת-קונטיינר-לקונטיינר), עם טוקן
// שכבר-מוזרק-אוטומטית ל-SUPERVISOR_TOKEN (env). דורש `homeassistant_api: true` ב-config.yaml של
// האד-און (חובה-להוסיף-ידנית! בלעדיו הטוקן לא-יקבל-הרשאה ל-core/api). אם SUPERVISOR_TOKEN לא-קיים
// (למשל הרצה-ידנית-מחוץ-לאד-און) — נופלים-בחזרה למנגנון-הישן (haUrl+haToken), בלי-לשבור-כלום.
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || null;
function haApiBase() { return SUPERVISOR_TOKEN ? 'http://supervisor/core/api' : `${haUrl}/api`; }
function haApiAuthToken() { return SUPERVISOR_TOKEN || haToken; }

async function haCallService(domain, service, entityId) {
  const token = haApiAuthToken();
  if (!token) throw new Error('לא הוגדר HA Token');
  const url = `${haApiBase()}/services/${domain}/${service}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entity_id: entityId }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HA API שגיאה ${res.status}: ${txt}`);
  }
  return res.json();
}

// קריאת מצב התקן מ-HA
async function haGetState(entityId) {
  const token = haApiAuthToken();
  if (!token) throw new Error('לא הוגדר HA Token');
  const res = await fetch(`${haApiBase()}/states/${entityId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`HA API שגיאה ${res.status}`);
  return res.json();
}

// רשימת כל ה-entities הניתנות לשליטה (switch.*, light.*, input_boolean.*, fan.*)
async function haFetchAllStates() {
  const token = haApiAuthToken();
  if (!token) throw new Error('לא הוגדר HA Token — הגדר בכרטיסיית התקנים');
  const res = await fetch(`${haApiBase()}/states`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HA API שגיאה ${res.status}: ${txt}`);
  }
  const all = await res.json();
  // סינון לישויות ניתנות לשליטה — לא כלים מובנים/מערכת
  const SKIP_PREFIXES = ['sun.','weather.','zone.','tts.','update.','todo.','person.','persistent_notification.'];
  const SKIP_SUFFIXES = ['_update','_version','_rssi','_lqi','_battery','_linkquality',
    '_temperature','_humidity','_power_outage_memory','_uptime','_ssid','_wifi_connect_count',
    '_restart_reason','_bridge_permit_join'];
  return all.filter(e => {
    const id = e.entity_id;
    if (SKIP_PREFIXES.some(p => id.startsWith(p))) return false;
    if (SKIP_SUFFIXES.some(s => id.endsWith(s))) return false;
    // רק domainים ניתנים לשליטה
    const domain = id.split('.')[0];
    return ['switch','light','input_boolean','fan','cover','lock','climate'].includes(domain);
  }).map(e => ({
    entity_id: e.entity_id,
    friendly_name: e.attributes?.friendly_name || e.entity_id,
    state: e.state,
    domain: e.entity_id.split('.')[0],
    // "דלוק?" מחושב לפי סוג ההתקן (ראו haStateIsOn) — בלעדיו תריס פתוח או מנעול פתוח היו
    // מוצגים ככבויים ברשימת-הגילוי, כי הם לא מדווחים 'on'.
    on: haStateIsOn(e.entity_id.split('.')[0], e.state),
  }));
}

// ── HA — מיפוי שירות/מצב לפי סוג ההתקן ───────────────────
// switch/light/fan/input_boolean נשלטים ב-turn_on/turn_off ומדווחים on/off — אבל cover/lock/
// climate לא: תריס נפתח/נסגר (open/closed), מנעול ננעל/נפתח (locked/unlocked), ומזגן נחשב
// "פועל" בכל מצב שאינו off. בלי המיפוי הזה כל התקן כזה היה מוצג ככבוי-תמיד, ופקודת ההדלקה
// שלו הייתה נכשלת ב-HA (אין שירות turn_on ל-cover).
function haServiceForState(domain, on) {
  if (domain === 'cover') return on ? 'open_cover' : 'close_cover';
  if (domain === 'lock')  return on ? 'unlock' : 'lock';
  return on ? 'turn_on' : 'turn_off';
}
function haStateIsOn(domain, state) {
  if (domain === 'cover')   return state === 'open';
  if (domain === 'lock')    return state === 'unlocked';
  if (domain === 'climate') return state !== 'off' && state !== 'unavailable' && state !== 'unknown';
  return state === 'on';
}

// עדכון מצב + שם של התקן HA יחיד, לפי entity_id. נקרא גם מה-WebSocket (מיידי) וגם מהסקירה
// התקופתית. מחזיר true אם שם ההתקן השתנה ב-HA — כדי לשדר מחדש את הרשימה ואת שמות הממסרים.
function applyHaState(entity_id, state, attributes) {
  let nameChanged = false;
  haDevices.forEach(dev => {
    if (dev.entity_id !== entity_id || !dev.relayId) return;
    const val = haStateIsOn(dev.domain, state) ? 'ON' : 'OFF';
    if (relayState[dev.relayId] !== val) {
      relayState[dev.relayId] = val;
      io.emit('relay_state', { id: dev.relayId, state: val });
    }
    const fname = attributes && attributes.friendly_name;
    if (fname && dev.friendly_name !== fname) {
      dev.friendly_name = fname;
      schedulerRelayNames[dev.relayId] = fname;
      nameChanged = true;
    }
  });
  return nameChanged;
}

// שידור אחיד אחרי שינוי-שם — גם רשימת ההתקנים וגם שמות הממסרים (מסך התזמון מציג את השם הזה).
function broadcastHaDeviceNames() {
  io.emit('ha_devices', haDevices);
  io.emit('relay_names_update', Object.entries(schedulerRelayNames).map(([id, name]) => ({ id: Number(id), name })));
  saveConfigLocal();
}

// סקירה תקופתית — רשת-ביטחון ל-WebSocket (אם החיבור נפל בשקט, או שפספסנו אירוע).
async function pollHADevices() {
  if (!haDevices.length || !haApiAuthToken()) return;
  try {
    const res = await fetch(`${haApiBase()}/states`, { headers: { Authorization: `Bearer ${haApiAuthToken()}` } });
    if (!res.ok) return;
    const all = await res.json();
    let nameChanged = false;
    for (const st of all) {
      if (applyHaState(st.entity_id, st.state, st.attributes)) nameChanged = true;
    }
    if (nameChanged) broadcastHaDeviceNames();
  } catch (e) { /* שקט — ננסה שוב במחזור הבא */ }
}
setInterval(pollHADevices, 30000);

// ── HA WEBSOCKET — עדכוני מצב בזמן אמת ───────────────────
// במקום להמתין לרענון-יזום מהממשק, נרשמים לאירועי state_changed של HA ומקבלים עדכון ברגע
// שהתקן משנה מצב או שם — גם כששינוי בוצע מחוץ למערכת (אפליקציית HA, מתג-קיר, אוטומציה).
let haWs = null;
let _haWsMsgId = 1;
let _haWsReconnect = null;

function scheduleHaWsReconnect() {
  clearTimeout(_haWsReconnect);
  _haWsReconnect = setTimeout(connectHAWebSocket, 5000);
}

function connectHAWebSocket() {
  // רק דרך ה-Supervisor: ws://supervisor/core/websocket הוא נתיב Docker-פנימי, לא תלוי mDNS
  // (אותו נימוק בדיוק שמופיע למעלה ליד haApiBase). בלי SUPERVISOR_TOKEN (הרצה ידנית מחוץ
  // לאד-און) — מסתפקים בסקירה התקופתית, בלי לשבור כלום.
  if (!SUPERVISOR_TOKEN) { console.log('⚠️ אין SUPERVISOR_TOKEN — דילוג על WebSocket של HA, נשארת הסקירה התקופתית'); return; }
  let ws;
  try { ws = new WebSocket('ws://supervisor/core/websocket'); }
  catch (e) { console.error('❌ שגיאת פתיחת WebSocket ל-HA:', e.message); scheduleHaWsReconnect(); return; }
  haWs = ws;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: SUPERVISOR_TOKEN }));
    } else if (msg.type === 'auth_ok') {
      console.log('✅ WebSocket של HA מאומת — נרשם לאירועי מצב');
      ws.send(JSON.stringify({ id: _haWsMsgId++, type: 'subscribe_events', event_type: 'state_changed' }));
      pollHADevices(); // משיכת מצב התחלתי מיד, בלי לחכות למחזור הראשון
    } else if (msg.type === 'auth_invalid') {
      console.error('❌ אימות WebSocket של HA נכשל:', msg.message);
    } else if (msg.type === 'event' && msg.event && msg.event.event_type === 'state_changed') {
      const d = msg.event.data;
      if (d && d.new_state && applyHaState(d.entity_id, d.new_state.state, d.new_state.attributes)) {
        broadcastHaDeviceNames();
      }
    }
  });

  ws.on('close', () => { console.log('⚠️ WebSocket של HA נסגר — מנסה שוב בעוד 5 שניות'); scheduleHaWsReconnect(); });
  ws.on('error', (e) => { console.error('❌ שגיאת WebSocket של HA:', e.message); });
}

// ── ימות המשיח — API ─────────────────────────────────────
const YEMOT_API_TOKEN = process.env.YEMOT_API_TOKEN || '';
const YEMOT_BASE_URL = 'https://www.call2all.co.il/ym/api';

async function yemotDownloadFile(filePath) {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN, path: filePath });
  const res = await fetch(`${YEMOT_BASE_URL}/DownloadFile?${params}`);
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    let data = {};
    try { data = JSON.parse(trimmed); } catch (e) {}
    throw new Error(data.message || 'שגיאה בקריאת הקובץ מימות המשיח');
  }
  return text;
}

async function yemotUploadFile(filePath, content, filename) {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN, path: filePath });
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), filename);
  const res = await fetch(`${YEMOT_BASE_URL}/UploadFile?${params}`, { method: 'POST', body: form });
  const data = await res.json();
  if (data.responseStatus !== 'OK') throw new Error(data.message || 'שגיאה בשמירת הקובץ לימות המשיח');
  return data;
}

async function yemotGetTemplates() {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN });
  const res = await fetch(`${YEMOT_BASE_URL}/GetTemplates?${params}`);
  const data = await res.json();
  if (data.responseStatus !== 'OK') throw new Error(data.message || 'שגיאה בקבלת תבניות');
  return data.templates || [];
}

async function yemotGetWhitelistTemplateId() {
  const templates = await yemotGetTemplates();
  const whitelistTemplates = templates.filter(t => t.incomingPolicy === 'WHITELIST');
  if (!whitelistTemplates.length) throw new Error('לא נמצאה תבנית WHITELIST');
  const def = whitelistTemplates.find(t => t.customerDefault);
  return (def || whitelistTemplates[0]).templateId;
}

async function yemotGetTemplateEntries(templateId) {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN, templateId });
  const res = await fetch(`${YEMOT_BASE_URL}/GetTemplateEntries?${params}`);
  const data = await res.json();
  if (data.responseStatus !== 'OK') throw new Error(data.message || 'שגיאה');
  return data.entries || [];
}

async function yemotAddPhoneToWhitelist(templateId, phone) {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN, templateId, data: phone });
  const res = await fetch(`${YEMOT_BASE_URL}/UploadPhoneList?${params}`);
  const data = await res.json();
  if (data.responseStatus !== 'OK') throw new Error(data.message || `שגיאה בהוספת ${phone}`);
  return data;
}

function normalizePhoneDigits(p) { return (p || '').replace(/\D/g, ''); }

// ── EXPRESS + SOCKET.IO ──────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

// ── MQTT — מקומי (core-mosquitto של HA) ─────────────────
// ה-URL מגיע מ-config_base.json או מ-env: mqtt://192.168.1.24:1883 (לא "tramway.railway...")
const MQTT_URL = config.MQTT_URL || process.env.MQTT_URL || 'mqtt://core-mosquitto:1883';
const MQTT_USER = config.MQTT_USER || process.env.MQTT_USER || '';
const MQTT_PASS = config.MQTT_PASS || process.env.MQTT_PASS || '';

// ── CONTROLLERS ──────────────────────────────────────────
// תמיכה בשני פורמטים: relayCount (camelCase) ו-relay_count (snake_case מ-HA options)
const CONTROLLERS = (config.CONTROLLERS || []).map(c => ({
  ...c,
  relayCount: c.relayCount || c.relay_count || 0,
}));

// ── IVR STATE ────────────────────────────────────────────
let yemotPhoneMap = config.YEMOT_PHONE_MAP || {};
let yemotPermissions = {};
let ivrPendingTimers = [];
let ivrTodayEvents = [];

function getOrderedRelayIds() {
  return Object.keys(schedulerRelayNames).map(Number).sort((a, b) => a - b);
}

function buildIvrUsersList() {
  return Object.entries(yemotPhoneMap).map(([phone, id]) => {
    const perm = yemotPermissions[id] || {};
    return {
      id, phone,
      name: perm.name || `מתקשר ${id}`,
      isAdmin: !!perm.isAdmin,
      priority: !!perm.priority,
      allowedRelays: perm.allowedRelays || [],
      allowedActions: perm.allowedActions || ['ON','OFF'],
      maxDurationMinOn: perm.maxDurationMinOn ?? 0,
      maxDurationMinOff: perm.maxDurationMinOff ?? 0,
    };
  });
}

const relayState = {};
const relayOwner = {};
const _pendingConfirm = {};
const _ackWaiters = {};

function waitForRelayAck(relayId, timeoutMs) {
  return new Promise((resolve) => {
    if (!_ackWaiters[relayId]) _ackWaiters[relayId] = [];
    const entry = { resolve, done: false };
    _ackWaiters[relayId].push(entry);
    setTimeout(() => { if (!entry.done) { entry.done = true; resolve(false); } }, timeoutMs);
  });
}
function notifyRelayAck(relayId) {
  const waiters = _ackWaiters[relayId];
  if (!waiters?.length) return;
  _ackWaiters[relayId] = [];
  waiters.forEach(w => { if (!w.done) { w.done = true; w.resolve(true); } });
}

// בנה schedulerRelayNames + relayState מ-CONTROLLERS + haDevices
const schedulerRelayNames = {};
// מקביל בדיוק ל-schedulerRelayNames — "האם ממסר זה מסומן לשליטה-טלפונית (IVR)". כמו schedulerRelayNames,
// לא נשמר-בנפרד ב-config.json — מתעדכן-מחדש מ-sync_programs בכל פעם שדפדפן מתחבר/משנה (אותה
// אמינות בדיוק כמו שמות-ממסרים, שגם הם לא נשמרים כאן ישירות אלא מגיעים תמיד מחדש מהלקוח).
const schedulerRelayIvr = {};
let _relayOffset = 0;
CONTROLLERS.forEach(ctrl => {
  ctrl._offset = _relayOffset;
  for (let i = 1; i <= ctrl.relayCount; i++) {
    const globalId = i + _relayOffset;
    relayState[globalId] = 'OFF';
    schedulerRelayNames[globalId] = ctrl.relayNames?.[i] || `ממסר ${globalId}`;
  }
  _relayOffset += ctrl.relayCount;
});

// מזהה ממסר HA (entity_id) → globalId: נוסף כשהמשתמש מוסיף התקן מ-HA
// haDevices[].relayId → globalId (מסדרה אחרי offset הבקרים)
function rebuildHaRelayNames() {
  const tasmotaMax = CONTROLLERS.reduce((s, c) => s + c.relayCount, 0);
  let changed = false;
  const usedHaIds = new Set();

  // סבב ראשון — אסוף IDs תקינים וסמן קונפליקטים
  haDevices.forEach(dev => {
    if (!dev.relayId || isNaN(dev.relayId)) {
      dev.relayId = null; changed = true;
    } else if (dev.relayId <= tasmotaMax) {
      console.log(`⚠️ התקן ${dev.entity_id} relayId=${dev.relayId} מתנגש עם בקר (tasmotaMax=${tasmotaMax}) — מוקצה מחדש`);
      dev.relayId = null; changed = true;
    } else {
      usedHaIds.add(dev.relayId);
    }
  });

  // סבב שני — הקצה לכל מי שחסר
  haDevices.forEach(dev => {
    if (!dev.relayId) {
      let nextId = tasmotaMax + 1;
      while (usedHaIds.has(nextId)) nextId++;
      dev.relayId = nextId;
      usedHaIds.add(nextId);
      console.log(`🔧 הוקצה relayId ${nextId} ל-${dev.entity_id}`);
    }
    schedulerRelayNames[dev.relayId] = dev.friendly_name || dev.entity_id;
    if (!relayState[dev.relayId]) relayState[dev.relayId] = 'OFF';
  });

  if (changed) {
    saveConfigLocal();
    console.log(`🏠 התקני HA לאחר תיקון: ${haDevices.map(d => `${d.friendly_name}→${d.relayId}`).join(', ')}`);
  }
}

function getControllerForRelay(globalRelayId) {
  let offset = 0;
  for (const ctrl of CONTROLLERS) {
    if (globalRelayId > offset && globalRelayId <= offset + ctrl.relayCount) {
      return { type: 'tasmota', ctrl, localId: globalRelayId - offset };
    }
    offset += ctrl.relayCount;
  }
  // בדוק אם זה התקן HA
  const haDev = haDevices.find(d => d.relayId === globalRelayId);
  if (haDev) return { type: 'ha', dev: haDev };
  return { type: 'tasmota', ctrl: CONTROLLERS[0], localId: globalRelayId };
}

// הגדרת הבקרים והממסרים כפי שהיא נשלחת לממשק. מקור האמת היחיד הוא רשימת controllers
// שבהגדרות התוסף — הממשק לא מחזיק עותק משלו. כך הוספת בקר ב-Configuration מוסיפה את
// הממסרים שלו לכל המסכים מיד, בלי לגעת בקוד. המספור גלובלי ורציף לפי סדר הבקרים:
// הבקר הראשון תופס 1..relayCount, השני ממשיך אחריו, וכן הלאה.
function buildRelayConfig() {
  const relays = [];
  let offset = 0;
  CONTROLLERS.forEach(ctrl => {
    for (let i = 1; i <= ctrl.relayCount; i++) {
      const id = i + offset;
      relays.push({ id, ctrl: ctrl.id, name: schedulerRelayNames[id] || `ממסר ${id}` });
    }
    offset += ctrl.relayCount;
  });
  return {
    controllers: CONTROLLERS.map(c => ({
      id: c.id, name: c.name, topic: c.topic, relayCount: c.relayCount,
    })),
    relays,
  };
}

// ── IVR URL — כעת מצביע לדומיין המקומי (Cloudflare Tunnel) ─
const YEMOT_API_LINK_URL = process.env.YEMOT_API_LINK_URL || 'https://smarthome.example.com/yemot';
// "בסיס" בלי ה-/yemot בסוף — כדי לבנות נתיבים ברמה-עליונה (למשל /schedule) ולא רק תת-נתיבים תחת
// /yemot/... — נבדק כניסוי, כי יש חשד שהמערכת של ימות לא מטפלת נכון בתת-נתיבים (subpaths).
const YEMOT_API_BASE_URL = YEMOT_API_LINK_URL.replace(/\/yemot\/?$/, '');

// שתי הפונקציות האלה הן **מקור-האמת היחיד** לסדר-הפריטים ברשימת-הבחירה הטלפונית (תוכניות/
// תיזמונים) — גם בונה-ה-TTS (buildYemotAutoFiles) וגם ה-endpoints שמפרשים-לחיצה (/yemot/program,
// /yemot/schedule) *חייבים* לקרוא לאותה פונקציה בדיוק, כדי שה"מיקום" (1,2,3...) שהמתקשר שומע
// יתאים תמיד למיקום שהשרת יפרש. אין שום מספר-IVR-נפרד שנשמר — הכל נגזר-מחדש כל פעם, מסודר
// לפי seqId/id (יציב, לא תלוי בסדר-ההוספה-לרשימה).
function getIvrProgramsOrdered() {
  return schedulerPrograms.filter(p => p.ivr && !p.parentProgId).sort((a,b) => a.seqId - b.seqId);
}
function getIvrSchedulesOrdered() {
  return scheduledModes.filter(sm => sm.ivr).sort((a,b) => a.id - b.id);
}
function getIvrModesOrdered() {
  return modes.filter(m => m.ivr).sort((a,b) => a.id - b.id);
}

// כל שורה בקובץ-TTS בשורה-נפרדת-משלה, ומסתיימת ב"שתי-נקודות" (לא נקודה בודדת) — זה מאט את
// קצב-ההקראה של ימות בין פריט-לפריט (למשל בין ממסר לממסר, או בין הוראה להוראה) — בלי זה, ימות
// קורא הכל ברצף-אחד-מהיר, קשה למתקשר לעקוב אחרי רשימה-ארוכה של ממסרים/תוכניות.
function buildTtsLines(lines) {
  return lines.map(l => l.replace(/\.+$/, '') + '..').join('\n');
}

// בונה את קבצי-ה-TTS/ext.ini עבור שלושה סוגי-תפריט אפשריים בשלוחת-IVR:
// 'relay' (ברירת-מחדל, הקיים) — ממסר←פעולה←משך, על כל הממסרים (ממוספר לפי ה-ID האמיתי של הממסר,
//   ללא שינוי — שם זה סביר כי ה-ID של ממסר קבוע-ולא-משתנה, לא כמו seqId/id שיכולים להיות "גדולים").
// 'program'/'schedule' — ניהול תוכניות/תיזמוני-מצב (הפעלה/השבתה), **רק** על פריטים שסומנו
//   ivr===true — אבל **הספרה-שנאמרת-ונלחצת היא מיקום פשוט (1,2,3...) ברשימה המסוננת**, לא ה-
//   seqId/id האמיתי (שיכול להיות "לא-נקי", כמו 9602/9604) — השרת ממיר את המיקום ל-ID האמיתי
//   בעצמו (ראו getIvrProgramsOrdered/getIvrSchedulesOrdered למעלה, ו-/yemot/program|schedule למטה).
function buildYemotAutoFiles(kind) {
  kind = kind || 'relay';

  if (kind === 'program') {
    const ivrProgs = getIvrProgramsOrdered();
    const maxDigits = String(ivrProgs.length || 1).length;
    const posKeys = ivrProgs.map((p,i) => i+1).join('.');
    const tts000 = ivrProgs.length
      ? buildTtsLines(['שלום, להלן רשימת התוכניות הזמינות לניהול', ...ivrProgs.map((p,i) => `ל${p.name} הקש ${i+1}`)])
      : 'לא הוגדרו תוכניות זמינות לניהול טלפוני.';
    const tts001 = buildTtsLines(['להפעלת התוכנית הקש 1', 'להשבתת התוכנית הקש 2', 'לבדיקת סטטוס התוכנית הקש 3']);
    const extIni = [
      'type=api',
      'rate=0',
      'voice=Osnat',
      `api_link=${YEMOT_API_LINK_URL}`, // ניסוי: אותו נתיב-בדיוק כמו ממסרים, מבדילים לפי שם-הפרמטר (ProgNum) — ראו dispatchIvrRequest
      'api_hangup_send=No',
      `api_000=ProgNum,,${maxDigits},1,7,No,yes,yes,,${posKeys},3,`,
      'api_001=Action,,1,1,5,No,yes,yes,,1.2.3,3,',
      'api_end_goto=/',
      '',
    ].join('\n');
    return { tts000, tts001, extIni };
  }

  if (kind === 'schedule') {
    const ivrModes = getIvrSchedulesOrdered();
    const maxDigits = String(ivrModes.length || 1).length;
    const posKeys = ivrModes.map((sm,i) => i+1).join('.');
    const tts000 = ivrModes.length
      ? buildTtsLines(['שלום, להלן רשימת תזמוני-המצב הזמינים לניהול', ...ivrModes.map((sm,i) => `ל${sm.name} הקש ${i+1}`)])
      : 'לא הוגדרו תזמוני-מצב זמינים לניהול טלפוני.';
    const tts001 = buildTtsLines(['להפעלת התזמון הקש 1', 'להשבתת התזמון הקש 2', 'לבדיקת סטטוס התזמון הקש 3']);
    const extIni = [
      'type=api',
      'rate=0',
      'voice=Osnat',
      `api_link=${YEMOT_API_LINK_URL}`, // ניסוי: אותו נתיב-בדיוק כמו ממסרים, מבדילים לפי שם-הפרמטר (SchedNum) — ראו dispatchIvrRequest
      'api_hangup_send=No',
      `api_000=SchedNum,,${maxDigits},1,7,No,yes,yes,,${posKeys},3,`,
      'api_001=Action,,1,1,5,No,yes,yes,,1.2.3,3,',
      'api_end_goto=/',
      '',
    ].join('\n');
    return { tts000, tts001, extIni };
  }

  if (kind === 'mode') {
    const ivrModes = getIvrModesOrdered();
    const maxDigits = String(ivrModes.length || 1).length;
    const posKeys = ivrModes.map((m,i) => i+1).join('.');
    const tts000 = ivrModes.length
      ? buildTtsLines(['שלום, להלן רשימת המצבים הזמינים למעבר', ...ivrModes.map((m,i) => `למצב ${m.name} הקש ${i+1}`)])
      : 'לא הוגדרו מצבים זמינים למעבר טלפוני.';
    const tts001 = buildTtsLines(['כעת הקישו את מספר הדקות למעבר הזמני, או הקישו 0 למעבר קבוע בלי הגבלת זמן']);
    const extIni = [
      'type=api',
      'rate=0',
      'voice=Osnat',
      `api_link=${YEMOT_API_LINK_URL}`, // ניסוי: אותו נתיב-בדיוק כמו ממסרים/תוכניות, מבדילים לפי שם-הפרמטר (ModeNum) — ראו dispatchIvrRequest
      'api_hangup_send=No',
      `api_000=ModeNum,,${maxDigits},1,7,No,yes,yes,,${posKeys},3,`,
      'api_001=Duration,,3,1,7,No,yes,no,,,3,',
      'api_end_goto=/',
      '',
    ].join('\n');
    return { tts000, tts001, extIni };
  }

  // kind === 'relay' (ברירת-מחדל) — **רק** ממסרים שסומנו ivr===true (בדיוק כמו תוכניות/תיזמונים)
  const relayIds = getOrderedRelayIds().filter(id => schedulerRelayIvr[id]);
  const relayKeys = relayIds.join('.');
  const tts000 = relayIds.length
    ? buildTtsLines(['שלום, להלן רשימת המתגים הקיימים', ...relayIds.map(id => `ל${schedulerRelayNames[id]} הקש ${id}`)])
    : 'לא הוגדרו ממסרים זמינים לשליטה טלפונית.';
  const tts001 = buildTtsLines(['לבחירת הדלקה הקש 1', 'לבחירת כיבוי הקש 2']);
  const tts002 = buildTtsLines(['כעת הקישו את מספר הדקות לפעולה, או הקישו 0 לפעולה קבועה בלי הגבלת זמן']);
  const extIni = [
    'type=api',
    'rate=0',
    'voice=Osnat',
    `api_link=${YEMOT_API_LINK_URL}`,
    'api_hangup_send=No',
    `api_000=Relay,,2,1,7,No,yes,yes,,${relayKeys},3,`,
    'api_001=Action,,1,1,5,No,yes,yes,,1.2,3,',
    'api_002=Duration,,3,1,7,No,yes,no,,,3,',
    'api_end_goto=/',
    '',
  ].join('\n');
  return { tts000, tts001, tts002, extIni };
}

// ── SCHEDULER STATE ──────────────────────────────────────
let schedulerPrograms = [];
// רשימת-המצבים עצמם (שם + דגל-ivr) — עד עכשיו התקיים רק בצד-הלקוח, בתוך fullConfig באופן אטום.
// נדרש כאן במפורש כדי לבנות את תפריט-הבחירה-הטלפוני (IVR) ולוודא בחירות-תקפות.
let modes = [];
let schedulerActiveModeId = 0;
let scheduledModes = []; // תזמוני החלפת מצב
// טריגרים-חיצוניים: מיפוי "האזן לנושא-MQTT X, כשהשדה Y=ערך Z, בצע פעולה" — כדי שמתגי-קיר/כפתורי-
// סצנה (zigbee) יוכלו להפעיל ממסר/תוכנית/מצב, בלי לגעת בקוד בכלל לכל התקן-חדש. כל טריגר:
// {id, name, mqttTopic, matchField, matchValue, actionType:'relay'|'program'|'mode',
//  relayId, relayAction, durationMin, progId, progActive, modeId}
let externalTriggers = [];
// מצב-לימוד זמני: כשמופעל (דרך הממשק), כל הודעת-MQTT-הבאה-שמגיעה נתפסת-ותשודרת-לממשק (כדי
// שהמשתמש "ילחץ על הכפתור עכשיו" ויראה מיד את ה-topic/action המדויקים, בלי לדעת אותם מראש).
let _triggerLearnModeActive = false;
let _triggerLearnModeTimeout = null;
let _previousModeId = null; // המצב לפני מעבר עם duration (לחזרה אוטומטית)
// מתי קרה מעבר-המצב-האחרון — נדרש כדי לדעת "מאיפה להתחיל לחפש תוכניות-שהוחמצו" בכל מעבר-מצב-חדש
// (ראו commitAutoModeSwitch: applyMissedRegularPrograms(lastTransition, now)). null עד המעבר-הראשון
// (לא רץ retroactively על היסטוריה-מלפני-שהשרת-עלה — boot reconciliation כבר מטפלת בזה בנפרד).
let _lastModeTransitionAtMs = null;
let _activeScheduledModeTimer = null; // טיימר חזרה פעיל
let _pendingRevertInfo = null; // מידע חשוף ללקוח: { revertToMode, revertAtEpochMs } | null
// טיימרי-חזרה-ממתינים ש"הופרעו" ע"י תזמון-מצב-אחר-שירה-באמצע (למשל מצב-A עם "למשך" עדיין-פעיל,
// ותזמון-B מפריע-לו-לפני-שהוא-הספיק-לחזור-לבד) — נשמרים כאן, מפתח=המצב-שהיה-לו-הטיימר, כדי-
// שכשחוזרים-בסוף לאותו-מצב (דרך תזמון-B-עצמו שחוזר-חזרה), נחמש-אותם-מחדש במקום-לאבד-אותם-לצמיתות.
let _savedPendingRevertsByMode = {};
const _firedToday = new Set();
const _actuallyFired = new Set();
const _firedRunOnceToday = new Map();
const _pendingPublish = {};

const _calendarIndex = {};
for (const entry of HOLIDAY_CALENDAR) {
  _calendarIndex[entry['תאריך לועזי']] = entry;
}

let mqttClient = null;
let mqttConnected = false;
const controllerOnline = {};
CONTROLLERS.forEach(ctrl => { controllerOnline[ctrl.id] = false; });

function connectMQTT() {
  if (!CONTROLLERS.length) {
    console.log('⚠️ אין CONTROLLERS מוגדרים — MQTT לא מתחבר');
    return;
  }
  console.log(`מתחבר ל-MQTT: ${MQTT_URL}...`);
  const mqttOpts = { reconnectPeriod: 5000 };
  if (MQTT_USER) { mqttOpts.username = MQTT_USER; mqttOpts.password = MQTT_PASS; }
  mqttClient = mqtt.connect(MQTT_URL, mqttOpts);

  mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log('✅ מחובר ל-MQTT');
    CONTROLLERS.forEach(ctrl => {
      for (let i = 1; i <= ctrl.relayCount; i++) {
        mqttClient.subscribe(`stat/${ctrl.topic}/POWER${i}`);
      }
      mqttClient.subscribe(`stat/${ctrl.topic}/RESULT`);
      mqttClient.subscribe(`stat/${ctrl.topic}/STATUS11`);
      mqttClient.subscribe(`tele/${ctrl.topic}/STATE`);
      mqttClient.subscribe(`tele/${ctrl.topic}/LWT`);
      mqttClient.publish(`cmnd/${ctrl.topic}/STATUS`, '11');
    });
    // מנוי-רחב לכל התקני-zigbee2mqtt (מתגי-קיר/כפתורי-סצנה/חיישנים) — כדי שטריגרים-חיצוניים
    // (שמוגדרים מהממשק, לא בקוד) יוכלו לתפוס כל הודעה מכל התקן-כזה, בלי לדעת-מראש אילו יהיו.
    mqttClient.subscribe('zigbee2mqtt/#');
    io.emit('mqtt_status', { connected: true });
    // רשת-הצלה: מריצים את בדיקת-ההתאמה-אחרי-הפעלה-מחדש רק **אחרי** שהחיבור ל-MQTT יציב (לא מיד
    // בעליית-התהליך) — זה בדיוק האיתות-בפועל ל"המערכת עלתה ומוכנה לשלוח פקודות אמיתיות". השהיה
    // קצרה נוספת (3 שניות) כדי לתת ל-subscribe/STATUS שנשלחו למעלה זמן-להתיישב, לא חובה אך זול-ובטוח.
    setTimeout(() => { runBootReconciliation(); }, 3000);
    // **תיקון-קריטי-נוסף, נפרד מ-runBootReconciliation (שרצה פעם-אחת-בלבד)**: אם ה-MQTT-עצמו היה-
    // מנותק בזמן שהשרת **נשאר-פעיל** (לא-קרס, לא-הופעל-מחדש — למשל כבל-רשת שנותק-וחובר-בחזרה) —
    // פקודות ON/OFF שהיו-אמורות-להישלח באותו-חלון פשוט נכשלו בשקט. זה תרחיש-שונה-לגמרי מ"השרת-
    // קרס" (ששם runBootReconciliation כן-מטפל), ולכן צריך מנגנון-נפרד שרץ **בכל** התחברות-מחדש,
    // לא רק בעלייה-הראשונה. משתמשים באותה applyMissedRegularPrograms — בודקת-לפי-היסטוריה (שני-
    // הכיוונים ON/OFF), בלי-תלות ב-_actuallyFired/_firedToday (שיכולים-להיות-מסומנים-שגוי בגלל
    // הנסיון-שנכשל — ראו fireEvent).
    if (_mqttDisconnectedAtMs !== null) {
      const gapFrom = _mqttDisconnectedAtMs;
      _mqttDisconnectedAtMs = null;
      const gapMin = Math.round((Date.now()-gapFrom)/60000*10)/10;
      addServerLog({ type: 'info', msg: `🔄 MQTT התחבר-מחדש אחרי ${gapMin} דקות ניתוק — בודק תוכניות שהוחמצו בזמן הניתוק`, user: 'מערכת' });
      setTimeout(async () => {
        try {
          const res = applyMissedRegularPrograms(gapFrom, Date.now());
          if (res && res.done) await res.done;
          if (!res || !res.appliedCount) addServerLog({ type: 'info', msg: '✅ לא נמצאו תוכניות-שהוחמצו בזמן-הניתוק', user: 'מערכת' });
        } catch (e) {
          console.error('❌ שגיאה בבדיקת תוכניות-שהוחמצו (MQTT reconnect):', e.message);
        }
      }, 3500); // אחרי runBootReconciliation (3000), כדי לא-להתנגש אם שתיהן-רצות (עלייה-ראשונה)
    }
  });

  mqttClient.on('message', (topic, message) => {
    const payload = message.toString();

    // ── טריגרים-חיצוניים (zigbee2mqtt) — נבדק לפני-הכל, לא-קשור לבקרי-Tasmota הרגילים ──
    if (topic.startsWith('zigbee2mqtt/')) {
      let payloadObj = null;
      try { payloadObj = JSON.parse(payload); } catch(e) {}
      // מצב-לימוד: תופסים את ההודעה-הבאה-שמגיעה מהתקן-אמיתי, ומשדרים אותה לממשק. **חשוב**:
      // מתעלמים-במפורש מ-zigbee2mqtt/bridge/* (למשל bridge/logging, bridge/state, bridge/info) —
      // אלה נושאי-מערכת-פנימיים (יומן/סטטוס של הגשר עצמו), לא-של-שום-התקן-ספציפי. bridge/logging
      // בפרט "מהדהד" כל פעולת-MQTT שקורית על הגשר כמחרוזת-JSON-מקוננת בתוך שדה "message" — בלי
      // סינון-הזה, מצב-הלימוד היה כמעט-תמיד תופס את זה במקום את ה-topic-האמיתי-של-ההתקן.
      const isBridgeMetaTopic = topic.startsWith('zigbee2mqtt/bridge/');
      if (_triggerLearnModeActive && payloadObj && !isBridgeMetaTopic) {
        _triggerLearnModeActive = false;
        clearTimeout(_triggerLearnModeTimeout);
        io.emit('trigger_learn_result', { topic, payload: payloadObj });
        addServerLog({ type: 'info', msg: `🎧 [לימוד-טריגר] נתפס: ${topic} → ${JSON.stringify(payloadObj)}`, user: 'מערכת' });
      }
      // התאמה מול טריגרים-מוגדרים — מבצעים את הפעולה-המתאימה-הראשונה-שמתאימה (לא כולן, כדי
      // למנוע הפעלה-כפולה-בטעות אם כמה טריגרים חופפים על-אותו topic/ערך בטעות-הגדרה)
      if (payloadObj && !isBridgeMetaTopic) {
        const match = externalTriggers.find(t => t.mqttTopic === topic &&
          String(payloadObj[t.matchField]) === String(t.matchValue));
        if (match) executeTriggerAction(match).catch(e => console.error('❌ שגיאה בביצוע-טריגר:', e.message));
      }
      return; // הודעות zigbee2mqtt לא רלוונטיות לשום-לוגיקת-Tasmota-שבהמשך
    }

    const ctrl = CONTROLLERS.find(c => topic.includes(c.topic));
    const ctrlName = ctrl ? ctrl.name : 'בקר';

    const matchPower = topic.match(/stat\/.+\/POWER(\d+)$/);
    if (matchPower && ctrl) {
      const localId = parseInt(matchPower[1]);
      const globalId = localId + (ctrl._offset || 0);
      relayState[globalId] = payload.toUpperCase();
      io.emit('relay_state', { id: globalId, state: payload.toUpperCase() });
      notifyRelayAck(globalId);
      if (_pendingConfirm[globalId]) { clearTimeout(_pendingConfirm[globalId]); delete _pendingConfirm[globalId]; }
      const relayName = schedulerRelayNames[globalId] || `ממסר ${globalId}`;
      const originLabel = _lastCommandOrigin[globalId];
      addServerLog({ type: 'success', msg: `✔ בקר אישר: ${relayName} → ${payload.toUpperCase()}${originLabel ? ` [${originLabel}]` : ''}`, user: ctrlName });
    }

    if (topic.endsWith('/LWT')) {
      const isOnline = payload === 'Online';
      if (ctrl) controllerOnline[ctrl.id] = isOnline;
      io.emit('controller_status', { online: isOnline, controller: ctrlName, controllerId: ctrl?.id });
      addServerLog({ type: isOnline ? 'success' : 'danger', msg: `${isOnline ? '🟢' : '🔴'} ${ctrlName} ${isOnline ? 'התחבר' : 'התנתק'}`, user: 'בקר' });
    }

    if (topic.endsWith('/RESULT')) {
      try {
        const d = JSON.parse(payload);
        if (ctrl) {
          for (let i = 1; i <= ctrl.relayCount; i++) {
            if (d[`POWER${i}`] !== undefined) {
              const globalId = i + (ctrl._offset || 0);
              relayState[globalId] = d[`POWER${i}`].toUpperCase();
              io.emit('relay_state', { id: globalId, state: relayState[globalId] });
            }
          }
        }
      } catch(e) {}
    }

    if (topic.endsWith('/STATUS11')) {
      try {
        const d = JSON.parse(payload);
        const sts = d.StatusSTS || d;
        if (ctrl) {
          for (let i = 1; i <= ctrl.relayCount; i++) {
            if (sts[`POWER${i}`] !== undefined) {
              const globalId = i + (ctrl._offset || 0);
              relayState[globalId] = sts[`POWER${i}`].toUpperCase();
              io.emit('relay_state', { id: globalId, state: relayState[globalId] });
            }
          }
        }
      } catch(e) {}
    }

    if (topic.endsWith('/STATE')) {
      try {
        const d = JSON.parse(payload);
        if (ctrl) {
          for (let i = 1; i <= ctrl.relayCount; i++) {
            if (d[`POWER${i}`] !== undefined) {
              const globalId = i + (ctrl._offset || 0);
              relayState[globalId] = d[`POWER${i}`].toUpperCase();
              io.emit('relay_state', { id: globalId, state: relayState[globalId] });
            }
          }
        }
      } catch(e) {}
    }
  });

  mqttClient.on('error', (e) => { mqttConnected = false; if (_mqttDisconnectedAtMs === null) _mqttDisconnectedAtMs = Date.now(); io.emit('mqtt_status', { connected: false }); });
  mqttClient.on('close', () => { mqttConnected = false; if (_mqttDisconnectedAtMs === null) _mqttDisconnectedAtMs = Date.now(); io.emit('mqtt_status', { connected: false }); });
}

const _lastCommandOrigin = {};

async function publishRelay(relayId, state, originLabel = null) {
  const { type, ctrl, localId, dev } = getControllerForRelay(relayId);
  const relayName = schedulerRelayNames[relayId] || `ממסר ${relayId}`;
  _lastCommandOrigin[relayId] = originLabel;

  if (type === 'ha') {
    // שליחה דרך HA REST API
    if (!dev) throw new Error(`לא נמצא התקן HA ל-relay ${relayId}`);
    const service = haServiceForState(dev.domain || 'switch', state === 'ON');
    await haCallService(dev.domain || 'switch', service, dev.entity_id);
    relayState[relayId] = state;
    addServerLog({ type: 'sent', msg: `📤 שרת שלח HA: ${relayName} → ${state}${originLabel ? ` [${originLabel}]` : ''}`, user: (originLabel && originLabel.startsWith('IVR')) ? originLabel : 'שרת' });
    io.emit('relay_state', { id: relayId, state });
    // HA לא שולח MQTT — נאמת מיד (ה-API הסינכרוני עצמו הוא האישור)
    notifyRelayAck(relayId);
    return;
  }

  // Tasmota MQTT
  return new Promise((resolve, reject) => {
    if (!mqttConnected) {
      addServerLog({ type: 'danger', msg: `❌ לא ניתן לשלוח לממסר ${relayId} — MQTT מנותק`, user: 'שרת' });
      reject(new Error('לא מחובר')); return;
    }
    const topic = `cmnd/${ctrl.topic}/POWER${localId}`;
    mqttClient.publish(topic, state, { qos: 1 }, (err) => {
      if (err) { reject(err); return; }
      relayState[relayId] = state;
      addServerLog({ type: 'sent', msg: `📤 שרת שלח: ${relayName} → ${state}${originLabel ? ` [${originLabel}]` : ''}`, user: (originLabel && originLabel.startsWith('IVR')) ? originLabel : 'שרת' });
      // שידור מיידי לכל הדפדפנים המחוברים — כך שהמחוון בממשק מתעדכן תמיד לפי הפקודה שנשלחה,
      // בלי תלות באישור-פיזי מהבקר (שיכול לקחת זמן, או לא להגיע כלל אם הבקר מנותק/איטי). בלי זה,
      // רק דפדפן שביצע לחיצה-ידנית-מקומית "ראה" את השינוי (עדכון-אופטימי מקומי בצד הלקוח בלבד) —
      // כל מקור אחר (IVR, תוכנית מתוזמנת, דפדפן אחר) לא היה משודר לאף אחד.
      io.emit('relay_state', { id: relayId, state });
      const confirmTimer = setTimeout(() => {
        addServerLog({ type: 'warning', msg: `⚠️ לא התקבל אישור מהבקר: ${relayName} (${state})`, user: 'בקר' });
      }, 5000);
      _pendingConfirm[relayId] = confirmTimer;
      resolve();
    });
  });
}

// מבצע את הפעולה-שהוגדרה-לטריגר-חיצוני (כפתור-קיר/מתג-סצנה וכו') — מפעיל בדיוק את אותה
// לוגיקה-פנימית שכבר קיימת לממסרים/תוכניות/מצבים, בלי כפילות-לוגיקה חדשה.
async function executeTriggerAction(trigger) {
  addServerLog({ type: 'info', msg: `🔘 [טריגר] "${trigger.name}" הופעל`, user: 'מערכת' });
  if (trigger.actionType === 'relay') {
    const relayId = trigger.relayId;
    let action = trigger.relayAction; // 'ON' / 'OFF' / 'TOGGLE'
    if (action === 'TOGGLE') action = relayState[relayId] === 'ON' ? 'OFF' : 'ON';
    await publishRelay(relayId, action, `טריגר-חיצוני: ${trigger.name}`);
    const durationMin = parseInt(trigger.durationMin, 10) || 0;
    if (durationMin > 0) {
      const timerId = `trig_${Date.now()}_${Math.round(Math.random()*1e6)}`;
      const startedAt = Date.now(), dueAt = startedAt + durationMin*60000;
      ivrPendingTimers.push({ id: timerId, relayId, revertAction: action==='ON'?'OFF':'ON',
        startedAt, dueAt, label: `${schedulerRelayNames[relayId]||relayId} (טריגר: ${trigger.name})`, callerId: null });
      saveConfigLocal();
    }
  } else if (trigger.actionType === 'program') {
    const p = schedulerPrograms.find(x => x.id === trigger.progId);
    if (p) {
      p.active = !!trigger.progActive;
      saveConfigLocal();
      io.emit('program_updated', { id: p.id, active: p.active });
    }
  } else if (trigger.actionType === 'mode') {
    const durationMin = (parseInt(trigger.modeDurationH, 10) || 0) * 60 + (parseInt(trigger.modeDurationM, 10) || 0);
    if (schedulerActiveModeId === trigger.modeId) {
      // כבר-במצב-היעד (למשל: כבר במצב-חופשה, ולוחצים-שוב על אותו-כפתור) — commitAutoModeSwitch
      // הייתה-ממילא-עושה no-op כאן, אז לא-קוראים-לה בכלל. אבל "למשך" עדיין-אמור-לפעול: לחיצה-חוזרת
      // "מרעננת" את זמן-החזרה לעוד duration-מעכשיו — **לא** ל-revert-לעצמו (זה היה הבאג: prevModeId
      // נתפס **אחרי** שכבר-היינו-שם, אז יצא revertToMode=trigger.modeId, מחיקת-כל-טיימר-לגיטימי-קודם
      // ובלי-שום-תחליף-אמיתי — המערכת הייתה-נשארת-תקועה-לצמיתות).
      if (durationMin > 0) {
        if (_pendingRevertInfo && _pendingRevertInfo.modeJustSetTo === trigger.modeId) {
          // יש כבר-שרשרת-חזרה-פעילה לאותו-מצב — משתמשים ב-revertToMode **שלה** (המצב-האמיתי-
          // המקורי, מלפני-כל-הכניסות-החוזרות-האלה), לא במצב-הנוכחי. זה נותן "עוד duration מעכשיו,
          // חוזר-בסוף לאותו-מקום-אמיתי" — בדיוק ההתנהגות שהתבקשה.
          armPendingRevertTimer(_pendingRevertInfo.revertToMode, trigger.modeId, Date.now() + durationMin * 60000);
          addServerLog({ type: 'info', msg: `🔘 [טריגר] "${trigger.name}" — כבר במצב ${trigger.modeId}, זמן-החזרה רוענן (עוד ${durationMin} דק', יחזור למצב ${_pendingRevertInfo.revertToMode})`, user: 'מערכת' });
        } else {
          // נכנסנו-למצב-הזה בלי-הגבלת-זמן (permanent) — אין שום "מצב-אמיתי-לחזור-אליו" ידוע, אז
          // בכוונה **לא** יוצרים טיימר-מטעה (revert-לעצמו). המצב נשאר-קבוע כפי-שהיה מלכתחילה.
          addServerLog({ type: 'info', msg: `🔘 [טריגר] "${trigger.name}" — כבר במצב ${trigger.modeId} (ללא-הגבלת-זמן) — אין מצב-קודם-ידוע, לא נוצר טיימר-חזרה`, user: 'מערכת' });
        }
      }
    } else {
      const prevModeId = schedulerActiveModeId; // חייבים-לתפוס-לפני-המעבר, כדי-לדעת-לאן-לחזור
      await commitAutoModeSwitch(trigger.modeId, `טריגר-חיצוני: ${trigger.name}`);
      if (durationMin > 0) {
        // אותו-מנגנון-בדיוק כמו תזמון-מצב-עם-"למשך" (armPendingRevertTimer) — כולל שרידות-מלאה
        // אחרי קריסה/הפעלה-מחדש, בזכות אותו התיקון שכבר בנינו ל-runBootReconciliation.
        armPendingRevertTimer(prevModeId, trigger.modeId, Date.now() + durationMin * 60000);
      }
    }
  }
}

// ── USERS ────────────────────────────────────────────────
const USERS = config.USERS || [];
const EMERGENCY_PASSWORD = config.EMERGENCY_PASSWORD || null;
function publicProfile(u) { const { password, ...pub } = u; return pub; }
let runtimeUsers = USERS.map(u => ({ ...u }));
let serverConfig = null;

// ── רשת-ביטחון: תמיד חייב להתקיים משתמש אחד לפחות ─────────
// בלי משתמשים המערכת נעולה לחלוטין: מסך-הכניסה מציג רשימה-נפתחת של משתמשים, ורשימה ריקה
// לא מאפשרת לבחור כלום. גם סיסמת-החירום לא עוזרת, כי היא נכנסת *בשמו* של משתמש-אדמין קיים.
// זה יכול לקרות אם ריצה קודמת עלתה בלי CONFIG_JSON ושמרה config.json עם users ריק.
// כאן משחזרים את משתמש-האדמין מהגדרות התוסף, ואם גם הן חסרות — יוצרים אחד עם admin_password
// כברירת-מחדל, כדי שתמיד תהיה דרך חזרה פנימה.
function ensureAdminUser() {
  if (runtimeUsers.length) return;
  const seed = (config.USERS && config.USERS.length)
    ? config.USERS
    : [{
        name: 'admin',
        role: 'admin',
        password: EMERGENCY_PASSWORD || 'changeme',
        relays: Array.from({ length: 64 }, (_, i) => i + 1),
      }];
  runtimeUsers = seed.map(u => ({ ...u }));
  const source = (config.USERS && config.USERS.length) ? 'הגדרות התוסף' : 'ברירת-מחדל (admin/admin_password)';
  console.log(`🔐 לא נמצא אף משתמש — שוחזר "${runtimeUsers[0].name}" מתוך ${source}`);
  saveConfigLocal();
}

// ── SERVER LOG ───────────────────────────────────────────
const serverLog = [];
const MAX_LOG_DAYS = 30;
function pruneLog() {
  const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
  while (serverLog.length && new Date(serverLog[serverLog.length-1].ts).getTime() < cutoff) serverLog.pop();
}
// ── LOGGER ───────────────────────────────────────────────
const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
function _ts() {
  return new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
console.log = (...a) => _origLog(`[${_ts()}]`, ...a);
console.error = (...a) => _origError(`[${_ts()}] ❌`, ...a);
console.warn = (...a) => _origWarn(`[${_ts()}] ⚠️`, ...a);

function addServerLog(entry, excludeSocket) {
  const now = new Date();
  const nowIL = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const logEntry = { ...entry, ts: now.toISOString(),
    time: nowIL.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: nowIL.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }),
  };
  serverLog.unshift(logEntry);
  pruneLog();
  // אם excludeSocket סופק (למשל: הרשומה הזו כבר קיימת מקומית אצל השולח, כי הוא הוסיף אותה בעצמו
  // לפני ששלח לשרת) — משדרים לכולם *חוץ* מהשולח, כדי לא ל"החזיר לו הד" של הרשומה שכבר יש לו.
  (excludeSocket ? excludeSocket.broadcast : io).emit('log_broadcast', serverLog[0]);
  // שיקוף ליומן ה-Add-on לאירועים חשובים
  if (['sent','warning','danger','info'].includes(entry.type)) {
    _origLog(`[${logEntry.time}] ${entry.type.toUpperCase()}: ${entry.msg}`);
  }
}

// ── SOCKET.IO ────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('🖥️ ממשק התחבר');
  // **חייב להישלח ראשון**: הממשק בונה את רשימת הממסרים שלו מהאירוע הזה. all_states
  // ו-controller_status שאחריו מתייחסים לממסרים לפי מזהה, ואם הרשימה עוד ריקה הם
  // פשוט נופלים לרצפה ומצב ההדלקה ההתחלתי לא מוצג.
  socket.emit('relay_config', buildRelayConfig());
  socket.emit('mqtt_status', { connected: mqttConnected });
  socket.emit('all_states', relayState);
  CONTROLLERS.forEach(ctrl => {
    socket.emit('controller_status', { online: controllerOnline[ctrl.id] || false, controller: ctrl.name, controllerId: ctrl.id });
  });
  if (serverConfig) socket.emit('server_config', serverConfig);
  if (serverLog.length) socket.emit('server_log', serverLog);
  socket.emit('ivr_today_events', ivrTodayEvents);
  // שלח רשימת התקני HA
  socket.emit('ha_devices', haDevices);
  socket.emit('ha_settings', { haUrl, hasToken: !!haToken });
  socket.emit('scheduled_modes', scheduledModes);
  socket.emit('external_triggers', externalTriggers);
  // **חלק מאותו תיקון**: מודיעים ללקוח-שמתחבר-כרגע מהו המצב-האמיתי-בפועל (לא סתם מקווים שהוא
  // "כבר יודע" מ-localStorage מקומי, שיכול להיות ישן-משבוע-שעבר). בלי זה, גם אחרי שתיקנו שהשרת
  // לא-ידרס-את-עצמו, הלקוח היה ממשיך-להציג/להשתמש בערך-הישן-שלו לנצח, כי שום דבר לא-היה-מתקן אותו.
  socket.emit('mode_changed', { newModeId: schedulerActiveModeId, label: 'סנכרון עם חיבור לשרת' });
  // זמנים הלכתיים אמיתיים של היום — מאותו מקור-אמת שהשרת עצמו משתמש בו לתזמון בפועל.
  // הממשק משתמש בזה כדי לחשב מיקום נכון בציר-הזמן לתוכניות מבוססות-זמן-הלכתי,
  // במקום קבוע קשיח (ראו תיקון getProgMinutes בצד הלקוח).
  socket.emit('zmanim_today', getZmanim(new Date(debugNow().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }))));
  // מידע על טיימר-חזרה ממתין (אם יש) — כדי שלקוח שנטען באמצע הספירה-לאחור יראה מיד את המידע הנכון
  socket.emit('pending_mode_revert', _pendingRevertInfo);
  // סימוני-בנייה (ראו הסבר ליד IDX_TOP_MARK) — כדי שהלקוח יוכל להציג את שלמות-שני-הקבצים יחד
  socket.emit('server_build_marks', { top: IDX_TOP_MARK, bottom: IDX_BOTTOM_MARK });

  // ── Login ──
  socket.on('login', ({ name, password }) => {
    if (EMERGENCY_PASSWORD && password === EMERGENCY_PASSWORD) {
      // ensureAdminUser מבטיח שיש כאן משתמש, אבל publicProfile(undefined) זורק שגיאה —
      // ובמסלול-החירום דווקא, שהוא הרשת-האחרונה, קריסה שקטה היא הדבר הגרוע ביותר.
      ensureAdminUser();
      const adminUser = runtimeUsers.find(u => u.role === 'admin') || runtimeUsers[0];
      socket.emit('login_result', { success: true, user: publicProfile(adminUser) });
      socket.emit('server_log', serverLog);
      return;
    }
    const user = runtimeUsers.find(u => u.name === name);
    if (!user) { socket.emit('login_result', { success: false }); return; }
    const isHash = user.password?.startsWith('$2b$') || user.password?.startsWith('$2a$');
    const valid = isHash ? bcrypt.compareSync(password, user.password) : password === user.password;
    if (valid) {
      if (!isHash) { user.password = bcrypt.hashSync(password, 10); saveConfigLocal(); }
      addServerLog({ type: 'info', msg: `כניסה למערכת: ${user.name}`, user: user.name });
      socket.emit('login_result', { success: true, user: publicProfile(user) });
      socket.emit('server_log', serverLog);
    } else {
      socket.emit('login_result', { success: false });
    }
  });

  socket.on('get_users', () => { socket.emit('users_list', runtimeUsers.map(u => publicProfile(u))); });

  socket.on('relay_command', async ({ id, state }) => {
    try {
      if (id === 'all') {
        const allIds = [...Object.keys(schedulerRelayNames).map(Number)];
        for (const i of allIds) await publishRelay(i, state);
      } else {
        await publishRelay(parseInt(id), state);
      }
    } catch(err) { console.error('❌', err.message); }
  });

  // טיימר-ידני מהיר (כפתור "⏱ טיימר" בטאב ממסרים) — רץ **בשרת**, לא ב-setTimeout של הדפדפן.
  // בלי זה, סגירת/רענון הדפדפן, או המחשב/טלפון שנרדם, היה מוחק את הכיבוי-המתוזמן לצמיתות
  // והממסר היה נשאר דלוק ללא הגבלה. משתמש באותו מנגנון בדיוק כמו טיימרי-IVR (ivrPendingTimers),
  // ששורד גם Stop→Start של ה-Add-on עצמו (נשמר ל-config.json).
  socket.on('quick_timer', async ({ relayId, minutes, userName }) => {
    const relayName = schedulerRelayNames[relayId] || `ממסר ${relayId}`;
    const m = parseInt(minutes, 10);
    if (!relayId || isNaN(m) || m <= 0) return;
    try {
      await publishRelay(relayId, 'ON', 'טיימר ידני');
      const timerId = `manual_${Date.now()}_${Math.round(Math.random()*1e6)}`;
      const startedAt = Date.now(), dueAt = startedAt + m * 60000;
      ivrPendingTimers.push({ id: timerId, relayId, revertAction: 'OFF', startedAt, dueAt, label: `${relayName} (טיימר ידני)`, callerId: null });
      ivrTodayEvents.push({ id: timerId, relayId, callerId: null, startedAt, dueAt, action: 'ON', dateKey: new Date(startedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) });
      saveConfigLocal();
      io.emit('ivr_today_events', ivrTodayEvents);
      addServerLog({ type: 'info', msg: `⏱️ טיימר ידני: ${relayName} → ON, יחזור אוטומטית בעוד ${m} דקות`, user: userName || 'משתמש' });
    } catch (err) {
      addServerLog({ type: 'danger', msg: `❌ טיימר ידני נכשל: ${relayName} — ${err.message}`, user: 'שרת' });
    }
  });

  // ── HA התקנים ──
  // שמירת הגדרות HA (token + URL)
  socket.on('save_ha_settings', async ({ token, url }) => {
    if (token !== undefined) haToken = token;
    if (url) haUrl = url;
    saveConfigLocal();
    socket.emit('ha_settings', { haUrl, hasToken: !!haToken });
    socket.emit('ha_save_status', { ok: true, msg: 'הגדרות HA נשמרו ✅' });
    console.log('💾 הגדרות HA נשמרו');
  });

  // רענון רשימת התקנים מ-HA
  socket.on('fetch_ha_devices', async () => {
    try {
      socket.emit('ha_fetch_status', { stage: 'fetching', msg: 'מושך התקנים מ-Home Assistant...' });
      const states = await haFetchAllStates();
      socket.emit('ha_fetch_status', { stage: 'done', msg: `נמצאו ${states.length} התקנים ✅` });
      socket.emit('ha_available_devices', states);
    } catch(e) {
      socket.emit('ha_fetch_status', { stage: 'error', msg: 'שגיאה: ' + e.message });
    }
  });

  // הוספת/עדכון התקני HA שנבחרו
  socket.on('save_ha_devices', (selectedDevices) => {
    const tasmotaMax = CONTROLLERS.reduce((s, c) => s + c.relayCount, 0);

    // בנה מפה של entity_id → relayId קיים (סנן null/NaN)
    const existingRelayIds = {};
    haDevices.forEach(d => {
      if (d.entity_id && d.relayId && !isNaN(d.relayId)) {
        existingRelayIds[d.entity_id] = d.relayId;
      }
    });

    // פונקציה למציאת relayId חופשי — בטוחה מפני NaN ולולאה אינסופית
    function findNextRelayId() {
      const usedIds = new Set([
        ...Object.values(existingRelayIds).filter(id => id && !isNaN(id)),
        ...haDevices.filter(d => d.relayId && !isNaN(d.relayId)).map(d => d.relayId)
      ]);
      let nextId = Math.max(tasmotaMax, 14) + 1; // לפחות 15
      while (usedIds.has(nextId)) nextId++;
      return nextId;
    }

    // עדכן רשימה — שמור relayId קיים או הקצה חדש
    haDevices = selectedDevices.map(dev => {
      if (existingRelayIds[dev.entity_id]) {
        return { ...dev, relayId: existingRelayIds[dev.entity_id] };
      } else {
        const nextId = findNextRelayId();
        existingRelayIds[dev.entity_id] = nextId; // עדכן למניעת כפילות
        console.log(`🔧 הוקצה relayId ${nextId} ל-${dev.entity_id}`);
        return { ...dev, relayId: nextId };
      }
    });

    rebuildHaRelayNames();
    saveConfigLocal();
    io.emit('ha_devices', haDevices);
    io.emit('relay_names_update', Object.entries(schedulerRelayNames).map(([id, name]) => ({ id: Number(id), name })));
    socket.emit('ha_save_status', { ok: true, msg: `${haDevices.length} התקנים נשמרו ✅` });
    console.log(`🏠 נשמרו ${haDevices.length} התקני HA: ${haDevices.map(d => `${d.entity_id}→${d.relayId}`).join(', ')}`);
    console.log(`🏠 נשמרו ${haDevices.length} התקני HA`);
  });

  // עדכון מצב חי של התקני HA
  socket.on('refresh_ha_states', async () => {
    try {
      for (const dev of haDevices) {
        if (!dev.relayId) continue;
        try {
          const st = await haGetState(dev.entity_id);
          const newState = haStateIsOn(dev.domain, st.state) ? 'ON' : 'OFF';
          relayState[dev.relayId] = newState;
          io.emit('relay_state', { id: dev.relayId, state: newState });
        } catch(e) { /* התקן לא זמין */ }
      }
    } catch(e) { console.error('שגיאה בעדכון מצב HA:', e.message); }
  });

  // ── Debug: מצב-בעלות-ממסרים בפועל (קריאה-בלבד, לא נוגע/משנה שום דבר) ──
  // מיועד לבדיקה מהקונסול: socket.emit('debug_get_relay_owner'); socket.once('debug_get_relay_owner_result', console.log);
  socket.on('debug_get_relay_owner', () => {
    const owners = {};
    Object.keys(relayOwner).forEach(relayIdStr => {
      const relayId = parseInt(relayIdStr, 10);
      const o = relayOwner[relayId];
      const p = schedulerPrograms.find(x => String(x.id) === String(o.progId));
      owners[relayId] = {
        relayName: schedulerRelayNames[relayId] || `ממסר ${relayId}`,
        progId: o.progId, progName: o.name, priority: !!o.priority,
        endSec: o.endSec,
        programStillExists: !!p,
        programModeIds: p ? (p.modeIds ?? (p.modeId !== null && p.modeId !== undefined ? [p.modeId] : [0])) : null,
        programActive: p ? !!p.active : null,
        programIsChild: p ? !!p.parentProgId : null,
      };
    });
    socket.emit('debug_get_relay_owner_result', {
      schedulerActiveModeId,
      relayOwnerCount: Object.keys(relayOwner).length,
      owners,
    });
  });

  // ── Debug: מה אמור להיות דלוק *עכשיו* ומכוח איזו תוכנית — מחושב עצמאית, לא תלוי ב-relayOwner
  // בכלל (משתמשת ב-computeTodayEvents האמיתית, "האחרון-כרונולוגית-מנצח", בדיוק כמו getRelayStateAtTime
  // בלקוח). קריאה-בלבד, לא נוגעת/משנה שום דבר.
  // בקונסול: socket.emit('debug_get_expected_state'); socket.once('debug_get_expected_state_result', console.log);
  socket.on('debug_get_expected_state', () => {
    const now = debugNow();
    const nowIL = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const nowSec = getNowSecIL();
    const dayStartMs = new Date(nowIL.getFullYear(), nowIL.getMonth(), nowIL.getDate()).getTime();
    const nowMs = dayStartMs + nowSec*1000;

    const todayKey = nowIL.toDateString();
    const zmanimToday = getZmanim(nowIL);
    const eventsToday = computeTodayEvents(nowIL, zmanimToday, nowIL.getDay(), todayKey)
      .map(e => ({ ...e, _epochMs: dayStartMs + e.fireSec*1000 }));

    const yIL = new Date(nowIL); yIL.setDate(yIL.getDate()-1);
    const yDayStartMs = new Date(yIL.getFullYear(), yIL.getMonth(), yIL.getDate()).getTime();
    const yKey = yIL.toDateString();
    const zmanimY = getZmanim(yIL);
    const eventsYesterday = computeTodayEvents(yIL, zmanimY, yIL.getDay(), yKey)
      .map(e => ({ ...e, _epochMs: yDayStartMs + e.fireSec*1000 }));

    const allEvents = [...eventsYesterday, ...eventsToday].filter(e => e._epochMs <= nowMs);
    const byRelay = {};
    allEvents.forEach(e => { if (!byRelay[e.relayId]) byRelay[e.relayId] = []; byRelay[e.relayId].push(e); });

    const result = {};
    Object.keys(byRelay).forEach(relayIdStr => {
      const relayId = parseInt(relayIdStr, 10);
      const evs = byRelay[relayIdStr].sort((a,b) => a._epochMs - b._epochMs);
      const last = evs[evs.length-1];
      result[relayId] = {
        relayName: schedulerRelayNames[relayId] || `ממסר ${relayId}`,
        expectedState: last.action,
        progId: last.progId, progName: last.name,
        firedAt: new Date(last._epochMs).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }),
        segType: last.segType, isEndEvent: !!last.isEndEvent,
        hasRegisteredOwner: !!relayOwner[relayId],
      };
    });
    socket.emit('debug_get_expected_state_result', { now: nowIL.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }), schedulerActiveModeId, expected: result });
  });

  // ── Sync Programs ──
  socket.on('sync_programs', ({ programs, activeModeId, relayNames, modes: incomingModes, fullConfig }) => {
    const newIds = new Set((programs || []).map(p => String(p.id)));
    Array.from(_firedToday).forEach(k => { const progId = k.split('_')[0]; if (!newIds.has(progId)) _firedToday.delete(k); });
    schedulerPrograms = programs || [];
    // **תיקון-קריטי**: לעולם לא לוקחים את schedulerActiveModeId מהלקוח! זה גרם לבאג-חמור-בשקט:
    // דפדפן עם localStorage-ישן (למשל טאב-שנשאר-פתוח-מלפני-שבת, כשהמצב היה עדיין 0) שולח את
    // הערך-הישן-שלו-בעצמו כל פעם שהוא מתחבר/מסתנכרן — והשרת "צייתן" דרס איתו את המצב-האמיתי-
    // הנוכחי שלו (למשל 2, אחרי מעבר-מצב לגיטימי), **בלי שום לוג**, כי זו הקצאה-ישירה, לא קריאה
    // ל-commitAutoModeSwitch (שכן-הייתה-רושמת את זה). זה בדיוק מה שקרה במוצאי-שבת: המצב-האמיתי
    // (2, תקוע בגלל הבאג-האחר) "התחלף" בשקט ל-0 **ברגע-החיבור-של-הממשק**, לא בגלל שום תזמון-
    // אמיתי. schedulerActiveModeId הוא state בבעלות-בלעדית-של-השרת — נטען מ-config בעלייה
    // (loadConfigLocal), ומשתנה **רק** דרך commitAutoModeSwitch/confirm_mode_switch (ששניהם
    // כן רושמים ליומן, ועושים גם את שאר-הפעולות-הנלוות כמו כיבוי-ממסרים-לא-רלוונטיים).
    if (relayNames) relayNames.forEach(r => { schedulerRelayNames[r.id] = r.name; schedulerRelayIvr[r.id] = !!r.ivr; });
    if (incomingModes) modes = incomingModes;
    if (fullConfig) serverConfig = fullConfig;
    socket.emit('sync_ack', { count: schedulerPrograms.length, firedRunOnceToday: Array.from(_firedRunOnceToday.values()) });
    saveConfigLocal();
  });

  // ── Mode Switch ──
  // הערה: computeModeSwitchImpact הוסרה מכאן (הייתה מוגדרת כפול, זהה ל-computeModeSwitchImpactGlobal
  // שבסקופ המודול) — כדי שכל תיקון עתידי לא ייאלץ להתבצע פעמיים בשתי עותקים זהים.
  // שני ה-handlers למטה משתמשים כעת ישירות ב-computeModeSwitchImpactGlobal.

  socket.on('request_mode_switch', ({ newModeId }) => {
    socket.emit('mode_switch_review', { newModeId, ...computeModeSwitchImpactGlobal(newModeId) });
  });

  socket.on('confirm_mode_switch', async ({ newModeId, turnOffRelayIds, activateProgIds }) => {
    schedulerActiveModeId = newModeId;
    saveConfigLocal();
    // **אותו-מנגנון-בדיוק כמו commitAutoModeSwitch**: תור-אחד-משולב-ורציף — קודם כל הכיבויים,
    // ורק-אחרי-שכולם-הסתיימו-בפועל — ההדלקות. לפני-התיקון כאן היה .forEach() רגיל, בלי-שום-פיזור-
    // זמן בכלל — כל הפקודות (כיבויים והדלקות כאחד) יצאו ממש-באותו-רגע.
    const _catchupTodayKey = new Date(debugNow().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).toDateString();
    const offItems = (turnOffRelayIds || []).map(relayId => ({ kind: 'off', relayId }));
    let onItems = [];
    if ((activateProgIds || []).length) {
      const impact = computeModeSwitchImpactGlobal(newModeId);
      onItems = activateProgIds.flatMap(progId =>
        impact.missedPrograms.filter(m => String(m.progId) === String(progId)).map(m => ({ kind: 'on', ...m })));
    }
    await runSequential([...offItems, ...onItems], async item => {
      if (item.kind === 'off') {
        await publishRelay(item.relayId, 'OFF');
        if (relayOwner[item.relayId]) delete relayOwner[item.relayId];
        io.emit('scheduler_fired', { progName: 'כיבוי — מעבר מצב ידני', relayId: item.relayId, action: 'OFF' });
      } else {
        await publishRelay(item.relayId, 'ON');
        relayOwner[item.relayId] = { progId: item.progId, name: item.progName, priority: item.isPriority, endSec: item.endSec };
        io.emit('scheduler_fired', { progName: item.progName, relayId: item.relayId, action: 'ON' });
        // אותו תיקון כמו במעבר האוטומטי — למנוע דילוג שקט על הכיבוי-לפי-משך העתידי
        if (item.fireSec !== undefined) _actuallyFired.add(`${item.progId}_${item.relayId}_${item.segType}_${item.cycleIdx??'x'}_${item.fireSec}_start_${_catchupTodayKey}`);
        // תוכנית runOnce שהופעלה כהשלמה — יש לכבות את הדגל בדיוק כמו בירייה רגילה, אחרת היא עלולה לירות שוב במחזור עתידי
        if (item.runOnce) {
          const p = schedulerPrograms.find(x => x.id === item.progId);
          if (p && p.active) {
            p.active = false;
            _firedRunOnceToday.set(p.id, { ...p, _todayKey: _catchupTodayKey });
            io.emit('program_updated', { id: p.id, active: false });
            saveConfigLocal();
          }
        }
      }
    });
  });

  // ── Users ──
  socket.on('save_users', (users) => {
    runtimeUsers = users.map(u => {
      const existing = runtimeUsers.find(r => r.name === u.name);
      if (!u.password) return { ...u, password: existing?.password || '' };
      const isHash = u.password.startsWith('$2b$') || u.password.startsWith('$2a$');
      if (isHash) return u;
      return { ...u, password: bcrypt.hashSync(u.password, 10) };
    });
    io.emit('users_list', runtimeUsers.map(u => publicProfile(u)));
    saveConfigLocal();
  });

  // ── IVR Users ──
  socket.on('get_ivr_users', () => { socket.emit('ivr_users_list', buildIvrUsersList()); });

  socket.on('save_ivr_users', async (users) => {
    try {
      const newPhoneMap = {};
      const newPermissions = {};
      (users || []).forEach(u => {
        if (!u.phone || !u.id) return;
        newPhoneMap[u.phone] = u.id;
        newPermissions[u.id] = {
          name: u.name, isAdmin: !!u.isAdmin, priority: !!u.priority,
          allowedRelays: u.isAdmin ? [] : (u.allowedRelays || []),
          allowedActions: u.isAdmin ? ['ON','OFF'] : (u.allowedActions || []),
          maxDurationMinOn: u.isAdmin ? 0 : (u.maxDurationMinOn ?? 0),
          maxDurationMinOff: u.isAdmin ? 0 : (u.maxDurationMinOff ?? 0),
        };
      });
      yemotPhoneMap = newPhoneMap;
      yemotPermissions = newPermissions;
      saveConfigLocal();
      io.emit('ivr_users_list', buildIvrUsersList());
      socket.emit('ivr_save_status', { stage: 'done', msg: 'נשמר בהצלחה ✅' });
    } catch(e) {
      socket.emit('ivr_save_status', { stage: 'error', msg: 'שגיאה: ' + e.message });
    }
  });

  // ── Yemot Files ──
  socket.on('get_yemot_file', async ({ ext, filename } = {}) => {
    try {
      const content = await yemotDownloadFile(`ivr/${ext}/${filename}`);
      socket.emit('yemot_file_content', { ok: true, content });
    } catch(e) { socket.emit('yemot_file_content', { ok: false, error: e.message }); }
  });

  socket.on('save_yemot_file', async ({ ext, filename, content } = {}) => {
    try {
      await yemotUploadFile(`ivr/${ext}/${filename}`, content || '', filename);
      socket.emit('yemot_save_status', { stage: 'done', msg: 'נשמר בהצלחה ✅' });
    } catch(e) { socket.emit('yemot_save_status', { stage: 'error', msg: 'שגיאה: ' + e.message }); }
  });

  socket.on('get_yemot_autoupdate_preview', ({ kind } = {}) => {
    try { socket.emit('yemot_autoupdate_preview', { ok: true, ...buildYemotAutoFiles(kind) }); }
    catch(e) { socket.emit('yemot_autoupdate_preview', { ok: false, error: e.message }); }
  });

  socket.on('run_yemot_autoupdate', async ({ ext, kind } = {}) => {
    try {
      const { tts000, tts001, tts002, extIni } = buildYemotAutoFiles(kind);
      await yemotUploadFile(`ivr/${ext}/000.tts`, tts000, '000.tts');
      await yemotUploadFile(`ivr/${ext}/001.tts`, tts001, '001.tts');
      if (tts002 !== undefined) await yemotUploadFile(`ivr/${ext}/002.tts`, tts002, '002.tts');
      await yemotUploadFile(`ivr/${ext}/ext.ini`, extIni, 'ext.ini');
      socket.emit('yemot_autoupdate_status', { stage: 'done', msg: 'עודכן בהצלחה ✅' });
    } catch(e) { socket.emit('yemot_autoupdate_status', { stage: 'error', msg: 'שגיאה: ' + e.message }); }
  });

  socket.on('sync_yemot_whitelist', async () => {
    try {
      const templateId = await yemotGetWhitelistTemplateId();
      const entries = await yemotGetTemplateEntries(templateId);
      const existingPhones = new Set(entries.map(e => normalizePhoneDigits(e.phone)));
      const blockedPhones = new Set(entries.filter(e => e.blocked).map(e => normalizePhoneDigits(e.phone)));
      let added = 0, alreadyThere = 0;
      const blockedList = [], failedList = [];
      for (const phone of Object.keys(yemotPhoneMap)) {
        const norm = normalizePhoneDigits(phone);
        if (blockedPhones.has(norm)) { blockedList.push(phone); continue; }
        if (existingPhones.has(norm)) { alreadyThere++; continue; }
        try { await yemotAddPhoneToWhitelist(templateId, phone); added++; }
        catch(e) { failedList.push(phone); }
      }
      let msg = `${added} נוספו, ${alreadyThere} כבר ברשימה`;
      if (blockedList.length) msg += `, ⚠️ ${blockedList.length} חסומים`;
      socket.emit('yemot_whitelist_status', { stage: 'done', msg });
    } catch(e) { socket.emit('yemot_whitelist_status', { stage: 'error', msg: 'שגיאה: ' + e.message }); }
  });

  // הרשומה כבר קיימת מקומית אצל השולח (הוא הוסיף אותה בעצמו לפני השליחה) — לכן משדרים רק לכל השאר,
  // לא בחזרה אליו. בלי זה, הדפדפן שביצע את הפעולה ראה את הרשומה שלו כפולה (מקומי + הד מהשרת).
  socket.on('log_entry', (entry) => { addServerLog(entry, socket); });

  // ── תזמוני מצב ──
  // ── סימולציית-תזמון (בדיקה, לא נוגעת במצב אמיתי) ──
  socket.on('simulate_schedule', ({ fromDateStr, toDateStr, simModeId } = {}) => {
    try {
      const report = simulateScheduleRange(fromDateStr, toDateStr, simModeId);
      socket.emit('simulate_schedule_result', { ok: true, events: report });
    } catch(e) {
      socket.emit('simulate_schedule_result', { ok: false, error: e.message });
    }
  });

  socket.on('get_scheduled_modes', () => {
    socket.emit('scheduled_modes', scheduledModes);
  });

  socket.on('save_scheduled_modes', (modes) => {
    scheduledModes = modes || [];
    saveConfigLocal();
    io.emit('scheduled_modes', scheduledModes);
    socket.emit('scheduled_modes_saved', { ok: true, count: scheduledModes.length });
    addServerLog({ type: 'info', msg: `🕐 נשמרו ${scheduledModes.length} תזמוני מצב`, user: 'מערכת' });
  });

  // ── טריגרים-חיצוניים (כפתורי-קיר/מתגי-סצנה zigbee) ──────────────────
  socket.on('save_external_triggers', (triggers) => {
    externalTriggers = triggers || [];
    saveConfigLocal();
    io.emit('external_triggers', externalTriggers);
    socket.emit('external_triggers_saved', { ok: true, count: externalTriggers.length });
    addServerLog({ type: 'info', msg: `🔘 נשמרו ${externalTriggers.length} טריגרים-חיצוניים`, user: 'מערכת' });
  });

  // מצב-לימוד: מאזינים ל-10 השניות-הבאות להודעת-zigbee2mqtt כלשהי (המשתמש אמור ללחוץ
  // על הכפתור-הפיזי בזמן-הזה), ומדווחים בחזרה מה נתפס (או "לא-נתפס-כלום" בתום הזמן).
  socket.on('start_trigger_learn_mode', () => {
    _triggerLearnModeActive = true;
    clearTimeout(_triggerLearnModeTimeout);
    addServerLog({ type: 'info', msg: '🎧 מצב-לימוד-טריגר הופעל — לחץ על הכפתור-הפיזי עכשיו (10 שניות)', user: 'מערכת' });
    _triggerLearnModeTimeout = setTimeout(() => {
      if (_triggerLearnModeActive) {
        _triggerLearnModeActive = false;
        io.emit('trigger_learn_timeout');
        addServerLog({ type: 'warning', msg: '⏱️ מצב-לימוד-טריגר הסתיים — לא נתפסה שום הודעה', user: 'מערכת' });
      }
    }, 10000);
  });

  socket.on('disconnect', () => { console.log('🖥️ ממשק התנתק'); });
});

// ── SCHEDULER ENGINE (זהה לגרסה המקורית) ───────────────
// ימים/חגים שבהם מלאכה אסורה — קובע מתי הדלקת נרות/הבדלה רלוונטיים.
// מבוסס על אימות ישיר של calendar_data.js בפועל (36,524 רשומות, 2026-2125):
// שדה 'יום' מכיל שמות ימים בעברית ('שבת' וכו'), ושדה 'חג/אירוע' מתייג כל יום בנפרד —
// כולל חגים דו-יומיים (וידאתי בפועל: ראש השנה מתויג "ראש השנה" בשני התאריכים ברצף,
// לא רק ביום הראשון) — ולכן מספיק לבדוק את היום עצמו + מחר, בלי טיפול מיוחד לחג דו-יומי.
// 'חול המועד פסח/סוכות' אינם ברשימה בכוונה (אסור-מלאכה לא חל עליהם).
const ASSUR_MELACHA_HOLIDAYS = new Set(['פסח', 'פסח (שביעי)', 'שבועות', 'ראש השנה', 'יום כיפור', 'סוכות', 'שמחת תורה']);
// מיפוי יום-בחודש-העברי למספר 1-30 — אומת מול קובץ הלוח המלא (36,524 רשומות) בלי שגיאה אחת.
// נדרש לזיהוי "ראש חודש" (calType: rosh_chodesh_aleph/rosh_chodesh_lamed).
const HEB_DAY_MAP = {
  "א'":1, "ב'":2, "ג'":3, "ד'":4, "ה'":5, "ו'":6, "ז'":7, "ח'":8, "ט'":9, "י'":10,
  'י"א':11, 'י"ב':12, 'י"ג':13, 'י"ד':14, 'ט"ו':15, 'ט"ז':16, 'י"ז':17, 'י"ח':18, 'י"ט':19, "כ'":20,
  'כ"א':21, 'כ"ב':22, 'כ"ג':23, 'כ"ד':24, 'כ"ה':25, 'כ"ו':26, 'כ"ז':27, 'כ"ח':28, 'כ"ט':29, "ל'":30
};
function getHebrewDayNumber(entry){
  if(!entry || !entry['תאריך עברי']) return null;
  const dayPart = entry['תאריך עברי'].split(' ')[0];
  return HEB_DAY_MAP[dayPart] ?? null;
}
function isAssurMelachaEntry(entry) {
  if (!entry) return false;
  if (entry['יום'] === 'שבת') return true;
  return ASSUR_MELACHA_HOLIDAYS.has(entry['חג/אירוע']);
}
function getZmanim(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const entry = _calendarIndex[`${dd}/${mm}/${yyyy}`];
  if (!entry) return {};
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tEntry = _calendarIndex[`${String(tomorrow.getDate()).padStart(2, '0')}/${String(tomorrow.getMonth() + 1).padStart(2, '0')}/${tomorrow.getFullYear()}`];
  // הדלקת נרות: היום הוא ערב של יום אסור-מלאכה (מחר אסור-מלאכה).
  // הבדלה/צאת שבת: היום עצמו אסור-מלאכה, ומחר כבר לא (סוף הרצף — לא באמצע חג דו-יומי).
  const candlesOk = isAssurMelachaEntry(tEntry);
  const havdalahOk = isAssurMelachaEntry(entry) && !isAssurMelachaEntry(tEntry);
  // חצות = בדיוק אמצע הזמן בין נץ החמה לשקיעה (לא קיים כשדה בקובץ הלוח, מחושב)
  const sunriseMin = timeStrToMinutes(entry['נץ החמה']);
  const sunsetMin = timeStrToMinutes(entry['שקיעה']);
  const chatzotStr = (sunriseMin !== null && sunsetMin !== null)
    ? `${String(Math.floor(Math.round((sunriseMin + sunsetMin) / 2) / 60)).padStart(2, '0')}:${String(Math.round((sunriseMin + sunsetMin) / 2) % 60).padStart(2, '0')}`
    : null;
  // הדלקת נרות: אין שדה ייעודי בקובץ הלוח — קבוע 22 דקות לפני השקיעה של אותו יום (לא זמן-השקיעה עצמו!)
  const candlesStr = (candlesOk && sunsetMin !== null)
    ? `${String(Math.floor((sunsetMin - 22 + 1440) % 1440 / 60)).padStart(2, '0')}:${String((sunsetMin - 22 + 1440) % 1440 % 60).padStart(2, '0')}`
    : null;
  return {
    sunrise: entry['נץ החמה'], sunset: entry['שקיעה'],
    candles: candlesStr,
    havdalah: havdalahOk ? entry['מוצאי שבת'] : null,
    tzeit: entry['צאת הכוכבים'],
    alotHaShachar: entry['עלות השחר'], minchaGedola: entry['מנחה גדולה'], rabeinuTam: entry['רבינו תם'],
    chatzot: chatzotStr,
  };
}
function zmanimKeyForZman(zman) {
  return { sunset:'sunset',sunrise:'sunrise',candles:'candles',havdalah:'havdalah',tzeit:'tzeit',dawn:'alotHaShachar',alot_hashachar:'alotHaShachar',chatzot:'chatzot',mincha:'minchaGedola',rabeinuTam:'rabeinuTam' }[zman] || zman;
}
function timeStrToMinutes(t) { if (!t) return null; const [h,m]=t.split(':').map(Number); return h*60+m; }
function getProgMinutes(p, zmanim) {
  if (p.type === 'time') { const [h,m]=p.time.split(':').map(Number); return h*60+m; }
  const base = timeStrToMinutes(zmanim[zmanimKeyForZman(p.zman)]);
  if (base === null) return -1;
  return base + (p.offsetDir==='-'?-1:1)*(p.offsetVal||0);
}
function getRelayFireMin(p, baseMin, relayId) {
  const ri=(p.relay||[]).indexOf(relayId); const idx=ri<0?0:ri;
  return baseMin + idx*(p.delay||0)/60;
}
function getRelayEndMin(p, fireMin) {
  if (!p.durationOn || (!(p.durationH||p.durationM))) return null;
  return fireMin + (p.durationH||0)*60 + (p.durationM||0);
}
function getRelayEventPairs(p, baseMin, relayId) {
  const start=getRelayFireMin(p,baseMin,relayId);
  const totalEnd=getRelayEndMin(p,start);
  if (totalEnd===null) return [{fireMin:start,endMin:null,action:p.action,segType:'single'}];
  // "פעולה מחזורית" (לא הפוך, כמו מחזורי-הפסקה — חוזרת על **אותה** פעולה שוב-ושוב) — משתמשת-חוזרת
  // באותו שדה cycleOnMin (בתור "כל כמה דקות לחזור"), אבל היא בלעדית מול cycleOn הרגיל (ה-UI כבר
  // אוכף את זה, אבל בודקים explicit כאן גם-כן ליתר-ביטחון). כל "פולס" הוא ירי-עצמאי-ללא-סגירה-
  // עצמו (endMin:null) — אין כאן שום "היפוך", רק חזרה-מחדש-על-אותה-הפקודה, למקרה שמישהו שינה-
  // ידנית באמצע; הפעולה-הבאה-בתור פשוט תדרוס את זה שוב בעצמה, בלי צורך ב"אירוע-סיום" נפרד.
  if (p.repeatSameAction && p.cycleOnMin) {
    const interval = p.cycleOnMin;
    const pairs = [];
    let s = start, i = 0;
    while (s < totalEnd) { pairs.push({fireMin:s, endMin:null, action:p.action, segType:'single', cycleIdx:i}); s += interval; i++; }
    if (!pairs.length) return [{fireMin:start,endMin:totalEnd,action:p.action,segType:'single'}];
    return pairs;
  }
  if (!p.cycleOn||!p.cycleOnMin||!p.cycleOffMin) return [{fireMin:start,endMin:totalEnd,action:p.action,segType:'single'}];
  const onMin=p.cycleOnMin,offMin=p.cycleOffMin,cycleLen=onMin+offMin;
  const totalMin=totalEnd-start,fullCycles=Math.floor(totalMin/cycleLen);
  const pairs=[];
  for(let i=0;i<fullCycles;i++){const s=start+i*cycleLen;pairs.push({fireMin:s,endMin:s+onMin,action:p.action,segType:'on',cycleIdx:i});pairs.push({fireMin:s+onMin,endMin:s+cycleLen,action:p.action==='ON'?'OFF':'ON',segType:'off',cycleIdx:i});}
  // שארית חלקית אחרי המחזורים המלאים — לא לזרוק אותה! בלי זה, כל משך שלא מתחלק בול במחזור נעלם
  // בשקט (למשל 4/2 למשך 10 דק' — המחזור השני מעולם לא ירה בפועל).
  // חשוב: אם השארית היא ON-בלבד (אין אחריה OFF, כי היא מסתיימת עם סוף התוכנית עצמו) — היא חייבת
  // segType:'single' (לא 'on'), כי רק 'single' מקבל כיבוי-אוטומטי-בתום-משך; 'on'/'off' לעולם לא נסגרים
  // לבד (הם נסגרים ע"י הקטע הבא בתור, וכאן אין קטע הבא).
  const remainder = totalMin - fullCycles*cycleLen;
  if (remainder > 0) {
    const s = start + fullCycles*cycleLen;
    const onPart = Math.min(remainder, onMin);
    if (remainder > onMin) {
      pairs.push({fireMin:s,endMin:s+onPart,action:p.action,segType:'on',cycleIdx:fullCycles});
      pairs.push({fireMin:s+onPart,endMin:s+remainder,action:p.action==='ON'?'OFF':'ON',segType:'off',cycleIdx:fullCycles});
    } else {
      pairs.push({fireMin:s,endMin:s+onPart,action:p.action,segType:'single',cycleIdx:fullCycles});
    }
  }
  if(!pairs.length) return [{fireMin:start,endMin:totalEnd,action:p.action,segType:'single'}];
  return pairs;
}
const CHILD_BUFFER_MIN=0.5;

// כשמנגנון-השלמה (מעבר-מצב, תוכניות-שהוחמצו, boot-reconciliation) צריך לשלוח כמה פקודות-ממסר
// "בבת אחת" — לא לשלוח את כולן באותו רגע ממש. ברירת-מחדל: 5 שניות בין פקודה לפקודה, כדי למנוע
// עומס-פתאומי על הבקר/MQTT broker (וסיכון-אמיתי לכשל אם הרבה ממסרים מנסים לפעול בו-זמנית).
const RELAY_COMMAND_STAGGER_MS = 5000;
function runStaggered(items, fn, delayMs = RELAY_COMMAND_STAGGER_MS) {
  (items || []).forEach((item, idx) => { setTimeout(() => fn(item, idx), idx * delayMs); });
}

// **תור-אמיתי-רציף**: בניגוד ל-runStaggered (שמתזמן כל פריט בנפרד לפי idx*delayMs — כלומר אם
// קוראים לה פעמיים-במקביל, שתי הקריאות "מתחרות" זו-בזו ופקודות-מהן-השתיים יכולות לצאת באותו-
// רגע-ממש), הפונקציה הזו מבטיחה **בוודאות מוחלטת** שאף שתי-פקודות לא-יוצאות-בו-זמנית: כל פריט
// ממתין (await) לסיום-המלא-בפועל של הפריט-הקודם (כולל הפרסום-ל-MQTT וכל תופעות-הלוואי שלו) ורק-
// אז מוסיפים את ה-delay לפני הפריט-הבא. אם fn נכשלת על פריט מסוים, ממשיכים הלאה לפריט-הבא (לא-
// עוצרים את כל-התור בגלל פריט-אחד-שנכשל) — אבל התור-עצמו נשאר תמיד רציף-לחלוטין.
async function runSequential(items, fn, delayMs = RELAY_COMMAND_STAGGER_MS) {
  for (let i = 0; i < (items || []).length; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    try { await fn(items[i], i); }
    catch (e) { console.error('❌ שגיאה בתור-פקודות-רציף:', e.message); }
  }
}

function getChildEventPairs(child,parent,parentBaseMin){
  if(!parent) return [];
  const parentRelay=(parent.relay||[])[0];
  const offSegs=getRelayEventPairs(parent,parentBaseMin,parentRelay).filter(s=>s.segType==='off');
  if(!offSegs.length) return [];
  const offsetMin=child.childOffsetMin??child.offsetMin??0;
  const timing=child.childTiming??child.timing??'before';
  const confine=child.childConfine??child.confine??false;
  return offSegs.map((seg,idx)=>{
    const breakStart=seg.fireMin,breakEnd=seg.endMin;
    const fireMin=timing==='before'?(breakStart-offsetMin):(breakStart+offsetMin);
    let endMin=null;
    if(confine&&breakEnd!==null) endMin=Math.max(fireMin,breakEnd-CHILD_BUFFER_MIN);
    return {fireMin,endMin,action:child.action,segType:'child',cycleIdx:idx,breakStart,breakEnd};
  });
}

// מקבילה-שרתית ל-getRunOnceTargetDateKey שכבר קיימת בלקוח: מוצאת את "התאריך-היעד" של תוכנית
// חד-פעמית — התאריך **הראשון מהיום-האמיתי** (לא מהתאריך-שנסרק כרגע!) שמתאים ל-days/calType שלה.
// קריטי לסימולטור: בלי זה, computeTodayEvents לא בדק בכלל אם תאריך-עתידי-שנסרק הוא באמת התאריך
// שבו התוכנית-החד-פעמית אמורה לירות — היא הייתה "יורה" בכל תאריך-עתידי-מתאים (כל יום-בשבוע התואם),
// למרות שבפועל תוכנית חד-פעמית יורה **פעם אחת בלבד**, בתאריך-היעד-הקרוב-ביותר-מעכשיו, ואז מדביקה
// את עצמה (active=false). ב"זמן-אמת" זה לא היה בעיה (ה-active flag כבר דואג לזה בפועל אחרי שהיא
// יורה) — הבעיה חשופה **רק** כשסורקים תאריך-עתידי לפני שהתאריך-האמיתי-הזה כבר הגיע.
const _runOnceDateCacheServer = {};
let _lastRunOnceCacheDay = null;
function getRunOnceTargetDateKeyServer(p) {
  if (!p.runOnce) return null;
  if (_runOnceDateCacheServer[p.id] !== undefined) return _runOnceDateCacheServer[p.id];
  if (!p.active) { _runOnceDateCacheServer[p.id] = null; return null; }
  const hasDays = p.days && p.days.length > 0;
  const realToday = new Date(debugNow().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  realToday.setHours(0,0,0,0);
  for (let d = 0; d < 8; d++) {
    const cand = new Date(realToday); cand.setDate(cand.getDate()+d);
    const di = cand.getDay();
    if (hasDays && !p.days.includes(di)) continue;
    if (p.calType && p.calType !== 'none') {
      const dd = cand.getDate(), mm = cand.getMonth()+1, yyyy = cand.getFullYear();
      const entry = _calendarIndex[`${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}`];
      if (p.calType === 'annual') { if (dd !== p.calDay || mm !== p.calMonth) continue; }
      else if (p.calType === 'once') { if (dd !== p.calDay || mm !== p.calMonth || yyyy !== p.calYear) continue; }
      else if (p.calType === 'rosh_chodesh_aleph') { if (getHebrewDayNumber(entry) !== 1) continue; }
      else if (p.calType === 'rosh_chodesh_lamed') { if (getHebrewDayNumber(entry) !== 30) continue; }
    }
    const key = cand.toDateString();
    _runOnceDateCacheServer[p.id] = key;
    return key;
  }
  _runOnceDateCacheServer[p.id] = null;
  return null;
}

function computeTodayEvents(nowIL,zmanim,dow,todayKey){
  const events=[];
  const progsById={};
  schedulerPrograms.forEach(p=>progsById[p.id]=p);
  for(const p of schedulerPrograms){
    const runOnceStillOwedToday=p.runOnce&&_firedRunOnceToday.has(p.id)&&_firedRunOnceToday.get(p.id)._todayKey===todayKey;
    if(!p.active&&!runOnceStillOwedToday) continue;
    if(p.parentProgId) continue;
    // תוכנית חד-פעמית: נכללת **רק** בתאריך-היעד-האמיתי-הראשון-מעכשיו — לא בכל תאריך-מתאים-אחר
    // (ראו הסבר מעל getRunOnceTargetDateKeyServer). תוכנית שכבר "הושלמה היום" (runOnceStillOwedToday)
    // ממשיכה להיכלל כרגיל, ללא קשר לבדיקה הזו — היא כבר עברה את זה בפועל.
    if(p.runOnce && !runOnceStillOwedToday){
      const targetKey = getRunOnceTargetDateKeyServer(p);
      if(!targetKey || targetKey !== todayKey) continue;
    }
    const modeIds=p.modeIds??(p.modeId!==null&&p.modeId!==undefined?[p.modeId]:[0]);
    if(!modeIds.includes(schedulerActiveModeId)) continue;
    if(p.days?.length&&!p.days.includes(dow)) continue;
    if(p.calType&&p.calType!=='none'){
      const dd=nowIL.getDate(),mm=nowIL.getMonth()+1,yyyy=nowIL.getFullYear();
      if(p.calType==='annual'){if(dd!==p.calDay||mm!==p.calMonth)continue;}
      else if(p.calType==='once'){if(dd!==p.calDay||mm!==p.calMonth||yyyy!==p.calYear)continue;}
      else if(p.calType==='rosh_chodesh_aleph'){
        const entry=_calendarIndex[`${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}`];
        if(getHebrewDayNumber(entry)!==1) continue;
      }
      else if(p.calType==='rosh_chodesh_lamed'){
        const entry=_calendarIndex[`${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}`];
        if(getHebrewDayNumber(entry)!==30) continue;
      }
    }
    const baseMin=getProgMinutes(p,zmanim);
    if(baseMin<0) continue;
    (p.relay||[]).forEach(relayId=>{
      const pairs=getRelayEventPairs(p,baseMin,relayId);
      pairs.forEach((seg,idx)=>{
        events.push({progId:p.id,name:p.name,relayId,fireSec:Math.round(seg.fireMin*60),endSec:seg.endMin!==null?Math.round(seg.endMin*60):null,action:seg.action,segType:seg.segType,cycleIdx:seg.cycleIdx,isLastSeg:idx===pairs.length-1,runOnce:p.runOnce,isPriority:!!p.priority});
        if(seg.endMin!==null&&seg.segType==='single'){
          events.push({progId:p.id,name:p.name,relayId,fireSec:Math.round(seg.endMin*60),endSec:null,action:seg.action==='ON'?'OFF':'ON',segType:seg.segType,cycleIdx:seg.cycleIdx,isLastSeg:idx===pairs.length-1,runOnce:false,isPriority:!!p.priority,isEndEvent:true,runOnceCleanup:!!p.runOnce,startFireSec:Math.round(seg.fireMin*60)});
        }
      });
      if(p.childProgId){
        const child=progsById[p.childProgId];
        if(child&&child.active){
          const childPairs=getChildEventPairs(child,p,baseMin);
          childPairs.forEach(seg=>{
            events.push({progId:child.id,name:child.name,relayId:(child.relay||[])[0],fireSec:Math.round(seg.fireMin*60),endSec:seg.endMin!==null?Math.round(seg.endMin*60):null,action:seg.action,segType:'child',cycleIdx:seg.cycleIdx,requireAck:!!(child.childRequireAck??child.requireAck),ackRelayId:relayId,ackExpected:seg.action==='ON'?'OFF':'ON',isPriority:!!child.priority});
            if(seg.endMin!==null){events.push({progId:child.id,name:child.name,relayId:(child.relay||[])[0],fireSec:Math.round(seg.endMin*60),endSec:null,action:seg.action==='ON'?'OFF':'ON',segType:'child',cycleIdx:seg.cycleIdx,isEndEvent:true,runOnce:false,isPriority:!!child.priority,startFireSec:Math.round(seg.fireMin*60)});}
          });
        }
      }
    });
  }
  return events;
}

function getNowSecIL(){const n=new Date(debugNow().toLocaleString('en-US',{timeZone:'Asia/Jerusalem'}));return n.getHours()*3600+n.getMinutes()*60+n.getSeconds();}

function checkAckAndFireChild(event,todayKey){
  const expected=event.ackExpected;
  const pending=_pendingPublish[event.ackRelayId];
  if(pending){
    pending
      .then(()=>checkAckAndFireChildNow(event,todayKey,expected))
      .catch(()=>checkAckAndFireChildNow(event,todayKey,expected));
  } else {
    checkAckAndFireChildNow(event,todayKey,expected);
  }
}

function checkAckAndFireChildNow(event,todayKey,expected){
  const actual=relayState[event.ackRelayId];
  if(actual===expected){fireEvent(event,todayKey);return;}
  setTimeout(()=>{
    if(event.endSec!==null&&getNowSecIL()>event.endSec) return;
    if(relayState[event.ackRelayId]===expected) fireEvent(event,todayKey);
  },60000);
}

function checkRelayOwnerBlock(event,nowSec){
  const owner=relayOwner[event.relayId];
  if(!owner) return false;
  if(owner.progId===event.progId) return false;
  if(owner.endSec!==null&&owner.endSec<=nowSec){delete relayOwner[event.relayId];return false;}
  if(event.isPriority) return false;
  if(owner.priority){if(owner.endSec===null)return false;return{blockedBy:owner.name};}
  if(owner.endSec===null) return false;
  if(owner.endSec>event.fireSec) return{blockedBy:owner.name};
  return false;
}

// גרסה מבודדת לסימולציה — אותה לוגיקה בדיוק כמו checkRelayOwnerBlock, אבל על מפת-בעלות מבודדת
// (לא נוגעת ב-relayOwner האמיתי), כדי שהסימולציה לא תשפיע על המצב האמיתי בשום צורה.
function checkRelayOwnerBlockSim(simOwner,event,nowSec){
  const owner=simOwner[event.relayId];
  if(!owner) return false;
  if(owner.progId===event.progId) return false;
  if(owner.endSec!==null&&owner.endSec<=nowSec){delete simOwner[event.relayId];return false;}
  if(event.isPriority) return false;
  if(owner.priority){if(owner.endSec===null)return false;return{blockedBy:owner.name};}
  if(owner.endSec===null) return false;
  if(owner.endSec>event.fireSec) return{blockedBy:owner.name};
  return false;
}

// מחשבת את מקטעי-המצב הצפויים על-פני טווח-זמן — משתמשת **באותה בדיוק** computeScheduledModeFireEpoch
// שכבר בנויה, מאומתת, ומשמשת את runBootReconciliation. לא נכתבה כאן שום לוגיקת-חישוב-זמנים חדשה —
// רק "הליכה" על ציר-הזמן, בדיוק כמו computeModeSegments בלקוח (ואותו עיקרון-עיצוב: להשתמש
// בפונקציות-החישוב-האמיתיות, כדי שאין סיכוי לפער בין מה-שהסימולטור-מראה למה-שבאמת-יקרה).
function computeModeTimeline(rangeStartMs, rangeEndMs, startModeId) {
  const timeline = [];
  for (let d = new Date(rangeStartMs); d.getTime() <= rangeEndMs; d.setDate(d.getDate()+1)) {
    const dateIL = israelCalendarDayStart(d.getTime());
    for (const sm of scheduledModes) {
      const epochSelf = computeScheduledModeFireEpoch(sm, dateIL);
      if (epochSelf === null) continue;
      const epoch = toTrueEpoch(epochSelf, dateIL);
      if (epoch >= rangeStartMs && epoch < rangeEndMs) {
        timeline.push({ epochMs: epoch, toModeId: sm.toModeId, sm });
      }
    }
  }
  timeline.sort((a,b) => a.epochMs - b.epochMs);

  // אם יש טיימר-חזרה-ממתין-בפועל (persisted) שרלוונטי לטווח — הוא הטרנזיציה-הראשונה-שתקרה
  let pendingRevert = _pendingRevertInfo;
  let mode = startModeId;
  let segStart = rangeStartMs;
  const segments = [];
  const pushSeg = (endMs) => { if (endMs > segStart) { segments.push({ startMs: segStart, endMs, modeId: mode }); segStart = endMs; } };

  for (const t of timeline) {
    if (pendingRevert && pendingRevert.revertAtEpochMs <= t.epochMs && pendingRevert.revertAtEpochMs > rangeStartMs) {
      if (mode === pendingRevert.modeJustSetTo) { pushSeg(pendingRevert.revertAtEpochMs); mode = pendingRevert.revertToMode; }
      pendingRevert = null;
    }
    pushSeg(t.epochMs);
    const prevMode = mode;
    mode = t.toModeId;
    pendingRevert = t.sm.durationOn
      ? { revertToMode: prevMode, modeJustSetTo: t.toModeId, revertAtEpochMs: t.epochMs + ((t.sm.durationH||0)*3600+(t.sm.durationM||0)*60)*1000 }
      : null;
  }
  if (pendingRevert && pendingRevert.revertAtEpochMs <= rangeEndMs && pendingRevert.revertAtEpochMs > rangeStartMs) {
    if (mode === pendingRevert.modeJustSetTo) { pushSeg(pendingRevert.revertAtEpochMs); mode = pendingRevert.revertToMode; }
  }
  pushSeg(rangeEndMs);
  return segments;
}

// ═══ סימולציית-תזמון לצורך בדיקה ═══════════════════════════════════════════════
// מריצה "יבש" (בלי לשלוח שום פקודה אמיתית, בלי לגעת במצב-האמת) את כל התוכניות הפעילות
// על פני טווח-תאריכים נבחר — כולל מחזורים, תוכניות-בת, אירועים-חוצי-חצות, וחסימות-בעלות-ממסר —
// ומחזירה רשימה כרונולוגית של "מה היה קורה ומתי". בדיוק הכלי שהיה חסר לנו כדי לבדוק חציית-חצות
// ומחזורים בלי לחכות לזמן האמיתי.
function simulateScheduleRange(fromDateStr, toDateStr, simModeId){
  const [fy,fm,fd] = fromDateStr.split('-').map(Number);
  const [ty,tm,td] = toDateStr.split('-').map(Number);
  const fromDate = new Date(fy, fm-1, fd, 0,0,0,0);
  const toDateExclusive = new Date(ty, tm-1, td+1, 0,0,0,0); // עד סוף היום האחרון (לא כולל)
  if (isNaN(fromDate.getTime())||isNaN(toDateExclusive.getTime())) throw new Error('תאריך לא תקין');
  if (toDateExclusive <= fromDate) throw new Error('טווח לא תקין ("עד" לפני "מ")');
  const rangeSec = (toDateExclusive.getTime() - fromDate.getTime())/1000;
  if (rangeSec > 32*86400) throw new Error('טווח ארוך מדי (מקסימום 31 ימים)');
  const rangeDays = Math.ceil(rangeSec/86400);

  // ברירת-מחדל (simModeId לא סופק בכלל): מדמים את **המצבים-שבאמת-יקרו**, כולל כל מעברי-המצב
  // המתוזמנים בטווח (computeModeTimeline) — לא מצב-קבוע-אחד לאורך כל הטווח. זה משקף את מה שבאמת
  // יקרה בפועל, כולל הפקודות-שיתבצעו-בזמן-ואחרי-כל-מעבר. אם simModeId **כן** סופק במפורש — זו
  // בקשה מפורשת ל"מה-היה-קורה-אילו-נשארנו-תמיד-במצב-הזה" (שימושי לבדיקת-תוכניות-של-מצב-ספציפי
  // בבידוד) — במקרה הזה שומרים על ההתנהגות הישנה (מצב-קבוע-לאורך-כל-הטווח).
  const scanLookbackStart = fromDate.getTime() - 86400000; // יום אחד לפני, לתפוס אירועים-חוצי-חצות
  const scanRangeEnd = toDateExclusive.getTime();
  const forcedConstantMode = (simModeId !== undefined && simModeId !== null);
  const modeSegments = forcedConstantMode
    ? [{ startMs: scanLookbackStart, endMs: scanRangeEnd, modeId: simModeId }]
    : computeModeTimeline(scanLookbackStart, scanRangeEnd, schedulerActiveModeId);

  const modeTransitionReportEntries = [];
  if (!forcedConstantMode && modeSegments.length > 1) {
    // מדלגים על המקטע-הראשון (הוא לא "מעבר", זה המצב-שכבר-היה-פעיל מלכתחילה) — כל שאר תחילות-
    // המקטעים הן מעברי-מצב אמיתיים שיקרו בתוך הטווח, ומוסיפים אותם לדוח כדי שיראו "מה ומתי".
    for (let i = 1; i < modeSegments.length; i++) {
      const seg = modeSegments[i];
      if (seg.startMs < fromDate.getTime() || seg.startMs >= scanRangeEnd) continue; // מחוץ לטווח-המבוקש-להצגה (רק ה-lookback)
      modeTransitionReportEntries.push({ epochMs: seg.startMs, toModeId: seg.modeId });
    }
  }

  const savedMode = schedulerActiveModeId;
  const allEvents = [];
  try {
    // סורקים גם יום אחד לפני הטווח, כדי לתפוס אירועים-חוצי-חצות שנכנסים לתוך הטווח
    for (let d = -1; d <= rangeDays; d++) {
      const scanDate = new Date(fromDate.getTime() + d*86400000);
      const dayStartMs = scanDate.getTime();
      const dow = scanDate.getDay();
      const dateKey = scanDate.toDateString();
      const zmanim = getZmanim(scanDate);
      // מוצאים את כל מקטעי-המצב שחופפים את היום הזה — יום יחיד עשוי לחצות מעבר-מצב (למשל ליל-שישי),
      // ולכן ייתכן שצריך לחשב את אותו יום פעמיים, פעם לכל מצב, ולסנן כל אירוע לפי המקטע-שבאמת-חל
      // ברגע-ההדלקה-שלו (בדיוק עיקרון-ה"בדיקה-לפי-תא" שכבר הוכח נכון בתצוגת-הלקוח).
      const dayEndMs = dayStartMs + 86400000;
      const overlappingSegs = modeSegments.filter(seg => seg.startMs < dayEndMs && seg.endMs > dayStartMs);
      const segsToUse = overlappingSegs.length ? overlappingSegs : [{ startMs: dayStartMs, endMs: dayEndMs, modeId: schedulerActiveModeId }];
      segsToUse.forEach(seg => {
        schedulerActiveModeId = seg.modeId;
        const events = computeTodayEvents(scanDate, zmanim, dow, dateKey);
        events.forEach(ev => {
          const epochMs = dayStartMs + ev.fireSec*1000;
          if (epochMs < seg.startMs || epochMs >= seg.endMs) return; // שייך למקטע-מצב אחר של אותו יום
          const secSinceStart = d*86400 + ev.fireSec;
          if (secSinceStart < 0 || secSinceStart >= rangeSec) return;
          const endSecSinceStart = ev.endSec !== null ? d*86400 + ev.endSec : null;
          allEvents.push({ ...ev, secSinceStart, endSecSinceStart, sourceDayKey: dateKey, scanDate: new Date(scanDate) });
        });
      });
    }
  } finally {
    schedulerActiveModeId = savedMode; // תמיד משחזרים, גם אם קרתה שגיאה
  }
  allEvents.sort((a,b) => a.secSinceStart - b.secSinceStart);

  const simOwner = {};
  const report = [];
  const seenKeys = new Set();
  const HEB_DOW = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  // בונים את מחרוזת-התצוגה ישירות מהמספרים המוכרים כבר (יום, שעה, דקה, שנייה) — בלי לעבור דרך
  // new Date(epoch).toLocaleString(...) עם timeZone, כי זה מניח בטעות שה-epoch כבר "לא-מתוקן" (כלומר
  // בנוי לפי אזור-הזמן של מכונת-השרת עצמה, לא בהכרח ישראל) ומתקן אותו פעם נוספת — הזזה כפולה בדיוק
  // כמו הבאג שכבר תפסנו בצד-הלקוח. scanDate (הבנוי מ-y,m-1,d מספריים) כבר "נכון" בעצמו לכל מטרה כאן.
  const fmtTime = (dayDate, secWithinDay) => {
    const h = Math.floor(secWithinDay/3600), mi = Math.floor((secWithinDay%3600)/60), s = Math.floor(secWithinDay%60);
    const dow = HEB_DOW[dayDate.getDay()];
    const dd = String(dayDate.getDate()).padStart(2,'0'), mm = String(dayDate.getMonth()+1).padStart(2,'0');
    return `${dow}, ${dd}.${mm}, ${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };

  // ממזגים את אירועי-התוכניות ואת מעברי-המצב לרשימה כרונולוגית **אחת**, לפי אותו בסיס-זמן
  // (secSinceStart, יחסית ל-fromDate) — כדי שהדוח יראה בדיוק "מה קורה ומתי", כולל המעברים עצמם.
  const modeMerged = modeTransitionReportEntries.map(m => ({
    _isModeTransition: true,
    secSinceStart: (m.epochMs - fromDate.getTime())/1000,
    toModeId: m.toModeId,
  }));
  const timeline = [...allEvents.map(ev => ({ _isModeTransition: false, ev, secSinceStart: ev.secSinceStart })), ...modeMerged]
    .sort((a,b) => a.secSinceStart - b.secSinceStart);

  for (const item of timeline) {
    if (item._isModeTransition) {
      const d = Math.floor(item.secSinceStart/86400);
      const secWithinDay = item.secSinceStart - d*86400;
      const dispDate = new Date(fromDate.getTime() + d*86400000);
      const transitionMs = fromDate.getTime() + item.secSinceStart*1000;
      report.push({ time: fmtTime(dispDate, secWithinDay), prog: `🔄 מעבר-מצב מתוזמן`, relay: '—', action: `מצב ${item.toModeId}`, blocked: false, note: 'מעבר-מצב', isModeTransition: true });

      // מדמים בדיוק את מה ש-commitAutoModeSwitch עושה בפועל בכל מעבר-מצב אמיתי — **אותה** פונקציה
      // (computeModeSwitchImpactGlobal), רק עם "עכשיו" ו"מפת-בעלות" מדומים (רגע-המעבר-בסימולציה,
      // ו-simOwner שכבר נבנה מהאירועים-שקדמו-לו בציר), לא הזמן/הבעלות-האמיתיים. בלי זה, הסימולציה
      // לא הראתה את פקודות-הכיבוי-בכניסה-למצב ואת פקודות-ההשלמה-בחזרה — בדיוק מה שדיווחת.
      const impact = computeModeSwitchImpactGlobal(item.toModeId, { nowMs: transitionMs, ownerMap: simOwner });
      (impact.staleRelays || []).forEach(r => {
        delete simOwner[r.relayId];
        report.push({ time: fmtTime(dispDate, secWithinDay), prog: `כיבוי אוטומטי — יציאה ממצב (${r.ownerProgName || 'תוכנית קודמת'})`, relay: r.relayName, action: 'OFF', blocked: false, note: 'מעבר-מצב' });
      });
      (impact.missedPrograms || []).forEach(m => {
        simOwner[m.relayId] = { progId: m.progId, name: m.progName, priority: !!m.isPriority, endSec: m.endSec };
        report.push({ time: fmtTime(dispDate, secWithinDay), prog: m.progName, relay: m.relayName, action: 'ON', blocked: false, note: 'השלמה (מעבר-מצב)' });
      });
      continue;
    }
    const ev = item.ev;
    const key = `${ev.progId}_${ev.relayId}_${ev.segType}_${ev.cycleIdx??'x'}_${ev.fireSec}_${ev.isEndEvent?'end':'start'}_${ev.sourceDayKey}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const relayName = schedulerRelayNames[ev.relayId] || `ממסר ${ev.relayId}`;
    const simEvent = { relayId: ev.relayId, progId: ev.progId, isPriority: !!ev.isPriority, fireSec: ev.secSinceStart, endSec: ev.endSecSinceStart };
    let note = ev.isEndEvent ? 'סיום-לפי-משך' : ev.segType==='child' ? 'תוכנית-בת' : (ev.segType==='on'||ev.segType==='off') ? `מחזור #${ev.cycleIdx}` : '';
    const _dayAdvance = Math.floor(ev.fireSec/86400);
    const _dispDate = _dayAdvance>0 ? new Date(ev.scanDate.getTime()+_dayAdvance*86400000) : ev.scanDate;
    const _secWithinDay = ev.fireSec - _dayAdvance*86400;
    if (ev.action === 'OFF') {
      const blocked = checkRelayOwnerBlockSim(simOwner, simEvent, ev.secSinceStart);
      if (blocked) {
        report.push({ time: fmtTime(_dispDate,_secWithinDay), prog: ev.name, relay: relayName, action: 'OFF', blocked: true, note: `בוטל — ממסר בשליטת "${blocked.blockedBy}"` });
        continue;
      }
      if (simOwner[ev.relayId]) delete simOwner[ev.relayId];
    }
    report.push({ time: fmtTime(_dispDate,_secWithinDay), prog: ev.name, relay: relayName, action: ev.action, blocked: false, note });
    if (ev.action === 'ON') {
      simOwner[ev.relayId] = { progId: ev.progId, name: ev.name, priority: !!ev.isPriority, endSec: ev.endSecSinceStart };
    }
  }
  return report;
}

function fireEvent(event,todayKey){
  const{relayId,action,name}=event;
  // **תיקון-קריטי**: לפני, _actuallyFired הייתה מסומנת כאן — **לפני** נסיון-הפרסום בכלל, בלי-קשר-
  // להצלחה. אם ה-MQTT היה מנותק (למשל כבל-רשת שנותק זמנית) — publishRelay נכשל, אבל האירוע כבר-
  // סומן "בוצע-בפועל" — ולכן: (א) הכיבוי-הטבעי-לפי-משך (isEndEvent) שתלוי-בסימון-הזה לא-היה-מדלג
  // כמצופה (חושב שההתחלה-כן-קרתה), ו-(ב) שום-מנגנון לא-ניסה-שוב את-האירוע-הזה, כי הוא נחשב "טופל".
  // עכשיו: מסמנים **רק אחרי** שהפרסום-בפועל הצליח.
  const pub = publishRelay(relayId,action).then(()=>{
    if(!event.isEndEvent) _actuallyFired.add(`${event.progId}_${relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.fireSec}_start_${todayKey}`);
    io.emit('scheduler_fired',{progName:name,relayId,action});
    if(action==='ON'){
      const existing=relayOwner[relayId];
      const candidate={progId:event.progId,name,priority:!!event.isPriority,endSec:event.endSec};
      const existingExpired=existing&&existing.endSec!==null&&existing.endSec<=getNowSecIL();
      const existingIsStronger=existing&&!existingExpired&&existing.progId!==candidate.progId&&existing.endSec!==null&&((existing.priority&&!candidate.priority)||(!existing.priority&&!candidate.priority&&candidate.endSec!==null&&existing.endSec>candidate.endSec));
      if(!existingIsStronger) relayOwner[relayId]=candidate;
    } else if(relayOwner[relayId]){delete relayOwner[relayId];} // כל כיבוי שמגיע לכאן כבר עבר את checkRelayOwnerBlock (או שזו תוכנית הכיבוי של עצמה) — הממסר כבוי בפועל, אז אין יותר "בעלים", ללא קשר לאיזו תוכנית ביצעה את הכיבוי
    if(event.isEndEvent) addServerLog({type:'info',msg:`[למשך] "${name}" — ממסר ${relayId} → ${action}`,user:'מערכת'});
    else addServerLog({type:'info',msg:`[תזמון] "${name}" — ממסר ${relayId} → ${action}`,user:'מערכת'});
  }).catch(err=>{
    // תיקון: היה רק console.error (נראה רק ביומן-השרת עצמו, לעולם לא בממשק) — עכשיו נראה גם
    // ביומן-הראשי, כדי שכשל-פרסום (בעיקר MQTT-מנותק) לא-ייעלם בשקט-מוחלט.
    console.error(`❌ שגיאה ממסר ${relayId}:`,err.message);
    addServerLog({type:'danger',msg:`❌ נכשל שליחה: "${name}" — ממסר ${relayId} → ${action} (${err.message}) — יתוקן-אוטומטית כשה-MQTT יתחבר-מחדש`,user:'מערכת'});
  });
  _pendingPublish[relayId] = pub;
  return pub;
}

async function schedulerTick(){
  // רשת-הצלה: רושמים "עוד פעם אחת השרת בטוח היה פעיל" — **לפני** כל early-return, כדי שהפעימה
  // תשקף "השרת רץ" גם אם אין עדיין אף תוכנית מוגדרת. כתיבה זולה לקובץ-זעיר-נפרד (לא config.json).
  _lastTickAtEpochMs = Date.now();
  saveLastTick(_lastTickAtEpochMs);
  if(!schedulerPrograms.length) return;
  const now=debugNow();
  const nowIL=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Jerusalem'}));
  const nowSec=nowIL.getHours()*3600+nowIL.getMinutes()*60+nowIL.getSeconds();
  const todayKey=nowIL.toDateString();
  const dow=nowIL.getDay();
  // תיקון קריטי (אותה בעיה בדיוק שכבר תוקנה ל-_actuallyFired למטה, אבל נשכחה כאן): מפתח-אירוע-חוצה-
  // חצות (מהסריקה "אתמול", בהמשך) מסתיים ב-yKey (תאריך-אתמול), לא ב-todayKey! ניקוי שבודק רק
  // "מסתיים-ב-todayKey" היה מוחק אותו **מיד בטיק הבא** (5 שניות אחר-כך) — עוד לפני שהחלון-של-8-
  // השניות בכלל נגמר — מה שאיפשר לאותו אירוע-בדיוק לירות **פעמיים** (נתפס-נמחק-נתפס-שוב, בתוך
  // אותו חלון-תפיסה). זו הייתה הסיבה לכפילויות-מוזרות ב-5-שניות שנראו בפועל בלוג.
  const _yIL_prune=new Date(nowIL);_yIL_prune.setDate(_yIL_prune.getDate()-1);
  const _yesterdayKeyForPrune=_yIL_prune.toDateString();
  _firedToday.forEach(k=>{if(!k.endsWith(todayKey)&&!k.endsWith(_yesterdayKeyForPrune))_firedToday.delete(k);});
  // תיקון קריטי: לא למחוק _actuallyFired ברגע ש-02:00 עבר! תוכנית שה"התחלה" שלה הייתה אתמול, אבל
  // ה"סיום-לפי-משך" שלה חוצה הרבה יותר מ-2 שעות לתוך היום הבא (למשל 22:59+8.5שע=07:29 למחרת) —
  // הייתה "שוכחת" שהיא בכלל התחילה, ברגע שהשעון עבר 02:00, ולעולם לא מכבה את עצמה. שומרים גם את
  // מפתחות-אתמול (לא רק היום), ומוחקים רק דברים ישנים משני ימים.
  _actuallyFired.forEach(k=>{if(!k.endsWith(todayKey)&&!k.endsWith(_yesterdayKeyForPrune))_actuallyFired.delete(k);});
  // תיקון קריטי נוסף — **אותה בעיה בדיוק** (מפתח-חוצה-חצות נמחק מוקדם-מדי) קיימת גם כאן, ולא
  // תוקנה עד עכשיו: תוכנית runOnce עם "למשך" שחוצה חצות (למשל 22:00+5שע=03:00 למחרת) נרשמת
  // ל-_firedRunOnceToday עם _todayKey=אתמול. בטיק-הראשון-של-היום-החדש, todayKey כבר "היום", אז
  // הניקוי-הישן (שבדק רק p._todayKey!==todayKey) מחק אותה **לפני** שסריקת-האתמול-שבהמשך-הפונקציה
  // הספיקה להשתמש בה כדי לזהות "עדיין-חייבים-לכבות-את-זה" (runOnceStillOwedToday) — וכך הכיבוי-
  // הסופי-לפי-משך התבטל בשקט, והממסר נשאר דלוק לצמיתות. שומרים גם אתמול, בדיוק כמו למעלה.
  if(_firedRunOnceToday.size>0)_firedRunOnceToday.forEach((p,id)=>{if(p._todayKey!==todayKey&&p._todayKey!==_yesterdayKeyForPrune)_firedRunOnceToday.delete(id);});
  // ה-cache של getRunOnceTargetDateKeyServer מחשב "מהיום-האמיתי-קדימה" — צריך להתאפס בכל יום, אחרת
  // אחרי כמה ימים הוא ימשיך להחזיר תאריך-יעד שכבר עבר (מחושב-פעם-אחת מ"היום" הישן). בניגוד ללקוח
  // (שמתאפס ממילא בכל טעינת-דף), השרת רץ ברצף לאורך זמן, אז צריך איפוס-יזום.
  if (todayKey !== _lastRunOnceCacheDay) {
    Object.keys(_runOnceDateCacheServer).forEach(k => delete _runOnceDateCacheServer[k]);
    _lastRunOnceCacheDay = todayKey;
  }
  const zmanim=getZmanim(nowIL);
  const events=computeTodayEvents(nowIL,zmanim,dow,todayKey);
  const WINDOW_SEC=8;
  for(const event of events){
    if(event.fireSec<0||event.fireSec>=86400) continue;
    if(event.fireSec>nowSec||event.fireSec<nowSec-WINDOW_SEC) continue;
    const fireKey=`${event.progId}_${event.relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.fireSec}_${event.isEndEvent?'end':'start'}_${todayKey}`;
    if(_firedToday.has(fireKey)) continue;
    if(event.isEndEvent&&event.startFireSec!==undefined){
      const startKey=`${event.progId}_${event.relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.startFireSec}_start_${todayKey}`;
      if(!_actuallyFired.has(startKey)) continue;
    }
    if(event.action==='OFF'){
      const heldByOther=checkRelayOwnerBlock(event,nowSec);
      if(heldByOther){_firedToday.add(fireKey);addServerLog({type:'info',msg:`[תזמון] "${event.name}" — כיבוי בוטל, ממסר ${event.relayId} בשליטת "${heldByOther.blockedBy}"`,user:'מערכת'});continue;}
    }
    _firedToday.add(fireKey);
    if(event.runOnce&&(event.segType==='single'||event.segType==='on')){
      const p=schedulerPrograms.find(x=>x.id===event.progId);
      if(p&&p.active){p.active=false;_firedRunOnceToday.set(p.id,{...p,_todayKey:todayKey});io.emit('program_updated',{id:p.id,active:false});saveConfigLocal();}
    }
    if(event.isEndEvent){fireEvent(event,todayKey);if(event.runOnceCleanup)_firedRunOnceToday.delete(event.progId);continue;}
    if(event.segType==='child'&&event.requireAck) checkAckAndFireChild(event,todayKey);
    else fireEvent(event,todayKey);
  }
  // אירועים שחצו חצות מאתמול — כולל **גם** מחזורים רגילים (ON/OFF של cycleOn), לא רק את
  // הכיבוי-הסופי-לפי-משך (isEndEvent). התיקון הקודם כאן טיפל רק ב-isEndEvent, ולכן תוכנית-מחזור
  // שהמשכה חוצה חצות (למשל 21:59+8.5שע) הייתה "קופאת" בדיוק בחצות ולעולם לא חוזרת לפעול —
  // כל מחזור-ON שהיה אמור לירות אחרי חצות פשוט לא נבדק בכלל, כי הוא לא isEndEvent.
  // תיקון קריטי נוסף: הבדיקה הזו רצה תמיד (לא רק אם nowSec<7200/02:00) — תוכנית שחוצה הרבה יותר
  // מ-2 שעות לתוך היום הבא (למשל 22:59+8.5שע=07:29 למחרת) לא הייתה נבדקת בכלל, כי עד שמגיעים
  // לזמן-הכיבוי-האמיתי שלה, הבדיקה כבר הפסיקה לרוץ (עברו 2 השעות). זו הייתה הסיבה האמיתית
  // ש"מזגן הורים" (22:59 שישי + 8.5 שעות) מעולם לא כבה, והמשיך "לחסום" את התוכנית של אחה"צ שבת.
  {
    const yIL=new Date(nowIL);yIL.setDate(yIL.getDate()-1);
    const yKey=yIL.toDateString(),yDow=yIL.getDay(),yZman=getZmanim(yIL);
    const yEvts=computeTodayEvents(yIL,yZman,yDow,yKey);
    for(const event of yEvts){
      if(event.fireSec<=86400) continue; // רק אירועים שבאמת חוצים לתוך היום החדש
      const adj=event.fireSec-86400;
      if(adj>nowSec||adj<nowSec-WINDOW_SEC) continue;
      const fireKey=`${event.progId}_${event.relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.fireSec}_${event.isEndEvent?'end':'start'}_${yKey}`;
      if(_firedToday.has(fireKey)) continue;
      if(event.isEndEvent&&event.startFireSec!==undefined){
        const startKey=`${event.progId}_${event.relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.startFireSec}_start_${yKey}`;
        if(!_actuallyFired.has(startKey)) continue;
      }
      if(event.action==='OFF'){
        const heldByOther=checkRelayOwnerBlock(event,nowSec);
        if(heldByOther){_firedToday.add(fireKey);addServerLog({type:'info',msg:`[תזמון] "${event.name}" — כיבוי בוטל, ממסר ${event.relayId} בשליטת "${heldByOther.blockedBy}"`,user:'מערכת'});continue;}
      }
      _firedToday.add(fireKey);
      if(event.isEndEvent){fireEvent(event,yKey);if(event.runOnceCleanup)_firedRunOnceToday.delete(event.progId);continue;}
      if(event.segType==='child'&&event.requireAck) checkAckAndFireChild(event,yKey);
      else fireEvent(event,yKey);
    }
  }
}

async function processIvrPendingTimers(){
  const todayKeyIL=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Jerusalem'});
  if(ivrTodayEvents.some(e=>e.dateKey!==todayKeyIL)){ivrTodayEvents=ivrTodayEvents.filter(e=>e.dateKey===todayKeyIL);saveConfigLocal();}
  if(!ivrPendingTimers.length) return;
  const now=Date.now();
  const due=ivrPendingTimers.filter(t=>t.dueAt<=now);
  if(!due.length) return;
  ivrPendingTimers=ivrPendingTimers.filter(t=>t.dueAt>now);
  for(const t of due){
    try{
      await publishRelay(t.relayId,t.revertAction,`IVR — סיום משך, ID ${t.callerId}`);
      addServerLog({type:'info',msg:`📞 [IVR — סיום משך] ${t.label} → ${t.revertAction}`,user:'מערכת'});
      // ניקוי-בעלות: רק אם עדיין שייכת ל**אותה** רשומת-IVR-וירטואלית — לא למחוק בטעות בעלות של
      // תוכנית-אחרת שכבר תפסה את הממסר בינתיים (בדיוק עיקרון-הזהירות כמו ב-runOnceCleanup).
      const virtualOwnerId=`ivr_owner_${t.callerId}`;
      if(relayOwner[t.relayId]&&relayOwner[t.relayId].progId===virtualOwnerId) delete relayOwner[t.relayId];
    }
    catch(err){console.error('❌ שגיאה IVR timer:',err.message);}
  }
  saveConfigLocal();
}

// ── תזמוני מצב אוטומטיים ───────────────────────────────
const _firedScheduledModes = new Set(); // מונע ירי כפול באותו tick

// מגדיר טיימר-חזרה-אוטומטית לתזמון-מצב עם duration, וגם **שומר** את המידע ל-config.json (לא רק
// זיכרון+שידור-ללקוח כמו קודם) — כדי ששרת שקורס בדיוק תוך-כדי חלון-החזרה-הממתין ידע לשחזר את זה
// אחרי אתחול-מחדש (ראו runBootReconciliation), במקום לאבד את המידע לגמרי.
function armPendingRevertTimer(prevMode, modeJustSetTo, revertAtEpochMs) {
  if (_activeScheduledModeTimer) clearTimeout(_activeScheduledModeTimer);
  // **תיקון-קריטי**: אם כבר-יש טיימר-חזרה-ממתין, והוא שייך **לאותו-מצב** ש-prevMode מצביע-אליו
  // (כלומר: אנחנו עומדים-להיכנס-זמנית-למצב-חדש, אבל prevMode-הזה כבר-היה-לו-משלו טיימר-חזרה-
  // ממתין, מלפני-שהתזמון-הנוכחי-הפריע-לו) — שומרים אותו-בצד, כדי-לחמש-אותו-מחדש כשנחזור. בלי-זה:
  // מצב-B (למשל "לילה טוב") שמפריע-למצב-A-שכבר-פעיל-עם-"למשך"-משלו, היה-מוחק-לצמיתות את-טיימר-
  // החזרה-של-A — A נשאר-דלוק-לנצח (עד-התזמון-הבא-שלו), במקום-לחזור-בזמן-לפי-המשך-המקורי-שלו.
  if (_pendingRevertInfo && _pendingRevertInfo.modeJustSetTo === prevMode) {
    _savedPendingRevertsByMode[prevMode] = {
      revertToMode: _pendingRevertInfo.revertToMode,
      revertAtEpochMs: _pendingRevertInfo.revertAtEpochMs,
    };
  }
  const remainingMs = revertAtEpochMs - Date.now();
  _pendingRevertInfo = { revertToMode: prevMode, revertAtEpochMs, modeJustSetTo };
  io.emit('pending_mode_revert', _pendingRevertInfo);
  saveConfigLocal();
  if (remainingMs <= 0) {
    // הזמן כבר עבר (למשל טיימר ששוחזר אחרי קריסה, וגם הזמן-לחזרה כבר חלף בינתיים) — לבצע מיד.
    clearPendingRevertAndMaybeApply(prevMode, modeJustSetTo);
    return;
  }
  _activeScheduledModeTimer = setTimeout(() => {
    clearPendingRevertAndMaybeApply(prevMode, modeJustSetTo);
  }, remainingMs);
}
function clearPendingRevertAndMaybeApply(prevMode, modeJustSetTo) {
  _activeScheduledModeTimer = null;
  _pendingRevertInfo = null;
  io.emit('pending_mode_revert', null);
  saveConfigLocal();
  // הגנה מפני race condition: אם תזמון מצב אחר כבר החליף את המצב הפעיל בינתיים (למשל שני תזמונים
  // שחלים כמעט באותו רגע), אסור לטיימר החזרה "העיוור" הזה לדרוס את המצב הנוכחי בחזרה — רק אם
  // עדיין נמצאים באותו מצב שאליו עברנו במקור, מותר לחזור.
  if (schedulerActiveModeId !== modeJustSetTo) {
    addServerLog({ type: 'info', msg: `🕐 חזרה אוטומטית למצב ${prevMode} בוטלה — תזמון אחר כבר החליף את המצב בינתיים (נשארים במצב ${schedulerActiveModeId})`, user: 'מערכת' });
    return;
  }
  commitAutoModeSwitch(prevMode, `חזרה אוטומטית למצב ${prevMode}`);
  // אם ל-prevMode (המצב-שאנחנו-חוזרים-אליו-עכשיו) היה טיימר-חזרה-משלו ששמור-בצד (כי-הופרע-קודם
  // ע"י התזמון-שרק-עכשיו-הסתיים) — מחמשים אותו-מחדש עכשיו, כדי שהוא-ימשיך-מהמקום-שנעצר, במקום-
  // להיעלם-לצמיתות.
  const saved = _savedPendingRevertsByMode[prevMode];
  if (saved) {
    delete _savedPendingRevertsByMode[prevMode];
    armPendingRevertTimer(saved.revertToMode, prevMode, saved.revertAtEpochMs);
  }
}

async function _commitAutoModeSwitchInner(newModeId, label) {
  if (newModeId === schedulerActiveModeId) return;
  try {
    const nowMsForSwitch = debugNow().getTime();
    const impact = computeModeSwitchImpactGlobal(newModeId);
    schedulerActiveModeId = newModeId;
    saveConfigLocal();
    io.emit('mode_changed', { newModeId, label });
    addServerLog({ type: 'info', msg: `🕐 [תזמון מצב] עבר למצב ${newModeId} — ${label}`, user: 'מערכת' });

    // **תור-אחד-משותף-ורציף**: קודם כל הכיבויים-מהמצב-הישן (staleRelays), ורק-אחרי-שכולם-הסתיימו-
    // בפועל — ההדלקות של-המצב-החדש (missedPrograms). לא שני runStaggered נפרדים-שרצים-במקביל
    // (הבעיה-שהייתה: כל אחד מתזמן-בעצמו לפי idx*5000, כך ששתי-הקריאות "מתחרות" ופקודות משתיהן
    // יכולות לצאת ממש-באותו-רגע) — עכשיו זה תור-יחיד-אמיתי, פריט-אחרי-פריט, בלי-שום-חפיפה.
    const _catchupTodayKey = new Date(debugNow().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).toDateString();
    const combinedQueue = [
      ...impact.staleRelays.map(r => ({ kind: 'stale', ...r })),
      ...impact.missedPrograms.map(m => ({ kind: 'missed', ...m })),
    ];
    await runSequential(combinedQueue, async item => {
      if (item.kind === 'stale') {
        await publishRelay(item.relayId, 'OFF');
        if (relayOwner[item.relayId]) delete relayOwner[item.relayId];
        // חובה לשדר scheduler_fired — זהו האירוע היחיד שגורם לדפדפן לעדכן את מצב הממסר בזמן אמת (ראה fireEvent). בלעדיו הממשק נשאר "תקוע" עד רענון ידני.
        io.emit('scheduler_fired', { progName: `כיבוי אוטומטי — יציאה ממצב (${item.ownerProgName || 'תוכנית קודמת'})`, relayId: item.relayId, action: 'OFF' });
      } else {
        await publishRelay(item.relayId, 'ON');
        relayOwner[item.relayId] = { progId: item.progId, name: item.progName, priority: item.isPriority, endSec: item.endSec };
        io.emit('scheduler_fired', { progName: item.progName, relayId: item.relayId, action: 'ON' });
        // קריטי: לרשום את זה כ"ירה באמת" — אחרת הכיבוי-לפי-משך העתידי של התוכנית הזו יידלג בשקט
        // (schedulerTick בודק _actuallyFired לפני שהוא מרשה לאירוע-הסיום לירות, וההפעלה הזו לא עברה דרך fireEvent הרגיל)
        if (item.fireSec !== undefined) _actuallyFired.add(`${item.progId}_${item.relayId}_${item.segType}_${item.cycleIdx??'x'}_${item.fireSec}_start_${_catchupTodayKey}`);
        // תוכנית runOnce שהופעלה כהשלמה — כיבוי הדגל כמו בירייה רגילה, אחרת היא עלולה לירות שוב במחזור עתידי
        if (item.runOnce) {
          const p = schedulerPrograms.find(x => x.id === item.progId);
          if (p && p.active) {
            p.active = false;
            _firedRunOnceToday.set(p.id, { ...p, _todayKey: _catchupTodayKey });
            io.emit('program_updated', { id: p.id, active: false });
            saveConfigLocal();
          }
        }
      }
    });

    // תוכנית-כיבוי (או הדלקה) שהוחמצה **בזמן-שהות-במצב-שרק-עכשיו-עוזבים** — staleRelays/missedPrograms
    // מבוססות-בעלות (relayOwner) בלבד, ולכן לא תופסות מקרה שבו הממסר מעולם לא היה "בבעלות" (למשל
    // הודלק/כובה ידנית תוך-כדי-השהות-במצב-הזמני — פעולה ידנית לא נוגעת ב-relayOwner בכלל!) — אבל
    // הלוח-זמנים-של-המצב-החדש עדיין "רוצה" משהו-אחר עכשיו. applyMissedRegularPrograms לא תלויה
    // ב-relayOwner בכלל — מחשבת ישירות מההיסטוריה (שני הכיוונים), ו"אחרון-כרונולוגית-מנצח" — כך
    // שהדלקה-מאוחרת-יותר (אחרי הכיבוי-שהוחמץ) עדיין מכבדת אוטומטית, בלי טיפול-מיוחד.
    // **רצה רק אחרי-שהתור-למעלה הסתיים-לגמרי** (await), כדי שגם השלב-הזה לא-יחפוף עם הקודם.
    if (_lastModeTransitionAtMs !== null) {
      try {
        const res = applyMissedRegularPrograms(_lastModeTransitionAtMs, nowMsForSwitch);
        if (res && res.done) await res.done;
      }
      catch(e) { console.error('❌ שגיאה בבדיקת-תוכניות-שהוחמצו (מעבר-מצב חי):', e.message); }
    }
    _lastModeTransitionAtMs = nowMsForSwitch;
  } catch(e) {
    console.error('❌ שגיאה ב-commitAutoModeSwitch:', e.message);
  }
}

// **מנעול-גלובלי**: אם שתי-קריאות ל-commitAutoModeSwitch מגיעות קרוב-אחת-לשנייה ממקורות-שונים
// (למשל טריגר-חיצוני ותזמון-מצב-רגיל שקפצו כמעט-יחד) — הן חייבות-לרוץ-אחת-אחרי-השנייה-לגמרי,
// לא-במקביל. בלי זה, שתי-הקריאות היו-בונות-כל-אחת-תור-רציף-משלה, ושתי-התורים-האלה עצמם היו-
// יכולים-לחפוף-זה-בזה (בדיוק אותה בעיה שתיקנו בתוך-קריאה-בודדת, רק ברמה-אחת-למעלה).
let _modeSwitchChain = Promise.resolve();
function commitAutoModeSwitch(newModeId, label) {
  const run = () => _commitAutoModeSwitchInner(newModeId, label);
  _modeSwitchChain = _modeSwitchChain.then(run, run);
  return _modeSwitchChain;
}

// גרסה גלובלית של computeModeSwitchImpact (לא בתוך io.on)
function computeModeSwitchImpactGlobal(newModeId, opts) {
  opts = opts || {};
  // opts.nowMs/opts.ownerMap: קיימים **רק** כדי לאפשר לסימולטור (simulateScheduleRange) להשתמש
  // באותה פונקציה בדיוק (לא לוגיקה-מקבילה!) על "עכשיו" מדומה ו"מפת-בעלות" מדומה של הסימולציה
  // עצמה — במקום הזמן-האמיתי/relayOwner-האמיתי. כשלא מסופקים (השימוש הרגיל, commitAutoModeSwitch),
  // ההתנהגות זהה-לחלוטין למה שהייתה קודם.
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : debugNow().getTime();
  const ownerMap = opts.ownerMap || relayOwner;
  const nowIL = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const dayStartMsG = new Date(nowIL.getFullYear(), nowIL.getMonth(), nowIL.getDate()).getTime();
  const nowSec = opts.nowMs !== undefined ? Math.round((nowMs - dayStartMsG)/1000) : getNowSecIL();
  const todayKey = nowIL.toDateString();
  const staleRelays = [];
  for (const relayIdStr of Object.keys(ownerMap)) {
    const relayId = parseInt(relayIdStr, 10);
    const owner = ownerMap[relayId];
    // אם הבעלות-הרשומה כבר פגה (endSec שלה כבר עבר) — היא לא אומרת שום דבר אמין על "מה-כרגע-דולק-
    // ומכוח-מה". תוכנית שכבר סיימה-את-ההתחייבות-שלה (ואולי הממסר שונה-ידנית כמה פעמים מאז, בלי
    // שדבר עדכן/ניקה את הרישום — פעולה ידנית לא נוגעת ב-relayOwner בכלל) לא צריכה לגרום לכיבוי
    // כאן. זה בדיוק אותו עיקרון-תפוגה שכבר קיים ב-checkRelayOwnerBlock — עכשיו עקבי גם כאן.
    if (owner.endSec !== null && owner.endSec <= nowSec) { delete ownerMap[relayId]; continue; }
    const p = schedulerPrograms.find(x => String(x.id) === String(owner.progId));
    const modeIds = p ? (p.modeIds ?? (p.modeId !== null ? [p.modeId] : [0])) : [];
    if (!modeIds.includes(newModeId)) staleRelays.push({ relayId, relayName: schedulerRelayNames[relayId] || `ממסר ${relayId}`, ownerProgName: owner.name });
  }
  const savedMode = schedulerActiveModeId;
  schedulerActiveModeId = newModeId;
  const dow = nowIL.getDay();
  const zmanim = getZmanim(nowIL);
  let newModeEvents = [];
  try {
    const todayEvents = computeTodayEvents(nowIL, zmanim, dow, todayKey);
    // קריטי: "היום בלבד" לא מספיק! תוכנית שממשיכה-לדלוק-ברציפות מאתמול (או אפילו קודם) — למשל
    // מחזור-לילה שחוצה-חצות, או תוכנית-כיבוי-יומית-עם-חזרה-אוטומטית (כמו "תאורה סלון") שה-OFF/ON
    // שלה **כולם** קרו אתמול (בלי לחצות לתוך היום כלל) — הייתה בלתי-נראית-לגמרי ל"תוכניות-שהוחמצו",
    // כי computeTodayEvents(היום) לא מייצרת בשבילה שום אירוע (המחזור-שלה-היום מתחיל רק הערב).
    // זו בדיוק הסיבה שממסרים שהיו-כבר-דולקים-מאתמול לא חזרו לדלוק אחרי חזרה-ממצב-זמני.
    // הפתרון: לחשב גם את "אתמול" (יום שלם, לא רק אירועים-חוצי-חצות) ולמזג לאותו ציר-זמן (בהזזה
    // של 86400- שניות), בדיוק כמו ש-applyMissedRegularPrograms/reestablishRelayOwnership כבר עושות.
    const yIL = new Date(nowIL); yIL.setDate(yIL.getDate()-1);
    const yKey = yIL.toDateString(), yDow = yIL.getDay(), yZman = getZmanim(yIL);
    const yesterdayEvents = computeTodayEvents(yIL, yZman, yDow, yKey)
      .map(e => ({ ...e, fireSec: e.fireSec - 86400, endSec: e.endSec !== null ? e.endSec - 86400 : null }));
    newModeEvents = [...yesterdayEvents, ...todayEvents];
  }
  finally { schedulerActiveModeId = savedMode; }

  // מפה של טווחי-בעלות של תוכניות עדיפות לכל ממסר — ראו הסבר מלא בגרסה הידנית של הפונקציה הזו למעלה
  const priorityIntervalsByRelayG = {};
  for (const ev of newModeEvents) {
    if (ev.action !== 'ON' || ev.isEndEvent || !ev.isPriority) continue;
    (priorityIntervalsByRelayG[ev.relayId] ||= []).push({ progId: ev.progId, start: ev.fireSec, end: ev.endSec });
  }
  const isBlockedByPriorityG = ev => {
    const arr = priorityIntervalsByRelayG[ev.relayId];
    return !!arr && arr.some(iv => iv.progId !== ev.progId && iv.start <= ev.fireSec && (iv.end === null || iv.end > ev.fireSec));
  };

  // בנה מפה של אירוע כיבוי אחרון שירה לפני עכשיו, לכל ממסר
  const lastOffFiredByRelayG = {};
  for (const ev of newModeEvents) {
    if (ev.action !== 'OFF' || ev.fireSec > nowSec) continue;
    if (!ev.isPriority && isBlockedByPriorityG(ev)) continue;
    const cur = lastOffFiredByRelayG[ev.relayId];
    if (!cur || ev.fireSec > cur.fireSec) lastOffFiredByRelayG[ev.relayId] = ev;
  }

  // מצא תוכניות שפספסו — מועמד אחד לכל ממסר
  // חשוב: **לא** מסננים isEndEvent כאן! תוכנית עם action:OFF+duration (למשל "תאורה סלון", כיבוי-
  // בלילה עם חזרה-אוטומטית-לדלוק) — המצב-הנכון-שלה-עכשיו ("צריכה לדלוק") מגיע **רק** מאירוע-
  // הסיום-לפי-משך (isEndEvent, שבו action='ON' זה בעצם 'חזרה למצב-הקודם', לא תחילת-תוכנית-חדשה).
  // סינון isEndEvent כאן הפך את התוכנית הזו לבלתי-נראית-לגמרי ל"תוכניות-שהוחמצו" — זו בדיוק הסיבה
  // שממסרי-אור (עם מחזור OFF-בלילה/ON-ביום מבוסס-משך) לא חזרו לדלוק אחרי חזרה-ממצב-זמני.
  const missedCandidatesByRelay = {};
  for (const ev of newModeEvents) {
    if (ev.action !== 'ON') continue;
    if (ev.fireSec > nowSec) continue;
    if (!ev.isEndEvent && nowSec - ev.fireSec <= 8) continue;
    if (ev.endSec !== null && ev.endSec <= nowSec) continue;
    // אם יש אירוע כיבוי מאוחר יותר שכבר עבר — הממסר כבוי כעת
    const lastOff = lastOffFiredByRelayG[ev.relayId];
    if (lastOff && lastOff.fireSec > ev.fireSec) continue;
    // סנן runOnce שכבר ירה היום
    if (ev.runOnce && _firedRunOnceToday.has(ev.progId)) continue;
    const cur = missedCandidatesByRelay[ev.relayId];
    if (!cur) { missedCandidatesByRelay[ev.relayId] = ev; continue; }
    const curWins = (cur.isPriority && !ev.isPriority) ? true : (!cur.isPriority && ev.isPriority) ? false : (cur.endSec === null) ? true : (ev.endSec === null) ? false : (cur.endSec >= ev.endSec);
    if (!curWins) missedCandidatesByRelay[ev.relayId] = ev;
  }

  // הרחב — כל הממסרים של כל תוכנית שפספסה (לא רק הממסר הראשון)
  const missedProgIds = new Set(Object.values(missedCandidatesByRelay).map(ev => ev.progId));
  const missedPrograms = [];
  const _addedMissedRelayIds = new Set(); // מונע כפילות: אותו relayId יכול להתאים ליותר-מאירוע-אחד
  // (תוכנית-מחזורים עם כמה פולסים חופפים-בזמן, או התאמה גם ב"אתמול" וגם ב"היום" שממוזגים יחד) —
  // בלי הגנה-זו, אותו ממסר-ופקודה נשלחים כמה-פעמים (בדיוק התופעה שדווחה: אותה פעולה חוזרת 3 פעמים).
  for (const ev of newModeEvents) {
    if (ev.action !== 'ON') continue;
    if (!missedProgIds.has(ev.progId)) continue;
    if (ev.fireSec > nowSec) continue;
    if (ev.endSec !== null && ev.endSec <= nowSec) continue;
    const lastOff = lastOffFiredByRelayG[ev.relayId];
    if (lastOff && lastOff.fireSec > ev.fireSec) continue;
    // בדוק שהממסר הספציפי הזה לא כבוי כבר
    if (missedCandidatesByRelay[ev.relayId]?.progId !== ev.progId) continue;
    if (_addedMissedRelayIds.has(ev.relayId)) continue;
    _addedMissedRelayIds.add(ev.relayId);
    missedPrograms.push({
      relayId: ev.relayId,
      relayName: schedulerRelayNames[ev.relayId] || `ממסר ${ev.relayId}`,
      progId: ev.progId, progName: ev.name, isPriority: !!ev.isPriority, endSec: ev.endSec,
      fireSec: ev.fireSec, segType: ev.segType, cycleIdx: ev.cycleIdx, runOnce: !!ev.runOnce,
    });
  }

  return { staleRelays, missedPrograms };
}

// מחשבת את זמן-ההפעלה (epoch ms, זמן ישראל) של תזמון-מצב sm בתאריך dateIL נתון — או null אם
// התזמון לא חל בתאריך הזה בכלל (ימים/תאריך-עברי לא מתאימים, או zman לא-רלוונטי). זו בדיוק אותה
// לוגיקת-הסינון שהייתה בתוך processScheduledModes, רק מופרדת כדי שאפשר יהיה להשתמש בה גם ליום
// אחר מ"היום" (חיוני ל-runBootReconciliation, שצריך לסרוק את **כל הימים** שבתוך פער-הקריסה).
// ממיר epoch-ms כלשהו ל-Date שמייצג את **תחילת-היום-שלו לפי-לוח-השנה-הישראלי** — קריטי כשהתהליך
// עצמו לא בהכרח רץ באזור-זמן-ישראל (למשל קונטיינר-Docker עם TZ=UTC כברירת-מחדל): שימוש נאיבי
// ב-new Date(epochMs).getFullYear()/getMonth()/getDate() היה עלול להחזיר את **היום-הלועזי-הלא-
// נכון** ספציפית בשעות שבהן זמן-ישראל וזמן-התהליך חוצים חצות בנקודות-שונות (למשל 00:00-03:00
// בקיץ הישראלי = 21:00-00:00 UTC של האתמול).
// הערה חשובה: ה-Date המוחזר נבנה עם new Date(y,m,d) הרגיל — הרכיבים (getFullYear/getMonth/getDate/
// getDay) תמיד נכונים ועקביים-עם-עצמם (זה כל מה ש-computeScheduledModeFireEpoch/computeTodayEvents
// צריכות — אותה מוסכמה בדיוק שכבר קיימת בכל הקובץ). אבל ה-epoch הגולמי (result.getTime()) **אינו**
// בהכרח שווה לחצות-אמיתי-בישראל אם התהליך לא רץ ב-Asia/Jerusalem — לכן, בכל מקום שמשווים תוצאה
// הנגזרת-מזה מול epoch-אמיתי-ומוחלט (Date.now(), lastTick וכו') יש להשתמש גם ב-toTrueEpoch למטה.
function israelCalendarDayStart(epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(new Date(epochMs));
  const get = t => parseInt(parts.find(p=>p.type===t).value, 10);
  return new Date(get('year'), get('month')-1, get('day'));
}

// ה-epoch-האמיתי-והמוחלט של "00:00:00 בישראל" ביום-הקלנדרי (y,m,d) — תיקון-איטרטיבי דרך
// Intl.DateTimeFormat (לא string-parsing עמום), ללא-תלות באזור-הזמן-של-התהליך-המריץ.
function trueIsraelMidnightEpoch(y, m, d) {
  let guess = Date.UTC(y, m-1, d, 0, 0, 0);
  for (let i=0;i<3;i++){
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone:'Asia/Jerusalem', year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false
    }).formatToParts(new Date(guess));
    const get = t => parseInt(parts.find(p=>p.type===t).value,10);
    const gotUTC = Date.UTC(get('year'), get('month')-1, get('day'), get('hour')%24, get('minute'), get('second'));
    const wantUTC = Date.UTC(y, m-1, d, 0, 0, 0);
    const err = wantUTC - gotUTC;
    if (err===0) break;
    guess += err;
  }
  return guess;
}

// ממיר epoch "עצמי-עקבי" (כזה שנבנה דרך new Date(y,m,d,...) הרגיל — נכון-ועקבי-עם-עצמו לצורך
// חישובי fireSec/dow פנימיים, אבל לא בהכרח "אמיתי" אם התהליך לא ב-Asia/Jerusalem) ל-epoch-אמיתי-
// ומוחלט, כדי שאפשר יהיה להשוות אותו בבטחה מול Date.now()/lastTick וכיו"ב. dateIL הוא ה-Date
// (מ-israelCalendarDayStart) ששימש לחישוב ה-selfConsistentEpoch המקורי.
function toTrueEpoch(selfConsistentEpoch, dateIL) {
  const naiveMidnight = new Date(dateIL.getFullYear(), dateIL.getMonth(), dateIL.getDate()).getTime();
  const trueMidnight = trueIsraelMidnightEpoch(dateIL.getFullYear(), dateIL.getMonth()+1, dateIL.getDate());
  return selfConsistentEpoch - (naiveMidnight - trueMidnight);
}

function computeScheduledModeFireEpoch(sm, dateIL) {
  if (!sm.active) return null;
  const dow = dateIL.getDay();
  if (sm.days?.length && !sm.days.includes(dow)) return null;
  if (sm.calType && sm.calType !== 'none') {
    const dd = String(dateIL.getDate()).padStart(2,'0');
    const mm = String(dateIL.getMonth()+1).padStart(2,'0');
    const yyyy = dateIL.getFullYear();
    const entry = _calendarIndex[`${dd}/${mm}/${yyyy}`];
    if (!entry) return null;
    const calDate = entry['תאריך עברי'] || '';
    if (sm.calType === 'annual') {
      if (!calDate.startsWith(`${sm.calDay} ${sm.calMonth}`)) return null;
    } else if (sm.calType === 'once') {
      if (calDate !== sm.calLabel || yyyy !== sm.calYear) return null;
    } else if (sm.calType === 'rosh_chodesh_aleph') {
      if (getHebrewDayNumber(entry) !== 1) return null;
    } else if (sm.calType === 'rosh_chodesh_lamed') {
      if (getHebrewDayNumber(entry) !== 30) return null;
    }
  }
  let fireSec = -1;
  if (sm.type === 'time') {
    const [h,m] = (sm.time||'00:00').split(':').map(Number);
    fireSec = h*3600 + m*60;
  } else if (sm.type === 'zman') {
    const zmanim = getZmanim(dateIL);
    const zmKey = { sunset:'sunset',sunrise:'sunrise',candles:'candles',havdalah:'havdalah',tzeit:'tzeit',dawn:'alotHaShachar',mincha:'minchaGedola' }[sm.zman] || sm.zman;
    const base = zmanim[zmKey];
    if (!base) return null;
    const [h,m] = base.split(':').map(Number);
    const baseSec = h*3600 + m*60;
    const offset = (sm.offsetVal||0) * 60;
    fireSec = sm.offsetDir === '-' ? baseSec - offset : baseSec + offset;
  }
  if (fireSec < 0) return null;
  // בונה Date-object בזמן-ישראל-מקומי, בדיוק כמו getIsraelParts+Date-numeric בלקוח — נמנע מ-
  // new Date(string) לא-חד-משמעי (אותו עיקרון-יסוד שכבר תועד ותוקן שוב ושוב בתצוגת-הלקוח).
  const local = new Date(dateIL.getFullYear(), dateIL.getMonth(), dateIL.getDate(), 0, 0, 0, 0);
  return local.getTime() + fireSec * 1000;
}

function processScheduledModes() {
  if (!scheduledModes.length) return;
  try {
    const nowIL = new Date(debugNow().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const nowSec = getNowSecIL();
    const todayKey = nowIL.toDateString();
    const WINDOW_SEC = 15;

    // נקה fired set יומי
    _firedScheduledModes.forEach(k => { if (!k.endsWith(todayKey)) _firedScheduledModes.delete(k); });

    for (const sm of scheduledModes) {
      const fireEpoch = computeScheduledModeFireEpoch(sm, nowIL);
      if (fireEpoch === null) continue;
      const fireSec = Math.round((fireEpoch - new Date(nowIL.getFullYear(),nowIL.getMonth(),nowIL.getDate()).getTime())/1000);
      if (fireSec > nowSec || fireSec < nowSec - WINDOW_SEC) continue;

      // מפתח-ה"ירה-כבר" כולל את שעת-ההפעלה-המחושבת עצמה (fireSec), לא רק את ה-ID והתאריך —
      // כך שעריכת-שעת-התזמון (אפילו באותו יום, בדיוק כמו בבדיקה חוזרת) נחשבת "תזמון חדש" ויכולה
      // לירות שוב, בעוד שהגנת-מפני-ירי-כפול-אמיתי (אותו תזמון, אותה שעה, כמה טיקים ברצף) נשארת
      // שלמה. todayKey נשאר **בסוף** המפתח בכוונה — הניקוי-היומי למטה (`endsWith(todayKey)`)
      // תלוי בזה.
      const fireKey = `sm_${sm.id}_${fireSec}_${todayKey}`;
      if (_firedScheduledModes.has(fireKey)) continue;
      _firedScheduledModes.add(fireKey);

      // שמור מצב קודם אם יש duration
      if (sm.durationOn) {
        _previousModeId = schedulerActiveModeId;
        const durationSec = ((sm.durationH||0)*3600 + (sm.durationM||0)*60);
        armPendingRevertTimer(_previousModeId, sm.toModeId, Date.now() + durationSec * 1000);
      }

      commitAutoModeSwitch(sm.toModeId, sm.name || `תזמון מצב ${sm.id}`);
    }
  } catch(e) {
    console.error('❌ שגיאה ב-processScheduledModes:', e.message);
  }
}

// ═══ רשת-הצלה: התאמה-אחרי-הפעלה-מחדש (boot reconciliation) ══════════════════════════════════
// מטפלת במקרה שהשרת קרס/נפל-חשמל בדיוק בזמן שהיה אמור להתבצע תזמון-מצב או תוכנית. הרעיון: לא
// "לנחש מצב-סופי" ולא "לשחזר פקודה-פקודה" — אלא להרחיב את **אותה בדיקה בדיוק** שכבר רצה כל 5-10
// שניות (processScheduledModes/schedulerTick), רק על-פני **כל הפער** (מ"פעימה אחרונה ידועה" ועד
// עכשיו) במקום חלון-של-שניות-בודדות. אם לא היה שום דבר מתוזמן בתוך הפער — לא עושים כלום.

// בודקת אם יש **בכלל** משהו-מתוזמן בתוך הפער (תזמוני-מצב או תוכניות) — בדיקה זולה, כדי שרוב
// המקרים (הפעלה-מחדש רגילה, בלי תזמון בדיוק בחלון) לא יפעילו את כל מנגנון-ההתאמה בכלל.
function gapHasAnyScheduledActivity(fromMs, toMs) {
  // תזמוני-מצב: סורקים כל יום בתוך הפער
  for (let d = new Date(fromMs); d.getTime() <= toMs; d.setDate(d.getDate()+1)) {
    const dateIL = israelCalendarDayStart(d.getTime());
    for (const sm of scheduledModes) {
      const epochSelf = computeScheduledModeFireEpoch(sm, dateIL);
      if (epochSelf === null) continue;
      const epoch = toTrueEpoch(epochSelf, dateIL);
      if (epoch > fromMs && epoch <= toMs) return true;
    }
  }
  // תוכניות רגילות: משתמשים ב-computeTodayEvents הקיים (זהה למה ש-schedulerTick כבר עושה),
  // לכל יום בתוך הפער, ובודקים אם יש אירוע (fireSec) שנופל בתוך הפער.
  // **קריטי**: תוכנית-מחזורים (או כל תוכנית אחרת) שהעוגן-שלה (למשל שקיעה+200 דק') הוא **אתמול**
  // בערב, אבל ממשיכה-לרוץ לתוך שעות-הלילה-המוקדמות-של-**היום** — computeTodayEvents(היום) לא
  // "יודעת" עליה בכלל (היא מחשבת עוגן-חדש-משלה, ל-**הערב-של-היום**, לא ממשיכה-את-אתמול)! בלי
  // לסרוק גם את **אתמול** (בדיוק כמו ש-applyMissedRegularPrograms/reestablishRelayOwnership כבר
  // עושות, ומדוע הן כן זיהו את זה נכון) — נקודת-מעבר-מחזור בשעות-הלילה-המוקדמות (למשל 04:11)
  // הייתה בלתי-נראית-לגמרי לבדיקה הזו, וגורמת לפספוס-שקט של תיקון-נדרש-באמת.
  {
    const dateILFrom = israelCalendarDayStart(fromMs);
    const yIL = new Date(dateILFrom); yIL.setDate(yIL.getDate()-1);
    const yDayStart = toTrueEpoch(yIL.getTime(), yIL);
    const yZmanim = getZmanim(yIL);
    const yEvents = computeTodayEvents(yIL, yZmanim, yIL.getDay(), yIL.toDateString());
    for (const ev of yEvents) {
      const epoch = yDayStart + ev.fireSec*1000;
      if (epoch > fromMs && epoch <= toMs) return true;
    }
  }
  for (let d = new Date(fromMs); d.getTime() <= toMs; d.setDate(d.getDate()+1)) {
    const dateIL = israelCalendarDayStart(d.getTime());
    const dayStart = toTrueEpoch(dateIL.getTime(), dateIL);
    const dow = dateIL.getDay();
    const todayKey = dateIL.toDateString();
    const zmanim = getZmanim(dateIL);
    const events = computeTodayEvents(dateIL, zmanim, dow, todayKey);
    for (const ev of events) {
      const epoch = dayStart + ev.fireSec*1000;
      if (epoch > fromMs && epoch <= toMs) return true;
    }
  }
  // טיימר-חזרה-ממתין שהיה תלוי-ועומד (persisted) — גם הוא "פעילות מתוזמנת" שצריך לטפל בה
  if (_pendingRevertInfo && _pendingRevertInfo.revertAtEpochMs > fromMs && _pendingRevertInfo.revertAtEpochMs <= toMs) return true;
  return false;
}

// מחשבת "מה המצב הנכון עכשיו" — מתחילה מהמצב שהיה ידוע-נכון ברגע lastTickAtEpochMs (הנחה סבירה:
// השרת עבד כרגיל עד לרגע הזה), וסורקת קדימה **רק** את הטריגרים שבתוך הפער עצמו (לא שחזור-היסטוריה
// מלא) — תזמוני-מצב חדשים וגם טיימר-חזרה-ממתין שהיה תלוי-ועומד — לפי סדר כרונולוגי.
function computeCorrectModeAfterGap(fromMs, toMs, startModeId) {
  const timeline = []; // { epochMs, toModeId, sm }
  for (let d = new Date(fromMs); d.getTime() <= toMs; d.setDate(d.getDate()+1)) {
    const dateIL = israelCalendarDayStart(d.getTime());
    for (const sm of scheduledModes) {
      const epochSelf = computeScheduledModeFireEpoch(sm, dateIL);
      if (epochSelf === null) continue;
      const epoch = toTrueEpoch(epochSelf, dateIL);
      if (epoch > fromMs && epoch <= toMs) {
        timeline.push({ epochMs: epoch, toModeId: sm.toModeId, sm });
      }
    }
  }
  timeline.sort((a,b) => a.epochMs - b.epochMs);

  // טיימר-חזרה-ממתין שהיה תלוי-ועומד לפני הפער (persisted) — מטופל כטריגר נוסף בציר-הזמן, לפי
  // סדר-כרונולוגי אמיתי מול שאר הטריגרים (יכול להיות שהוחלף/בוטל ע"י תזמון-חדש שקדם לו בזמן).
  let pendingRevert = _pendingRevertInfo;
  let mode = startModeId;

  for (const t of timeline) {
    // אם יש טיימר-חזרה-ממתין שהיה אמור לקרות **לפני** הטריגר הזה — מבצעים אותו קודם (סדר כרונולוגי),
    // עם אותה הגנת-race-condition כמו בזמן-אמת (רק אם עדיין באותו מצב שאליו הטיימר "שייך").
    if (pendingRevert && pendingRevert.revertAtEpochMs <= t.epochMs) {
      if (mode === pendingRevert.modeJustSetTo) mode = pendingRevert.revertToMode;
      pendingRevert = null;
    }
    const prevMode = mode;
    mode = t.toModeId;
    pendingRevert = t.sm.durationOn
      ? { revertToMode: prevMode, modeJustSetTo: t.toModeId, revertAtEpochMs: t.epochMs + ((t.sm.durationH||0)*3600+(t.sm.durationM||0)*60)*1000 }
      : null; // תזמון-עם-duration-חדש "דורס" כל טיימר-חזרה-קודם-שממתין, בדיוק כמו armPendingRevertTimer בזמן-אמת
  }

  // אחרי כל הטריגרים-החדשים בפער — אם עדיין נשאר טיימר-חזרה-ממתין שה-revertAtEpochMs שלו כבר
  // עבר ביחס ל"עכשיו" (toMs) — הוא היה אמור לקרות גם הוא, בתוך הפער.
  if (pendingRevert && pendingRevert.revertAtEpochMs <= toMs) {
    if (mode === pendingRevert.modeJustSetTo) mode = pendingRevert.revertToMode;
    pendingRevert = null;
  }

  return { correctModeNow: mode, remainingPendingRevert: pendingRevert };
}

// staleRelays הרגילה (ב-computeModeSwitchImpactGlobal) מסתמכת על relayOwner בזיכרון — וזה בדיוק
// מה שנמחק-לגמרי בקריסה! בתפעול-רגיל (בלי קריסה) relayOwner אמין (מתעדכן בכל ON/OFF, ראו fireEvent),
// ולכן staleRelays כבר-מספיקה שם — אין צורך לשכפל את זה. אבל ב-boot-reconciliation, כשגם התגלה
// שהוחמץ מעבר-מצב, אין שום זיכרון של "מה היה דלוק בגלל המצב הישן" — צריך לגזור את זה **מהגדרות-
// התוכניות עצמן**, לא מ-relayOwner: כל ממסר ששייך **רק** לתוכניות-מהמצב-הישן (לא גם למצב-החדש) —
// בטוח לשלוח לו OFF ללא-תנאי (אם כבר כבוי, no-op). ממסר ששייך **גם** למצב-החדש לא נכלל כאן בכלל —
// משאירים את הקביעה-לגביו לחישוב-האירועים-של-המצב-החדש עצמו (כדי לא "לקדם" כיבוי שאולי המצב-החדש
// דווקא רוצה שידלק).
function computeStaleRelaysFromOldMode(originalMode, correctModeNow) {
  const newModeRelays = new Set();
  const oldModeOnlyRelays = new Set();
  schedulerPrograms.forEach(p => {
    if (!p.active) return;
    const modeIds = p.modeIds ?? (p.modeId !== null && p.modeId !== undefined ? [p.modeId] : [0]);
    if (modeIds.includes(correctModeNow)) (p.relay||[]).forEach(r => newModeRelays.add(r));
    if (modeIds.includes(originalMode) && !modeIds.includes(correctModeNow)) (p.relay||[]).forEach(r => oldModeOnlyRelays.add(r));
  });
  return [...oldModeOnlyRelays].filter(r => !newModeRelays.has(r));
}

// מוצאת ומיישמת תוכניות-רגילות (לא קשורות-למעבר-מצב) שהוחמצו במהלך הפער — **בכל שני הכיוונים**
// (ON וגם OFF!). זה שונה מ-computeModeSwitchImpactGlobal.missedPrograms, שבודקת רק אירועי-ON
// (הגיוני שם — היא נועדה ל"מה-צריך-לדלוק-במצב-החדש" — אבל לא מתאימה למקרה הזה: תוכנית עם
// action:'OFF' שהיה אמור לכבות משהו באמצע-הלילה לא הייתה נתפסת בכלל).
// העיקרון: בדיוק כמו getRelayStateAtTime בלקוח — "האחרון-כרונולוגית-מנצח" מתוך רשימת-האירועים-
// הממוזגת (כולל גם אירועי-סיום שנוצרים אוטומטית ל-endMin!==null). לא בודקים checkRelayOwnerBlock
// כאן (זו התאמה-חד-פעמית-להיסטוריה, לא תחרות-בזמן-אמת בין תוכניות) — עקבי עם איך שהתצוגה-בלקוח
// כבר מוכחת-נכונה לאורך כל הפרויקט.
function applyMissedRegularPrograms(gapFromMs, nowMs) {
  const nowDate = new Date(nowMs);
  const nowIL = new Date(nowDate.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const dayStartMs = toTrueEpoch(new Date(nowIL.getFullYear(), nowIL.getMonth(), nowIL.getDate()).getTime(), nowIL);
  const nowSec = Math.round((nowMs - dayStartMs) / 1000);

  // אוספים אירועים של "היום" וגם "אתמול" (לתוכניות חוצות-חצות) — בדיוק כמו שני-החלקים ב-schedulerTick.
  const todayKey = nowIL.toDateString();
  const zmanimToday = getZmanim(nowIL);
  const eventsToday = computeTodayEvents(nowIL, zmanimToday, nowIL.getDay(), todayKey)
    .map(e => ({ ...e, _epochMs: dayStartMs + e.fireSec*1000, _dayKey: todayKey, _dayStartMs: dayStartMs }));

  const yIL = new Date(nowIL); yIL.setDate(yIL.getDate()-1);
  const yDayStartMs = toTrueEpoch(new Date(yIL.getFullYear(), yIL.getMonth(), yIL.getDate()).getTime(), yIL);
  const yKey = yIL.toDateString();
  const zmanimY = getZmanim(yIL);
  const eventsYesterday = computeTodayEvents(yIL, zmanimY, yIL.getDay(), yKey)
    .map(e => ({ ...e, _epochMs: yDayStartMs + e.fireSec*1000, _dayKey: yKey, _dayStartMs: yDayStartMs }));

  const allEvents = [...eventsYesterday, ...eventsToday];

  // אילו ממסרים בכלל היו "נוגעים" ע"י משהו בתוך הפער עצמו (start או end) — רק אלה מקבלים טיפול.
  const relaysInGap = new Set();
  allEvents.forEach(e => { if (e._epochMs > gapFromMs && e._epochMs <= nowMs) relaysInGap.add(e.relayId); });
  if (!relaysInGap.size) return { appliedCount: 0 };

  // חשוב: appliedCount נקבע כאן, **מיד וסינכרונית** — לא בתוך ה-callback המתוזמן-בפיזור (runStaggered
  // תמיד דוחה דרך setTimeout, אפילו עם 0 מילישניות, אז כל ניסיון-לספור-שם היה תמיד נותן 0 בזמן
  // שה-return מתבצע, גם כשבפועל כן נשלחות פקודות-תיקון רגע-אחר-כך — בדיוק ההודעה-המטעה שנצפתה ביומן).
  const appliedCount = relaysInGap.size;
  const _catchupTodayKey = todayKey;
  const done = runSequential([...relaysInGap], async relayId => {
    const relayEvents = allEvents.filter(e => e.relayId === relayId && e._epochMs <= nowMs);
    if (!relayEvents.length) return;
    relayEvents.sort((a,b) => a._epochMs - b._epochMs);
    const last = relayEvents[relayEvents.length - 1];
    const correctState = last.action; // 'ON' או 'OFF' — האחרון-כרונולוגית מנצח
    await publishRelay(relayId, correctState, 'התאמה אחרי הפעלה מחדש');
    io.emit('scheduler_fired', { progName: last.name, relayId, action: correctState });
    addServerLog({ type: 'info', msg: `🔄 [התאמה] "${last.name}" — ${schedulerRelayNames[relayId]||`ממסר ${relayId}`} → ${correctState} (הוחמץ בזמן שהשרת היה למטה)`, user: 'מערכת' });
    // אם זה "התחלה" שעדיין לא הגיע-זמן-הסיום-שלה (או שאין לה סיום) — לרשום _actuallyFired עם
    // ה-fireSec ה**מקורי** וה-todayKey הנכון, כדי שהכיבוי/הפיכה-הטבעית-לפי-משך (isEndEvent) שתגיע
    // בהמשך דרך ה-schedulerTick הרגיל לא תידלג בשקט (בדיוק אותו עיקרון כמו ב-commitAutoModeSwitch).
    if (!last.isEndEvent && (last.endSec === null || last._dayStartMs + last.endSec*1000 > nowMs)) {
      _actuallyFired.add(`${last.progId}_${relayId}_${last.segType}_${last.cycleIdx??'x'}_${last.fireSec}_start_${last._dayKey}`);
      if (correctState === 'ON') {
        relayOwner[relayId] = { progId: last.progId, name: last.name, priority: !!last.isPriority, endSec: last.endSec !== null ? last.endSec : null };
      }
      if (last.runOnce) {
        const p = schedulerPrograms.find(x => x.id === last.progId);
        if (p && p.active) { p.active = false; _firedRunOnceToday.set(p.id, { ...p, _todayKey: _catchupTodayKey }); io.emit('program_updated', { id: p.id, active: false }); saveConfigLocal(); }
      }
    }
  });
  return { appliedCount, done };
}


let _hasRunBootReconciliation = false;
// **תיקון-קריטי-נוסף**: זמן-הניתוק-האחרון של MQTT (לא-של-השרת!) — נחוץ כי runBootReconciliation
// רץ **פעם-אחת-בלבד** (בעליית-התהליך האמיתית). אם השרת **נשאר-פעיל** (התהליך-עצמו לא-קרס/הופעל-
// מחדש) אבל ה-MQTT-broker היה-לא-נגיש (כבל-רשת-שנותק-זמנית, MQTT-restart וכו') — פקודות ON/OFF
// שהיו-אמורות-להישלח **נכשלות בשקט** (publishRelay דוחה, ורק console.error, לא-נראה-בממשק) —
// ואף-מנגנון לא-תפס-את-זה עד עכשיו, כי runBootReconciliation לא-רץ-שוב. ראו handler 'connect'.
let _mqttDisconnectedAtMs = null;
// משחזרת את relayOwner (הנהלת-חשבונות בזיכרון-בלבד — **לא** שולחת שום פקודת-MQTT) מול המצב-הנכון-
// עכשיו, לכל ממסר עם היסטוריית-אירועים, לא רק ממסרים עם אירוע בתוך פער-מסוים. רצה **תמיד** בעלייה
// (ראו runBootReconciliation) כי relayOwner נמחקת-לגמרי בכל הפעלה-מחדש, ובלי זה, ממסר שהיה כבר-
// דולק-רציף (למשל באמצע-מחזור, בלי תזמון-ON/OFF ספציפי סמוך-לרגע-ההפעלה-מחדש) נשאר בלי-בעלים-רשום
// לצמיתות — מה שמונע מ-staleRelays לתפוס אותו במעבר-המצב הבא (זה בדיוק הבאג שהתגלה בבדיקה בפועל).
function reestablishRelayOwnership(nowMs) {
  try {
    const nowIL = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const dayStartMs = toTrueEpoch(new Date(nowIL.getFullYear(), nowIL.getMonth(), nowIL.getDate()).getTime(), nowIL);
    const todayKey = nowIL.toDateString();
    const zmanimToday = getZmanim(nowIL);
    const eventsToday = computeTodayEvents(nowIL, zmanimToday, nowIL.getDay(), todayKey)
      .map(e => ({ ...e, _epochMs: dayStartMs + e.fireSec*1000, _dayKey: todayKey, _dayStartMs: dayStartMs }));

    const yIL = new Date(nowIL); yIL.setDate(yIL.getDate()-1);
    const yDayStartMs = toTrueEpoch(new Date(yIL.getFullYear(), yIL.getMonth(), yIL.getDate()).getTime(), yIL);
    const yKey = yIL.toDateString();
    const zmanimY = getZmanim(yIL);
    const eventsYesterday = computeTodayEvents(yIL, zmanimY, yIL.getDay(), yKey)
      .map(e => ({ ...e, _epochMs: yDayStartMs + e.fireSec*1000, _dayKey: yKey, _dayStartMs: yDayStartMs }));

    const allEvents = [...eventsYesterday, ...eventsToday].filter(e => e._epochMs <= nowMs);
    const byRelay = {};
    allEvents.forEach(e => { if (!byRelay[e.relayId]) byRelay[e.relayId] = []; byRelay[e.relayId].push(e); });

    let restoredCount = 0;
    Object.keys(byRelay).forEach(relayIdStr => {
      const relayId = parseInt(relayIdStr, 10);
      const evs = byRelay[relayIdStr].sort((a,b) => a._epochMs - b._epochMs);
      const last = evs[evs.length-1];
      if (last.action !== 'ON') return; // לא-דולק — אין בעלות-להחזיר
      // אם עדיין יש endSec ולא עבר — התחייבות-הזמן עוד בתוקף; אם endSec כבר עבר, הבעלות-הזו כבר
      // "פגה" בפועל (גם אם ה-OFF-event-הטבעי-שלה עוד לא הגיע ל-schedulerTick) — לא משחזרים אותה.
      // **תיקון**: היה תמיד dayStartMs (של-היום), גם עבור אירוע שמקורו ב"אתמול" (תוכנית חוצת-חצות) —
      // שגוי-ב-24-שעות-בדיוק במקרה הזה. עכשיו משתמשים ב-_dayStartMs האמיתי של-האירוע-עצמו.
      if (last.endSec !== null) {
        const endEpochMs = last._dayStartMs + last.endSec*1000;
        if (endEpochMs <= nowMs) return;
      }
      relayOwner[relayId] = { progId: last.progId, name: last.name, priority: !!last.isPriority, endSec: last.endSec };
      restoredCount++;
      // **תיקון-קריטי**: מסמנים גם את אירוע-ה"התחלה" הזה כ-_actuallyFired — אחרת, כשה"סיום-לפי-משך"
      // הטבעי-שלו (isEndEvent) יגיע מאוחר-יותר דרך schedulerTick הרגיל, השורה `if(!_actuallyFired.has
      // (startKey)) continue;` תדלג עליו **בשקט לגמרי (בלי שום לוג)** — כי _actuallyFired הוא זיכרון-
      // בלבד, ונמחק-לגמרי בכל הפעלה-מחדש. בפועל: ממסר שכבר-היה-דולק-לפני-קריסה-קצרה נשאר דלוק
      // **לצמיתות**, כי הכיבוי-הטבעי-שלו-בזמנו אף-פעם לא-מתבצע. זו הייתה בדיוק התופעה שדווחה
      // ("אין ביומן זכר לניסיון-כיבוי בלילה") — לא הייתה שום שגיאה כי זה נכשל *לפני* כל בדיקת-
      // חסימה/רישום, ב-continue שקט.
      if (!last.isEndEvent) {
        _actuallyFired.add(`${last.progId}_${relayId}_${last.segType}_${last.cycleIdx??'x'}_${last.fireSec}_start_${last._dayKey}`);
      }
    });
    if (restoredCount > 0) {
      addServerLog({ type: 'info', msg: `🔄 [התאמה] שוחזרו ${restoredCount} בעלויות-ממסר (לפי היסטוריית-אירועים, ללא שליחת פקודות)`, user: 'מערכת' });
    }
  } catch(e) {
    console.error('❌ שגיאה בשחזור-בעלויות-ממסר (reestablishRelayOwnership):', e.message);
  }
}

async function runBootReconciliation() {
  if (_hasRunBootReconciliation) return; // רק פעם אחת, לא בכל reconnect
  _hasRunBootReconciliation = true;
  try {
    const now = Date.now();
    const lastTick = _lastTickAtEpochMsBeforeThisBoot;
    if (lastTick !== null && now <= lastTick) {
      // שעון-המערכת לא-מהימן (למשל Pi בלי RTC, עוד לפני סנכרון-NTP) — לא מריצים שום דבר על שעון-דמיוני,
      // כולל שחזור-הבעלויות למטה (היא גם תלויה ב"עכשיו" אמין).
      addServerLog({ type: 'warning', msg: `⚠️ שעון-המערכת ברגע-העלייה לא מאוחר מהפעימה-האחרונה-הידועה — דוחים את בדיקת-ההתאמה (יתבצע-אוטומטית בטיק-הבא אחרי שהשעון יסתדר)`, user: 'מערכת' });
      return;
    }

    // שחזור-בעלויות (relayOwner) — **תמיד** רץ, בלי קשר לגודל-הפער או ל"האם קרה משהו בפער". זה
    // בדיוק המקרה שהתגלה בבדיקה: ממסר שהיה כבר-דולק-באמצע-מחזור **לפני** ההפעלה-מחדש (בלי אף אירוע-
    // ON/OFF ספציפי בתוך הפער-עצמו, כי הוא כבר היה באמצע-הפעולה) נשאר בלי-בעלים-רשום לצמיתות — כי
    // relayOwner היא זיכרון-בלבד, ונמחקת-לגמרי בכל הפעלה-מחדש, ושום דבר אחר לא היה מחזיר אותה. זו
    // רק "הנהלת-חשבונות" פנימית (לא שולחת שום פקודת-MQTT) — אין שום סיכון בהרצתה תמיד, ללא-תנאי.
    reestablishRelayOwnership(now);

    // **תיקון-באג-קריטי**: חימוש-מחדש של טיימר-חזרה-ממתין (_pendingRevertInfo) — גם הוא **תמיד**
    // רץ, בלי-קשר לגודל-הפער, מאותה סיבה בדיוק כמו reestablishRelayOwnership למעלה: ה-setTimeout
    // בזיכרון נמחק-לגמרי בכל הפעלה-מחדש, ושום דבר אחר לא יוצר אותו-מחדש. **הבאג שהיה כאן**: החימוש-
    // מחדש היה קיים רק בתוך הענף של "אם gapHasAnyScheduledActivity מחזירה true" — אבל אם הקריסה
    // הייתה קצרה ובלי-שום-אירוע-בתוך-הפער-הצר-עצמו (למשל תזמון-מצב-עם-"למשך" שהתחיל שעות-לפני-
    // הקריסה ואמור-לחזור שעות-אחרי, אבל הקריסה-עצמה קצרה) — הפונקציה יצאה-מוקדם (return) **לפני**
    // שהחימוש-מחדש הזה בכלל הופעל! התוצאה: המערכת נשארת תקועה-לצמיתות במצב-הזמני, כי אף-דבר לא
    // מחזיר אותה יותר. תוקן ע"י הוצאת-הקריאה-הזו **החוצה**, לפני כל return מוקדם אפשרי.
    if (_pendingRevertInfo) {
      // חשוב: שומרים בלוקאלי **לפני** הקריאה — armPendingRevertTimer, כשהחזרה כבר-איחרה (מקרה
      // שקרה בפועל!), קוראת מיד ל-clearPendingRevertAndMaybeApply שמאפסת את _pendingRevertInfo
      // הגלובלי ל-null **תוך-כדי-הקריאה**. קריאה-חוזרת ל-_pendingRevertInfo (הגלובלי) בשורת-הלוג
      // שאחריה הייתה קורסת בדיוק על זה ("Cannot read properties of null").
      const { revertToMode: _prevRevertToMode, revertAtEpochMs: _prevRevertAt } = _pendingRevertInfo;
      armPendingRevertTimer(_pendingRevertInfo.revertToMode, _pendingRevertInfo.modeJustSetTo, _pendingRevertInfo.revertAtEpochMs);
      addServerLog({ type: 'info', msg: `🔄 טיימר-חזרה-ממתין חומש-מחדש אחרי הפעלה-מחדש — יחזור למצב ${_prevRevertToMode} ב-${new Date(_prevRevertAt).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'})}`, user: 'מערכת' });
    }

    if (lastTick === null) {
      addServerLog({ type: 'info', msg: '🔄 עלייה ראשונה (אין פעימה קודמת) — בעלויות-ממסרים שוחזרו, לא נדרשת התאמה נוספת', user: 'מערכת' });
      return;
    }
    const downMs = now - lastTick;
    const downMin = Math.round(downMs/60000*10)/10;
    addServerLog({ type: 'info', msg: `🔄 השרת עלה מחדש — היה לא-פעיל ${downMin} דקות (${new Date(lastTick).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'})} עד עכשיו). בודק אם נדרשת התאמה...`, user: 'מערכת' });

    if (!gapHasAnyScheduledActivity(lastTick, now)) {
      addServerLog({ type: 'info', msg: '✅ לא היה שום תזמון (מצב או תוכנית) בחלון הזה — לא נדרשת התאמה נוספת (בעלויות-ממסרים כבר שוחזרו למעלה)', user: 'מערכת' });
      return;
    }

    // שלב 1: מצב-מצב (mode) — כולל טיימר-חזרה-ממתין שהיה תלוי-ועומד
    const { correctModeNow, remainingPendingRevert } = computeCorrectModeAfterGap(lastTick, now, schedulerActiveModeId);
    const originalMode = schedulerActiveModeId;

    if (correctModeNow !== originalMode) {
      addServerLog({ type: 'info', msg: `🔄 [התאמה] המצב אמור להיות ${correctModeNow} (לא ${originalMode}) — מתקן`, user: 'מערכת' });
      // לפני commitAutoModeSwitch: לכבות ללא-תנאי כל ממסר ששייך **רק** לתוכניות-מהמצב-הישן (לא גם
      // לחדש) — כי staleRelays (בתוך commitAutoModeSwitch) לא יכולה לתפוס את זה בעצמה: relayOwner
      // ריק-לגמרי אחרי הפעלה-מחדש, ואין לה זיכרון-של-מה-היה-דולק לפני הקריסה. בתפעול-רגיל (בלי
      // קריסה) אין צורך בזה כלל — relayOwner אמין שם, ו-staleRelays כבר עושה את זה נכון בעצמה.
      const staleFromOldMode = computeStaleRelaysFromOldMode(originalMode, correctModeNow);
      await runSequential(staleFromOldMode, async relayId => {
        await publishRelay(relayId, 'OFF', 'התאמה אחרי הפעלה מחדש — יציאה ממצב קודם');
        if (relayOwner[relayId]) delete relayOwner[relayId];
        io.emit('scheduler_fired', { progName: `כיבוי אוטומטי — יציאה ממצב ${originalMode} (התאמה אחרי הפעלה מחדש)`, relayId, action: 'OFF' });
        addServerLog({ type: 'info', msg: `🔄 [התאמה] ממסר ${schedulerRelayNames[relayId]||relayId} → OFF (שייך רק למצב הקודם ${originalMode}, אין ל-relayOwner זיכרון אחרי הפעלה-מחדש)`, user: 'מערכת' });
      });
      await commitAutoModeSwitch(correctModeNow, `התאמה אחרי הפעלה מחדש (${downMin} דקות)`);
      // commitAutoModeSwitch כבר מטפלת בתוכניות-ON שהוחמצו במצב-החדש (missedPrograms) — אבל, כמו
      // בהמשך, זה מכסה רק כיוון-ON. מריצים גם את הבדיקה-הדו-כיוונית, ליתר ביטחון (idempotent — אם
      // commitAutoModeSwitch כבר תיקן, זה פשוט ישלח את אותה פקודה שוב, לא מזיק). ממתינים-לה (await)
      // כדי ששום-פקודה-מהשלב-הזה לא-תחפוף עם commitAutoModeSwitch שלמעלה (שכבר-הסתיים-לגמרי).
      try {
        const res = applyMissedRegularPrograms(lastTick, now);
        if (res && res.done) await res.done;
      } catch(e) { console.error('❌ שגיאה בבדיקה דו-כיוונית אחרי מעבר-מצב:', e.message); }
    } else {
      addServerLog({ type: 'info', msg: `🔄 [התאמה] המצב (${originalMode}) לא השתנה בפועל — בודק תוכניות שהוחמצו בתוך אותו מצב`, user: 'מערכת' });
      // גם אם המצב לא השתנה, ייתכן שתוכניות-רגילות באותו מצב פוספסו (כיבוי או הדלקה כאחד — למשל
      // טיימר-כיבוי-אור-בלילה בזמן שהשרת היה למטה) — commitAutoModeSwitch מדלג כי "אין שינוי-מצב".
      try {
        const { appliedCount, done } = applyMissedRegularPrograms(lastTick, now);
        if (done) await done;
        if (!appliedCount) {
          addServerLog({ type: 'info', msg: '✅ לא נמצאו תוכניות-שהוחמצו לתיקון', user: 'מערכת' });
        }
      } catch(e) {
        console.error('❌ שגיאה בבדיקת תוכניות-שהוחמצו (boot reconciliation):', e.message);
      }
    }

    // שלב 2: אם עדיין נשאר טיימר-חזרה-ממתין לעתיד (לא הופעל כבר בשלב 1 כי revertAtEpochMs>now) —
    // לחמש אותו מחדש עם הזמן-שנותר-בפועל (לא duration מלא מחדש!).
    if (remainingPendingRevert && remainingPendingRevert.revertAtEpochMs > now) {
      armPendingRevertTimer(remainingPendingRevert.revertToMode, remainingPendingRevert.modeJustSetTo, remainingPendingRevert.revertAtEpochMs);
      addServerLog({ type: 'info', msg: `🔄 [התאמה] טיימר-חזרה-ממתין שוחזר — יחזור למצב ${remainingPendingRevert.revertToMode} ב-${new Date(remainingPendingRevert.revertAtEpochMs).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'})}`, user: 'מערכת' });
    }

    addServerLog({ type: 'success', msg: '✅ התאמה-אחרי-הפעלה-מחדש הושלמה', user: 'מערכת' });
  } catch(e) {
    console.error('❌ שגיאה ב-runBootReconciliation:', e.message);
    addServerLog({ type: 'danger', msg: `❌ שגיאה בהתאמה-אחרי-הפעלה-מחדש: ${e.message}`, user: 'מערכת' });
  }
}

setInterval(schedulerTick, 5000);
setInterval(processIvrPendingTimers, 5000);
setInterval(processScheduledModes, 10000);
schedulerTick();
processIvrPendingTimers();

// ── ימות המשיח ──────────────────────────────────────────
function ymResponse(text){
  const clean=text.replace(/[:]/g," , ").replace(/\.{2,}/g," , ").replace(/\.(?!\d)/g," , ").replace(/[*#_>"]/g,"").replace(/\n/g," , ").replace(/\s+/g," ").trim();
  // "&" בסוף חובה! בלעדיו, טקסט-עברי בפרט (לא אנגלית) גורם לימות להשמיע "שגיאה" — מתועד בפורום
  // freeivr (משתמש נתקל בדיוק בתופעה הזו: אנגלית עבדה, עברית לא, עד שהוסיפו & בסוף).
  return `id_list_message=t-${clean}&`;
}

const IVR_ACK_TIMEOUT_MS = 3000;

// רשת-דיבוג לכל בקשות-ה-IVR: רושמת ליומן (הנראה בממשק) בדיוק מה ימות שלחה (כל ה-query) ובדיוק
// מה השרת החזיר (הטקסט המלא) — בלי זה אין שום דרך לדעת אם התקלה בכלל מגיעה לשרת, ואם כן, מה
// בדיוק חוזר ממנו. חשוב לצפייה-אחרי-שיחת-בדיקה: היומן (טאב הראשי) יראה שתי שורות לכל בקשה.
app.use(['/', '/yemot', '/yemot/program', '/yemot/schedule', '/program', '/schedule'], (req, res, next) => {
  // req.originalUrl (לא req.path!) — כי req.path נגזם-זמנית ע"י Express כשה-middleware הזה
  // מורכב על נתיב ספציפי (למשל '/yemot'), מה שגרם ל"בקשה" ו"תגובה" של אותה בקשה-בדיוק להראות
  // נתיבים-שונים בלוג הקודם (זה היה באג בלוג-הדיבוג עצמו, לא תיאור אמיתי של מה שימות שולחת).
  addServerLog({ type: 'info', msg: `📞 [IVR-בקשה] ${req.originalUrl.split('?')[0]} query=${JSON.stringify(req.query)}`, user: 'IVR' });
  const origSend = res.send.bind(res);
  res.send = (body) => {
    addServerLog({ type: 'info', msg: `📞 [IVR-תגובה] ${req.originalUrl.split('?')[0]} -> ${body}`, user: 'IVR' });
    return origSend(body);
  };
  next();
});

// ממיר epoch-ms מוחלט ל"שניות-מאז-חצות-מקומי-של-היום" — אותה מוסכמה בדיוק כמו endSec של תוכניות
// רגילות (יכול לעבור 86400 אם חוצה-חצות, בדיוק כמו endSec של תוכנית-לילה שממשיכה למחר).
function computeEndSecFromEpoch(epochMs) {
  const nowIL = new Date(debugNow().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const dayStartMs = new Date(nowIL.getFullYear(), nowIL.getMonth(), nowIL.getDate()).getTime();
  return Math.round((epochMs - dayStartMs) / 1000);
}

async function handleRelayIvrRequest(req, res) {
  const relayDigits=req.query.Relay||'',actionDigit=req.query.Action||'',durationStr=req.query.Duration||'',callerPhone=req.query.ApiPhone||'',hangup=req.query.hangup==='yes';
  if(hangup) return res.send('');
  if(relayDigits&&actionDigit&&callerPhone){
    const callerId=yemotPhoneMap[callerPhone];
    if(callerId===undefined) return res.send('id_list_message=t-אין הרשאה למספר זה&go_to_folder=hangup&');
    const perm=yemotPermissions[callerId]||{};
    const relayId=parseInt(relayDigits,10),relayName=schedulerRelayNames[relayId];
    const action=actionDigit==='1'?'ON':actionDigit==='2'?'OFF':null;
    const durationMin=parseInt(durationStr,10);
    if(!relayName||!action||isNaN(durationMin)||durationMin<0) return res.send('id_list_message=t-קלט לא תקין, נסה שוב&go_to_folder=hangup&');
    if(!perm.isAdmin){
      const maxDur=action==='ON'?(perm.maxDurationMinOn??0):(perm.maxDurationMinOff??0);
      if(!(perm.allowedRelays||[]).includes(relayId)||!(perm.allowedActions||[]).includes(action)||(maxDur!==0&&(durationMin===0||durationMin>maxDur)))
        return res.send('id_list_message=t-אינך מורשה, נסה שוב&go_to_folder=hangup&');
    }
    // בעלות: פקודת-IVR משתתפת עכשיו בהיררכיית-הבעלות הרגילה (relayOwner), בדיוק כמו תוכנית —
    // כדי שתוכל "להחזיק" ממסר מפני-כיבוי-מוקדם ע"י תוכנית-אחרת. "קבלת עדיפות" בהרשאות-המשתמש
    // (perm.priority) הופכת את זה לעדיפות-קבועה (מנצחת גם תוכניות-בלי-עדיפות); בלעדיה, ההכרעה
    // מול תוכנית-אחרת היא הרגילה — "מי-מסתיים-מאוחר-יותר-מנצח". מזהה-הבעלים הוא וירטואלי
    // (לא progId אמיתי) — ivr_owner_<ID>, כדי שלא יתבלבל עם תוכנית אמיתית.
    const nowSecForOwner = getNowSecIL();
    const virtualOwnerId = `ivr_owner_${callerId}`;
    if(action==='OFF'){
      const heldByOther = checkRelayOwnerBlock({relayId, progId: virtualOwnerId, isPriority: !!perm.priority, fireSec: nowSecForOwner}, nowSecForOwner);
      if(heldByOther) return res.send(ymResponse(`לא ניתן לכבות את ${relayName} כרגע — בשליטת "${heldByOther.blockedBy}"`));
    }
    try{
      const isOn=action==='ON';
      const ackPromise=waitForRelayAck(relayId,IVR_ACK_TIMEOUT_MS);
      await publishRelay(relayId,action,`IVR — ID ${callerId}`);
      const ackReceived=await ackPromise;
      let dueAt=null;
      if(durationMin>0){
        const timerId=`ivr_${Date.now()}_${Math.round(Math.random()*1e6)}`;
        const startedAt=Date.now();
        dueAt=startedAt+durationMin*60000;
        ivrPendingTimers.push({id:timerId,relayId,revertAction:isOn?'OFF':'ON',startedAt,dueAt,label:`${relayName} (IVR — ID ${callerId})`,callerId});
        ivrTodayEvents.push({id:timerId,relayId,callerId,startedAt,dueAt,action:isOn?'ON':'OFF',dateKey:new Date(startedAt).toLocaleDateString('en-CA',{timeZone:'Asia/Jerusalem'})});
        saveConfigLocal();io.emit('ivr_today_events',ivrTodayEvents);
      }
      // עדכון-בעלות בפועל — אחרי שהפקודה-האמיתית כבר הצליחה, בדיוק אותו עיקרון-"מי-חזק-יותר" כמו fireEvent
      if(action==='ON'){
        const endSecForOwner = dueAt!==null ? computeEndSecFromEpoch(dueAt) : null;
        const existing=relayOwner[relayId];
        const candidate={progId:virtualOwnerId,name:`${relayName} (IVR — ID ${callerId})`,priority:!!perm.priority,endSec:endSecForOwner};
        const existingExpired=existing&&existing.endSec!==null&&existing.endSec<=nowSecForOwner;
        const existingIsStronger=existing&&!existingExpired&&existing.progId!==candidate.progId&&existing.endSec!==null&&((existing.priority&&!candidate.priority)||(!existing.priority&&!candidate.priority&&candidate.endSec!==null&&existing.endSec>candidate.endSec));
        if(!existingIsStronger) relayOwner[relayId]=candidate;
      } else if(relayOwner[relayId]){
        delete relayOwner[relayId];
      }
      const msg=!ackReceived?`${relayName}: הפקודה נשלחה, ממתין לאישור`
        :durationMin>0?`${relayName}: ${isOn?'הודלק':'כובה'} בהצלחה, יחזור אוטומטית בעוד ${durationMin} דקות`
        :`${relayName}: ${isOn?'הודלק':'כובה'} בהצלחה`;
      return res.send(ymResponse(msg));
    }catch(err){return res.send(ymResponse('שגיאה בביצוע הפעולה, נסה שוב'));}
  }
  return res.send(ymResponse('לא התקבל קלט מלא, נסה שוב'));
}
// /yemot הוא עכשיו endpoint אוניברסלי — מכריע לפי **הפרמטרים**, לא לפי הנתיב, לאיזו לוגיקה להפנות.
// זה בדיוק הניסוי שהוצע: לנתב הכל (ממסרים/תוכניות/תיזמונים) לאותו נתיב-בדיוק שכבר-מוכח-עובד
// (/yemot), ולתת לשרת להבדיל לפי שם-הפרמטר (SchedNum/ProgNum/Relay) — מבודד לחלוטין את המשתנה
// "נתיב-אחר" מהתמונה.
function dispatchIvrRequest(req, res, next) {
  if (req.query.SchedNum !== undefined) return handleScheduleIvrRequest(req, res);
  if (req.query.ProgNum !== undefined) return handleProgramIvrRequest(req, res);
  if (req.query.ModeNum !== undefined) return handleModeIvrRequest(req, res);
  if (req.query.Relay !== undefined) return handleRelayIvrRequest(req, res);
  if (req.query.hangup === 'yes') return res.send('');
  return next ? next() : res.send(ymResponse('לא התקבל קלט מלא, נסה שוב'));
}
app.get('/yemot', (req, res) => dispatchIvrRequest(req, res));

// שלוחת-קיצור: הפרמטרים-הקבועים (ממסר/פעולה/משך) חיים **בתוך הנתיב עצמו**, לא בשאילתה — כדי
// שלא יהיה בכלל "?" קיים-מראש ב-api_link שיתנגש עם הפרמטרים-האוטומטיים שימות מוסיפה בעצמה
// (ApiPhone האמיתי של המתקשר, ApiCallId וכו') — זו בדיוק הבעיה שהתגלתה: ימות מוסיפה אותם עם "?"
// שני, לא "&", מה שהופך את כל מחרוזת-השאילתה לפגומה. עם הנתיב הזה, ה-api_link הוא בלי "?" בכלל,
// אז ה"?" הראשון-והיחיד תמיד יהיה זה שימות עצמה מוסיפה — בלי שום התנגשות אפשרית.
// דוגמה ל-api_link לשימוש בשלוחת-קיצור (בלי שום api_XXX — אין הקשות בכלל, רק נכנסים ומבוצע מיד):
//   api_link=https://YOUR_DOMAIN/yemot/quick/15/1/15   (ממסר 15, הדלקה, ל-15 דקות)
app.get('/yemot/quick/:relay/:action/:duration', (req, res) => {
  const mergedQuery = { ...req.query, Relay: req.params.relay, Action: req.params.action, Duration: req.params.duration };
  return handleRelayIvrRequest({ query: mergedQuery }, res);
});

// ניהול-תוכניות (הפעלה/השבתה) דרך IVR — **רק לאדמין** (לא לפי allowedRelays/allowedActions הרגילים,
// כי זו יכולת משמעותית-יותר מהדלקת-ממסר בודד — שינוי-תצורה, לא רק שליטה-רגעית). מוגבל **רק**
// לתוכניות שסומנו p.ivr===true בממשק — לא כל תוכנית קיימת, כדי שרשימת-הבחירה בטלפון תישאר קצרה
// וממוקדת, ולא תיחשף תוכניות-פנימיות שלא נועדו לניהול-טלפוני.
async function handleProgramIvrRequest(req, res) {
  const progNumStr=req.query.ProgNum||'',actionDigit=req.query.Action||'',callerPhone=req.query.ApiPhone||'',hangup=req.query.hangup==='yes';
  if(hangup) return res.send('');
  if(!progNumStr||!actionDigit||!callerPhone) return res.send(ymResponse('לא התקבל קלט מלא, נסה שוב'));
  const callerId=yemotPhoneMap[callerPhone];
  if(callerId===undefined) return res.send('id_list_message=t-אין הרשאה למספר זה&go_to_folder=hangup&');
  const perm=yemotPermissions[callerId]||{};
  if(!perm.isAdmin) return res.send('id_list_message=t-פעולה זו מוגבלת למנהל בלבד&go_to_folder=hangup&');
  // ProgNum הוא ה"מיקום" (1,2,3...) שנאמר-ונלחץ בטלפון — לא seqId ישירות. ממירים דרך **אותה** פונקציית-
  // סידור בדיוק שבנתה את ה-TTS (getIvrProgramsOrdered) — כדי שהמיקום-שנשמע יתאים תמיד למיקום-שמתפרש.
  const pos=parseInt(progNumStr,10);
  const ivrProgs=getIvrProgramsOrdered();
  const p=(pos>=1&&pos<=ivrProgs.length)?ivrProgs[pos-1]:null;
  if(!p) return res.send(ymResponse('קלט לא תקין, נסה שוב'));
  // Action=3: בדיקת-סטטוס בלבד — לא נוגעת בשום דבר, רק מדווחת מה המצב-הנוכחי.
  if(actionDigit==='3'){
    return res.send(ymResponse(`תוכנית ${p.name} כרגע ${p.active?'פעילה':'מושבתת'}`));
  }
  const setActive=actionDigit==='1'?true:actionDigit==='2'?false:null;
  if(setActive===null) return res.send(ymResponse('קלט לא תקין, נסה שוב'));
  try{
    p.active=setActive;
    saveConfigLocal();
    io.emit('program_updated',{id:p.id,active:p.active});
    addServerLog({type:'info',msg:`📞 [IVR] תוכנית "${p.name}" ${setActive?'הופעלה':'הושבתה'} ע"י מנהל (ID ${callerId})`,user:'IVR'});
    return res.send(ymResponse(`תוכנית ${p.name} ${setActive?'הופעלה':'הושבתה'} בהצלחה`));
  }catch(err){return res.send(ymResponse('שגיאה בביצוע הפעולה, נסה שוב'));}
}
app.get('/yemot/program', handleProgramIvrRequest);
app.get('/program', handleProgramIvrRequest);

// ניהול-תיזמוני-מצב (הפעלה/השבתה) דרך IVR — **רק לאדמין**, ורק תזמונים שסומנו sm.ivr===true.
// השבתה כאן **לא** מבטלת מעבר-מצב שכבר קורה עכשיו — רק מונעת הפעלות-עתידיות (אותה סמנטיקה
// בדיוק כמו ה-checkbox "פעיל" בממשק).
// הלוגיקה מופרדת לפונקציה-משותפת, נרשמת גם תחת /yemot/schedule (המקורי) וגם תחת /schedule
// (ניסוי: חשד שמערכת-ימות לא מטפלת נכון בתת-נתיבים כמו /yemot/schedule — ראו את השיחה על כך).
async function handleScheduleIvrRequest(req, res) {
  const schedNumStr=req.query.SchedNum||'',actionDigit=req.query.Action||'',callerPhone=req.query.ApiPhone||'',hangup=req.query.hangup==='yes';
  if(hangup) return res.send('');
  if(!schedNumStr||!actionDigit||!callerPhone) return res.send(ymResponse('לא התקבל קלט מלא, נסה שוב'));
  const callerId=yemotPhoneMap[callerPhone];
  if(callerId===undefined) return res.send('id_list_message=t-אין הרשאה למספר זה&go_to_folder=hangup&');
  const perm=yemotPermissions[callerId]||{};
  if(!perm.isAdmin) return res.send('id_list_message=t-פעולה זו מוגבלת למנהל בלבד&go_to_folder=hangup&');
  // SchedNum הוא ה"מיקום" (1,2,3...) — לא ה-id הפנימי (שיכול להיות "לא-נקי", כמו 9602/9604).
  // אותה עקרונית-המרה בדיוק כמו ב-/yemot/program, דרך getIvrSchedulesOrdered.
  const pos=parseInt(schedNumStr,10);
  const ivrModes=getIvrSchedulesOrdered();
  const sm=(pos>=1&&pos<=ivrModes.length)?ivrModes[pos-1]:null;
  if(!sm) return res.send(ymResponse('קלט לא תקין, נסה שוב'));
  // Action=3: בדיקת-סטטוס בלבד — לא נוגעת בשום דבר, רק מדווחת מה המצב-הנוכחי.
  if(actionDigit==='3'){
    return res.send(ymResponse(`תזמון ${sm.name} כרגע ${sm.active?'פעיל':'מושבת'}`));
  }
  const setActive=actionDigit==='1'?true:actionDigit==='2'?false:null;
  if(setActive===null) return res.send(ymResponse('קלט לא תקין, נסה שוב'));
  try{
    sm.active=setActive;
    saveConfigLocal();
    io.emit('scheduled_modes',scheduledModes);
    addServerLog({type:'info',msg:`📞 [IVR] תזמון-מצב "${sm.name}" ${setActive?'הופעל':'הושבת'} ע"י מנהל (ID ${callerId})`,user:'IVR'});
    return res.send(ymResponse(`תזמון ${sm.name} ${setActive?'הופעל':'הושבת'} בהצלחה`));
  }catch(err){return res.send(ymResponse('שגיאה בביצוע הפעולה, נסה שוב'));}
}
app.get('/yemot/schedule', handleScheduleIvrRequest);
app.get('/schedule', handleScheduleIvrRequest);

// מעבר-מצב ישיר דרך IVR — **רק לאדמין** (בדיוק כמו ניהול-תוכניות/תיזמונים — זו פעולה משמעותית,
// לא הדלקת-ממסר-בודדת). מוגבל **רק** למצבים שסומנו m.ivr===true בממשק. שלב-שני (Duration) בוחר
// למשך-כמה-דקות המעבר יימשך — 0 = מעבר-קבוע, בלי-הגבלת-זמן (בדיוק כמו בממסרים). המנגנון-בפועל
// זהה-לחלוטין למה שכבר-קיים לטריגרים-חיצוניים (executeTriggerAction) — commitAutoModeSwitch,
// ואם יש משך — armPendingRevertTimer עם המצב-הקודם כיעד-החזרה, כולל שרידות-מלאה אחרי הפעלה-מחדש.
async function handleModeIvrRequest(req, res) {
  const modeNumStr=req.query.ModeNum||'',durationStr=req.query.Duration||'',callerPhone=req.query.ApiPhone||'',hangup=req.query.hangup==='yes';
  if(hangup) return res.send('');
  if(!modeNumStr||!durationStr||!callerPhone) return res.send(ymResponse('לא התקבל קלט מלא, נסה שוב'));
  const callerId=yemotPhoneMap[callerPhone];
  if(callerId===undefined) return res.send('id_list_message=t-אין הרשאה למספר זה&go_to_folder=hangup&');
  const perm=yemotPermissions[callerId]||{};
  if(!perm.isAdmin) return res.send('id_list_message=t-פעולה זו מוגבלת למנהל בלבד&go_to_folder=hangup&');
  // מיקום (1,2,3...) — לא id אמיתי — ראו getIvrModesOrdered, אותו עיקרון בדיוק כמו תוכניות/תיזמונים.
  const pos=parseInt(modeNumStr,10);
  const ivrModes=getIvrModesOrdered();
  const m=(pos>=1&&pos<=ivrModes.length)?ivrModes[pos-1]:null;
  if(!m) return res.send(ymResponse('קלט לא תקין, נסה שוב'));
  const durationMin=parseInt(durationStr,10);
  if(isNaN(durationMin)||durationMin<0) return res.send(ymResponse('קלט לא תקין, נסה שוב'));
  try{
    const prevModeId=schedulerActiveModeId;
    if(m.id===prevModeId){
      // כבר-במצב-הזה — אותו-עיקרון-בדיוק כמו בטריגר-חיצוני: לא-קוראים ל-commitAutoModeSwitch (no-op
      // ממילא), אבל אם התבקש-משך — מרעננים-אותו, בלי-ליצור-טיימר-חוזר-לעצמו (ראו executeTriggerAction).
      if(durationMin>0){
        if(_pendingRevertInfo && _pendingRevertInfo.modeJustSetTo===m.id){
          armPendingRevertTimer(_pendingRevertInfo.revertToMode, m.id, Date.now()+durationMin*60000);
          addServerLog({type:'info',msg:`📞 [IVR] כבר במצב "${m.name}" — זמן-החזרה רוענן (עוד ${durationMin} דק') ע"י מנהל (ID ${callerId})`,user:'IVR'});
          return res.send(ymResponse(`כבר במצב ${m.name} — זמן-החזרה רוענן`));
        }
        addServerLog({type:'info',msg:`📞 [IVR] כבר במצב "${m.name}" (ללא-הגבלת-זמן) — אין מצב-קודם-ידוע, לא נוצר טיימר-חזרה`,user:'IVR'});
        return res.send(ymResponse(`כבר במצב ${m.name}`));
      }
      return res.send(ymResponse(`כבר במצב ${m.name}`));
    }
    await commitAutoModeSwitch(m.id, `IVR — ID ${callerId}`);
    if(durationMin>0){
      armPendingRevertTimer(prevModeId, m.id, Date.now()+durationMin*60000);
    }
    addServerLog({type:'info',msg:`📞 [IVR] מעבר למצב "${m.name}"${durationMin>0?` למשך ${durationMin} דק'`:' (קבוע)'} ע"י מנהל (ID ${callerId})`,user:'IVR'});
    return res.send(ymResponse(`עברת למצב ${m.name}${durationMin>0?`, למשך ${durationMin} דקות`:''}`));
  }catch(err){return res.send(ymResponse('שגיאה בביצוע הפעולה, נסה שוב'));}
}
app.get('/yemot/mode', handleModeIvrRequest);
app.get('/mode', handleModeIvrRequest);

// גילינו (דרך רשת-הדיבוג למעלה) שימות לפעמים שולחת את הבקשה ל-"/" הגולמי, בלי-קשר-לנתיב
// שהוגדר בפועל ב-api_link (סיבה לא ברורה בצד-ימות — אולי caching, אולי טיפול-לא-אמין בנתיבים).
// כדי שהמערכת תעבוד **בכל מקרה**, בלי תלות בהתנהגות-הזו: "/" עצמו בודק את ה-query-parameters
// (לא את הנתיב) כדי להחליט לאיזו-לוגיקה להפנות — SchedNum→תיזמונים, ProgNum→תוכניות, Relay→ממסרים.
// אם אין אף אחד מהם (בקשה רגילה לדף-הבית) — ממשיכים הלאה (next) ליומן/סטטי הרגיל.
// "/" עצמו — משתמש באותה dispatchIvrRequest (ראו הגדרתה למעלה, ליד /yemot) — אבל אם באמת אין
// שום פרמטר-IVR בבקשה (למשל טעינת-הדף-הרגילה), ממשיכים הלאה (next) ליומן/סטטי הרגיל, לא עונים
// עם הודעת-שגיאה-של-ימות במקרה הזה.
// Ingress של HA פותח את השורש (/). אם זו לא קריאת-IVR, מגישים את הדשבורד עצמו — בלי ה-fallback
// הזה next() היה נופל ל-404 (express.static לא מוצא index.html) והפאנל בתפריט-הצד היה ריק.
app.get('/', (req, res) => dispatchIvrRequest(req, res, () => res.sendFile(path.join(__dirname, 'smart_home_v3.html'))));

app.get('/dashboard', (req, res) => res.redirect('/smart_home_v3.html'));

app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    mqtt: mqttConnected ? 'מחובר' : 'מנותק',
    uptime: Math.floor(process.uptime()) + ' שניות',
    states: relayState,
    haDevices: haDevices.length,
    controllers: CONTROLLERS.map(c => ({ id: c.id, name: c.name, online: controllerOnline[c.id] || false })),
  });
});

const PORT = process.env.PORT || 3000;

// טיפול בשגיאות לא מתוכננות — מונע קריסה שקטה
process.on('uncaughtException', (err) => {
  console.error(`💥 uncaughtException: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`💥 unhandledRejection: ${reason}`);
});

(async () => {
  loadConfigLocal();
  ensureAdminUser();
  // (הקפאת last_tick כבר בוצעה למעלה, ברגע-טעינת-הקובץ — לפני כל קוד אחר. לא נוגעים בזה כאן שוב.)
  rebuildHaRelayNames();
  connectMQTT();
  connectHAWebSocket();
  server.listen(PORT, () => {
    console.log(`\n🏠 שרת בית חכם (גרסה מקומית) פועל על פורט ${PORT}\n`);
    // אבחון-פתיחה: שתי השורות שמסבירות מיד "למה אין לי משתמש לבחור" בלי לנחש.
    console.log(`👤 משתמשים במערכת: ${runtimeUsers.length} (${runtimeUsers.map(u => u.name).join(', ') || 'אין'})`);
    console.log(`🔑 סיסמת חירום מהגדרות התוסף: ${EMERGENCY_PASSWORD ? 'הוגדרה' : 'חסרה — CONFIG_JSON לא הגיע מ-run.sh'}`);
    // **אישור-הפעלה גלוי, לא-רק-בקונסולה**: מציג-מיד באיזה-נתיב-בפועל נעשה שימוש לתקשורת מול-HA —
    // כדי שיהיה-ניתן-לוודא-שהתיקון (supervisor/core/api, לא-mDNS) פעיל, בלי-לחכות-לתקלת-רשת-הבאה.
    if (SUPERVISOR_TOKEN) {
      addServerLog({ type: 'info', msg: '✅ תקשורת-HA דרך הנתיב-הפנימי (supervisor/core/api) — לא-תלוי ב-mDNS/רשת-פיזית', user: 'מערכת' });
    } else {
      addServerLog({ type: 'warning', msg: `⚠️ SUPERVISOR_TOKEN לא-נמצא — משתמש בנתיב-הישן (${haUrl}) — וודא ש-homeassistant_api: true קיים ב-config.yaml`, user: 'מערכת' });
    }
  });
})();

// אם השורה הזו לא הגיעה (השרת בכלל לא היה עולה, כי JS שבור לא ירוץ) — הבעיה תתגלה כבר בכשל-עלייה.
// היא כאן בעיקר לשלמות הסימטריה מול smart_home_v3.html, ולמקרה של index.js קטום-אך-תקין-תחבירית.
const IDX_BOTTOM_MARK = 57;
