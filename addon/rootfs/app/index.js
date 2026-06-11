const express = require('express');
const mqtt = require('mqtt');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { HOLIDAY_CALENDAR } = require('./calendar_data.js');

// ── LOCAL CONFIG PERSISTENCE (Home Assistant add-on) ─────
// בתוך HAOS, תיקיית /data היא הנפח הקבוע של התוסף — נשמר בין הפעלות.
// מחוץ ל-HAOS (הרצה מקומית לבדיקה) — נשמר בתיקיית העבודה.
const DATA_DIR    = process.env.DATA_DIR || __dirname;
const LOCAL_CONFIG = path.join(DATA_DIR, 'server_config.json');

function loadConfigLocal() {
  try {
    if (!fs.existsSync(LOCAL_CONFIG)) { console.log('📂 אין קובץ הגדרות מקומי — מתחיל ריק'); return false; }
    const cfg = JSON.parse(fs.readFileSync(LOCAL_CONFIG, 'utf-8'));
    if (cfg.programs)              { schedulerPrograms = cfg.programs; console.log(`📂 נטענו ${schedulerPrograms.length} תוכניות מהדיסק`); }
    if (cfg.activeModeId !== undefined) schedulerActiveModeId = cfg.activeModeId;
    if (cfg.serverConfig)           serverConfig = cfg.serverConfig;
    if (cfg.users)                  runtimeUsers = cfg.users;
    console.log('✅ הגדרות נטענו מהדיסק');
    return true;
  } catch (e) {
    console.error('⚠️ שגיאה בטעינת הגדרות מקומיות:', e.message);
    return false;
  }
}

let _saveTimeoutLocal = null;
function saveConfigLocal() {
  // debounce — שמור לכל היותר פעם ב-3 שניות
  clearTimeout(_saveTimeoutLocal);
  _saveTimeoutLocal = setTimeout(() => {
    try {
      const cfg = {
        programs: schedulerPrograms,
        activeModeId: schedulerActiveModeId,
        serverConfig,
        users: runtimeUsers,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(LOCAL_CONFIG, JSON.stringify(cfg, null, 2));
      console.log('💾 הגדרות נשמרו לדיסק');
    } catch (e) {
      console.error('❌ שגיאה בשמירת הגדרות לדיסק:', e.message);
    }
  }, 3000);
}

// ── GITHUB CONFIG PERSISTENCE (אופציונלי — תאימות לאחור) ──
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO  = process.env.GITHUB_REPO  || '';
const CONFIG_FILE  = 'server_config.json';
const CONFIG_BRANCH = 'data'; // branch נפרד — לא מחובר ל-Railway

async function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const queryStr = method === 'GET' ? `?ref=${CONFIG_BRANCH}` : '';
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}${queryStr}`,
      method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'smarthome-server',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function loadConfigFromGitHub() {
  if (!GITHUB_TOKEN) { console.log('⚠️ אין GITHUB_TOKEN — לא טוען config'); return; }
  try {
    const res = await githubRequest('GET', CONFIG_FILE);
    if (res.content) {
      const raw = Buffer.from(res.content, 'base64').toString('utf-8');
      const cfg = JSON.parse(raw);
      if (cfg.programs)  { schedulerPrograms = cfg.programs; console.log(`📂 נטענו ${schedulerPrograms.length} תוכניות מ-GitHub`); }
      if (cfg.activeModeId !== undefined) schedulerActiveModeId = cfg.activeModeId;
      if (cfg.serverConfig) serverConfig = cfg.serverConfig;
      if (cfg.users) runtimeUsers = cfg.users;
      console.log('✅ config נטען מ-GitHub');
    }
  } catch(e) {
    console.log('⚠️ לא נמצא config ב-GitHub — מתחיל ריק');
  }
}

let _configSha = null; // SHA לעדכון קובץ קיים
let _saveTimeout = null;

async function saveConfigToGitHub() {
  if (!GITHUB_TOKEN) return;
  // debounce — שמור לכל היותר פעם ב-5 שניות
  clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(async () => {
    try {
      // קבל SHA עדכני
      const existing = await githubRequest('GET', CONFIG_FILE);
      const sha = existing.sha || _configSha;

      const cfg = {
        programs: schedulerPrograms,
        activeModeId: schedulerActiveModeId,
        serverConfig,
        users: runtimeUsers,
        savedAt: new Date().toISOString(),
      };
      const content = Buffer.from(JSON.stringify(cfg, null, 2)).toString('base64');
      const body = {
        message: `עדכון config — ${new Date().toLocaleString('he-IL')}`,
        content,
        branch: CONFIG_BRANCH,
        ...(sha ? { sha } : {})
      };
      const res = await githubRequest('PUT', CONFIG_FILE, body);
      if (res.content) {
        _configSha = res.content.sha;
        console.log('💾 config נשמר ב-GitHub');
      }
    } catch(e) {
      console.error('❌ שגיאה בשמירת config ל-GitHub:', e.message);
    }
  }, 5000);
}

// ── עטיפות אחידות — מקומי כברירת מחדל, GitHub רק אם הוגדר token ──
function saveConfig() {
  saveConfigLocal();
  if (GITHUB_TOKEN) saveConfigToGitHub();
}

async function loadConfig() {
  const loaded = loadConfigLocal();
  // אם אין הגדרות מקומיות אבל יש GitHub token — נסה לטעון משם (מיגרציה מהמערכת הישנה)
  if (!loaded && GITHUB_TOKEN) {
    await loadConfigFromGitHub();
    saveConfigLocal(); // שמור עותק מקומי לפעם הבאה
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

// ── חיבור MQTT ───────────────────────────────────────────
// בתוך HAOS, run.sh מזריק את פרטי ה-broker המקומי (Mosquitto) דרך משתני סביבה.
// אין fallback מקודד — אם אין MQTT_HOST, התוסף לא מנסה להתחבר (ראה connectMQTT).
const MQTT_HOST = process.env.MQTT_HOST || '';
const MQTT_PORT = process.env.MQTT_PORT || '1883';
const MQTT_USER = process.env.MQTT_USER || '';
const MQTT_PASS = process.env.MQTT_PASS || '';
const MQTT_URL  = MQTT_HOST ? `mqtt://${MQTT_HOST}:${MQTT_PORT}` : null;

// ── הגדרת בקרים ──────────────────────────────────────────
// כדי להוסיף בקר: הוסף אובייקט נוסף לרשימה
const CONTROLLERS = [
  {
    id: 'main',
    name: 'בית',
    topic: 'tasmota_D3D204',
    relayCount: 6,
    relayNames: {
      1: 'דוד מים',
      2: 'מזגן סלון',
      3: 'תאורת כניסה',
      4: 'ממסר 4',
      5: 'ממסר 5',
      6: 'ממסר 6',
    }
  },
  {
    id: 'second',
    name: 'קומה שנייה',
    topic: 'tasmota_6CC008', // ← שנה לשם הבקר האמיתי כשיגיע
    relayCount: 8,
    relayNames: {
      1: 'ממסר ב1',
      2: 'ממסר ב2',
      3: 'ממסר ב3',
      4: 'ממסר ב4',
      5: 'ממסר ב5',
      6: 'ממסר ב6',
      7: 'ממסר ב7',
      8: 'ממסר ב8',
    }
  },
];

// תאימות לאחור — הבקר הראשי
const TASMOTA_TOPIC = CONTROLLERS[0].topic;
const RELAY_NAMES = CONTROLLERS[0].relayNames;

const ACTIONS = {
  '1':  { relay: 1, state: 'ON',  label: () => `${RELAY_NAMES[1]} הודלק`  },
  '2':  { relay: 2, state: 'ON',  label: () => `${RELAY_NAMES[2]} הודלק`  },
  '3':  { relay: 3, state: 'ON',  label: () => `${RELAY_NAMES[3]} הודלקה` },
  '4':  { relay: 4, state: 'ON',  label: () => `${RELAY_NAMES[4]} הודלק`  },
  '5':  { relay: 5, state: 'ON',  label: () => `${RELAY_NAMES[5]} הודלק`  },
  '6':  { relay: 6, state: 'ON',  label: () => `${RELAY_NAMES[6]} הודלק`  },
  '7':  { relay: 1, state: 'OFF', label: () => `${RELAY_NAMES[1]} כובה`   },
  '8':  { relay: 2, state: 'OFF', label: () => `${RELAY_NAMES[2]} כובה`   },
  '9':  { relay: 3, state: 'OFF', label: () => `${RELAY_NAMES[3]} כובתה`  },
  '10': { relay: 4, state: 'OFF', label: () => `${RELAY_NAMES[4]} כובה`   },
  '11': { relay: 5, state: 'OFF', label: () => `${RELAY_NAMES[5]} כובה`   },
  '12': { relay: 6, state: 'OFF', label: () => `${RELAY_NAMES[6]} כובה`   },
  '13': { relay: 'all', state: 'ON',  label: () => 'כל הממסרים הודלקו'    },
  '14': { relay: 'all', state: 'OFF', label: () => 'כל הממסרים כובו'      },
};

// מספרי טלפון מורשים לשליטה דרך "ימות המשיח" — מוגדרים בהגדרות התוסף
// (allowed_phones), מופרדים בפסיק. ריק = אף מספר לא מורשה.
const ALLOWED_NUMBERS = (process.env.ALLOWED_PHONES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const relayState = { 1: 'OFF', 2: 'OFF', 3: 'OFF', 4: 'OFF', 5: 'OFF', 6: 'OFF', 7: 'OFF', 8: 'OFF', 9: 'OFF', 10: 'OFF', 11: 'OFF', 12: 'OFF', 13: 'OFF', 14: 'OFF' };
const _pendingConfirm = {}; // טיימרים לאישור בקר

// בנה schedulerRelayNames מכל הבקרים עם offset לכל בקר
const schedulerRelayNames = {};
let _relayOffset = 0;
CONTROLLERS.forEach(ctrl => {
  ctrl._offset = _relayOffset; // שמור offset לשימוש ב-publishRelay
  Object.entries(ctrl.relayNames).forEach(([localId, name]) => {
    const globalId = parseInt(localId) + _relayOffset;
    schedulerRelayNames[globalId] = name;
  });
  _relayOffset += ctrl.relayCount;
});

// מצא בקר לפי מזהה ממסר גלובלי
function getControllerForRelay(globalRelayId) {
  let offset = 0;
  for (const ctrl of CONTROLLERS) {
    if (globalRelayId > offset && globalRelayId <= offset + ctrl.relayCount) {
      return { ctrl, localId: globalRelayId - offset };
    }
    offset += ctrl.relayCount;
  }
  return { ctrl: CONTROLLERS[0], localId: globalRelayId };
}

// ── SCHEDULER STATE ─────────────────────────────────────
let schedulerPrograms = [];
let schedulerActiveModeId = 0;
const _firedToday = new Set();
const _durationTimers = {};

// אינדקס מהיר לפי תאריך לועזי
const _calendarIndex = {};
for (const entry of HOLIDAY_CALENDAR) {
  _calendarIndex[entry['תאריך לועזי']] = entry;
}

let mqttClient = null;
let mqttConnected = false;
// מצב כל בקר בנפרד — מפתח: ctrl.id
const controllerOnline = {};
CONTROLLERS.forEach(ctrl => { controllerOnline[ctrl.id] = false; });

function connectMQTT() {
  if (!MQTT_URL) {
    console.error('❌ אין הגדרת MQTT (MQTT_HOST) — ודא שהתוסף Mosquitto broker מותקן ופועל.');
    return;
  }
  console.log('מתחבר ל-Mosquitto...');
  mqttClient = mqtt.connect(MQTT_URL, {
    reconnectPeriod: 5000,
    ...(MQTT_USER ? { username: MQTT_USER, password: MQTT_PASS } : {}),
  });

  mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log('✅ מחובר ל-Mosquitto');
    // רשום לכל הבקרים
    CONTROLLERS.forEach(ctrl => {
      for (let i = 1; i <= ctrl.relayCount; i++) {
        mqttClient.subscribe(`stat/${ctrl.topic}/POWER${i}`);
      }
      mqttClient.subscribe(`stat/${ctrl.topic}/RESULT`);
      mqttClient.subscribe(`tele/${ctrl.topic}/STATE`);
      mqttClient.subscribe(`tele/${ctrl.topic}/LWT`);
      mqttClient.publish(`cmnd/${ctrl.topic}/STATUS`, '11');
    });
    io.emit('mqtt_status', { connected: true });
  });

  mqttClient.on('message', (topic, message) => {
    const payload = message.toString();

    // זהה את הבקר לפי הנושא
    const ctrl = CONTROLLERS.find(c => topic.includes(c.topic));
    const ctrlName = ctrl ? ctrl.name : 'בקר';

    // עדכון מצב ממסר בודד — המר מזהה מקומי לגלובלי
    const matchPower = topic.match(/stat\/.+\/POWER(\d+)$/);
    if (matchPower && ctrl) {
      const localId = parseInt(matchPower[1]);
      const globalId = localId + (ctrl._offset || 0);
      relayState[globalId] = payload.toUpperCase();
      console.log(`📥 ${ctrlName} ממסר ${localId} (גלובלי ${globalId}) = ${payload}`);
      io.emit('relay_state', { id: globalId, state: payload.toUpperCase() });
      if (_pendingConfirm[globalId]) {
        clearTimeout(_pendingConfirm[globalId]);
        delete _pendingConfirm[globalId];
      }
      const relayName = schedulerRelayNames[globalId] || `ממסר ${globalId}`;
      addServerLog({ type: 'success', msg: `✔ בקר אישר: ${relayName} → ${payload.toUpperCase()}`, user: ctrlName });
    }

    // מצב בקר — LWT
    if (topic.endsWith('/LWT')) {
      const isOnline = payload === 'Online';
      if (ctrl) controllerOnline[ctrl.id] = isOnline;
      console.log(`${isOnline ? '🟢' : '🔴'} ${ctrlName}: ${payload}`);
      io.emit('controller_status', { online: isOnline, controller: ctrlName, controllerId: ctrl?.id });
      addServerLog({
        type: isOnline ? 'success' : 'danger',
        msg: `${isOnline ? '🟢' : '🔴'} ${ctrlName} ${isOnline ? 'התחבר' : 'התנתק'}`,
        user: 'בקר'
      });
    }


    // עדכון מ-RESULT
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

    // עדכון מ-STATE התקופתי
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

  mqttClient.on('error', (e) => {
    mqttConnected = false;
    console.error('❌ שגיאת MQTT:', e.message);
    io.emit('mqtt_status', { connected: false });
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    console.log('⚠️ MQTT מנותק — מנסה שוב...');
    io.emit('mqtt_status', { connected: false });
  });
}

function publishRelay(relayId, state) {
  return new Promise((resolve, reject) => {
    if (!mqttConnected) {
      addServerLog({ type: 'danger', msg: `❌ לא ניתן לשלוח לממסר ${relayId} — MQTT מנותק`, user: 'שרת' });
      reject(new Error('לא מחובר')); return;
    }
    const { ctrl, localId } = getControllerForRelay(relayId);
    const topic = `cmnd/${ctrl.topic}/POWER${localId}`;
    const relayName = schedulerRelayNames[relayId] || `ממסר ${relayId}`;
    mqttClient.publish(topic, state, { qos: 1 }, (err) => {
      if (err) {
        addServerLog({ type: 'danger', msg: `❌ שגיאה בשליחה לממסר ${relayId} (${relayName}): ${err.message}`, user: 'שרת' });
        reject(err); return;
      }
      relayState[relayId] = state;
      console.log(`📤 ${topic} → ${state}`);
      addServerLog({ type: 'sent', msg: `📤 שרת שלח: ${relayName} → ${state}`, user: 'שרת' });

      // אם לא מגיע אישור מהבקר תוך 5 שניות — רשום אזהרה
      const confirmTimer = setTimeout(() => {
        addServerLog({ type: 'warning', msg: `⚠️ לא התקבל אישור מהבקר: ${relayName} (${state})`, user: 'בקר' });
      }, 5000);
      // שמור את הטיימר לביטול כשיגיע אישור
      _pendingConfirm[relayId] = confirmTimer;

      resolve();
    });
  });
}

// ── USERS (נשמר בשרת בלבד — לא נחשף לדפדפן) ────────────
// המערכת מתחילה עם משתמש אדמין יחיד; סיסמתו מוגדרת בהגדרות התוסף
// (admin_password). את שאר המשתמשים (בני הבית) האדמין יוצר דרך הממשק,
// והם נשמרים מקומית ב-/data. כך אין סיסמאות מקודדות בקוד.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
if (ADMIN_PASSWORD === 'changeme') {
  console.warn('⚠️ סיסמת אדמין היא ברירת המחדל! שנה את admin_password בהגדרות התוסף.');
}
const USERS = [
  {
    name: 'אדמין', initials: 'אד', password: ADMIN_PASSWORD,
    role: 'admin',
    relays: [1,2,3,4,5,6],
    canEditPrograms: true, canAddPrograms: true, canDeletePrograms: true,
    canChangeMode: true, canViewLog: true,
    maxOnMinutes: null,
    allowedHours: null,
  },
];

// פרופיל ציבורי — ללא סיסמה
function publicProfile(u) {
  const { password, ...pub } = u;
  return pub;
}

// משתמשים בזמן ריצה — מתחיל מהקוד, מתעדכן מ-GitHub
let runtimeUsers = USERS.map(u => ({ ...u }));

// ── SERVER-SIDE CONFIG STORE ────────────────────────────
let serverConfig = null;

// ── SERVER LOG (30 יום) ──────────────────────────────────
const serverLog = [];
const MAX_LOG_DAYS = 30;

function pruneLog() {
  const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
  while (serverLog.length && new Date(serverLog[serverLog.length-1].ts).getTime() < cutoff) {
    serverLog.pop();
  }
}

function addServerLog(entry) {
  const now = new Date();
  const nowIL = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  serverLog.unshift({
    ...entry,
    ts: now.toISOString(),
    time: nowIL.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: nowIL.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }),
  });
  pruneLog();
  io.emit('log_broadcast', serverLog[0]);
}

// Socket.io — חיבור ממשק
io.on('connection', (socket) => {
  console.log('🖥️ ממשק התחבר');
  socket.emit('mqtt_status', { connected: mqttConnected });
  socket.emit('all_states', relayState);
  // שלח מצב לכל בקר בנפרד
  CONTROLLERS.forEach(ctrl => {
    socket.emit('controller_status', { online: controllerOnline[ctrl.id] || false, controller: ctrl.name, controllerId: ctrl.id });
  });

  // שלח הגדרות שמורות לדפדפן חדש
  if (serverConfig) {
    socket.emit('server_config', serverConfig);
    console.log('📤 נשלחו הגדרות לדפדפן חדש');
  }

  // שלח יומן שרת לדפדפן חדש
  if (serverLog.length) {
    socket.emit('server_log', serverLog);
  }

  // התחברות משתמש
  socket.on('login', ({ name, password }) => {
    const user = runtimeUsers.find(u => u.name === name && u.password === password);
    if (user) {
      console.log(`🔑 כניסה: ${user.name}`);
      addServerLog({ type: 'info', msg: `כניסה למערכת: ${user.name}`, user: user.name });
      socket.emit('login_result', { success: true, user: publicProfile(user) });
      // שלח יומן אחרי כניסה
      socket.emit('server_log', serverLog);
    } else {
      console.log(`❌ כניסה נכשלה: ${name}`);
      socket.emit('login_result', { success: false });
    }
  });

  // שליחת רשימת משתמשים ציבורית (ללא סיסמאות)
  socket.on('get_users', () => {
    socket.emit('users_list', runtimeUsers.map(u => publicProfile(u)));
  });

  // קבל פקודת הפעלה מהממשק
  socket.on('relay_command', async ({ id, state }) => {
    try {
      if (id === 'all') {
        const totalRelays = CONTROLLERS.reduce((sum, c) => sum + c.relayCount, 0);
        for (let i = 1; i <= totalRelays; i++) await publishRelay(i, state);
      } else {
        await publishRelay(parseInt(id), state);
      }
    } catch(err) {
      console.error('❌', err.message);
    }
  });

  // קבל תוכניות מהממשק ושמור בזיכרון השרת
  socket.on('sync_programs', ({ programs, activeModeId, relayNames, modes, fullConfig }) => {
    schedulerPrograms = programs || [];
    schedulerActiveModeId = activeModeId || 0;
    _firedToday.clear();
    if (relayNames) {
      relayNames.forEach(r => { schedulerRelayNames[r.id] = r.name; });
    }
    if (fullConfig) serverConfig = fullConfig;
    console.log(`📋 סונכרנו ${schedulerPrograms.length} תוכניות, מצב פעיל: ${schedulerActiveModeId}`);
    socket.emit('sync_ack', { count: schedulerPrograms.length });
    saveConfig();
  });

  // ניהול משתמשים (אדמין בלבד)
  socket.on('save_users', (users) => {
    // שמור סיסמאות קיימות למשתמשים שלא שינו סיסמה
    runtimeUsers = users.map(u => {
      if (u.password) return u; // יש סיסמה חדשה
      const existing = runtimeUsers.find(r => r.name === u.name);
      return { ...u, password: existing?.password || '' };
    });
    io.emit('users_list', runtimeUsers.map(u => publicProfile(u)));
    saveConfig();
    console.log(`👥 נשמרו ${runtimeUsers.length} משתמשים`);
  });

  // קבל רשומת יומן מהממשק
  socket.on('log_entry', (entry) => {
    addServerLog(entry);
  });

  socket.on('disconnect', () => {
    console.log('🖥️ ממשק התנתק');
  });
});

// ── SCHEDULER ENGINE ────────────────────────────────────

function getZmanim(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const dateStr = `${dd}/${mm}/${yyyy}`;
  const entry = _calendarIndex[dateStr];
  if (!entry) {
    console.log(`⚠️ לא נמצא תאריך בלוח שנה: ${dateStr}`);
    return {};
  }
  return {
    sunrise:      entry['נץ החמה'],
    sunset:       entry['שקיעה'],
    candles:      entry['שקיעה'],       // ערב שבת/חג — שקיעה (ניתן לשנות ל-18 לפני)
    havdalah:     entry['מוצאי שבת'],
    tzeit:        entry['צאת הכוכבים'],
    alotHaShachar:entry['עלות השחר'],
    minchaGedola: entry['מנחה גדולה'],
    rabeinuTam:   entry['רבינו תם'],
  };
}

function zmanimKeyForZman(zman) {
  const map = {
    sunset:    'sunset',
    sunrise:   'sunrise',
    candles:   'candles',
    havdalah:  'havdalah',
    tzeit:     'tzeit',
    dawn:      'alotHaShachar',
    mincha:    'minchaGedola',
    rabeinuTam:'rabeinuTam',
  };
  return map[zman] || zman;
}

function timeStrToMinutes(timeStr) {
  if (!timeStr) return null;
  const [hh, mm] = timeStr.split(':').map(Number);
  return hh * 60 + mm;
}

function getProgMinutes(p, zmanim) {
  if (p.type === 'time') {
    const [hh, mm] = p.time.split(':').map(Number);
    return hh * 60 + mm;
  }
  // זמן הלכתי
  const key = zmanimKeyForZman(p.zman);
  const timeStr = zmanim[key];
  const base = timeStrToMinutes(timeStr);
  if (base === null) {
    console.log(`⚠️ זמן הלכתי לא נמצא: ${p.zman} (${key})`);
    return -1;
  }
  const offset = (p.offsetDir === '-' ? -1 : 1) * (p.offsetVal || 0);
  return base + offset;
}

async function schedulerTick() {
  if (!schedulerPrograms.length) return;
  const now = new Date();
  const nowIL = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const nowMin = nowIL.getHours() * 60 + nowIL.getMinutes();
  const todayKey = nowIL.toDateString();
  const dow = nowIL.getDay();

  _firedToday.forEach(k => { if (!k.endsWith(todayKey)) _firedToday.delete(k); });

  const zmanim = getZmanim(nowIL);

  for (const p of schedulerPrograms) {
    if (!p.active) continue;
    const modeId = (p.modeId !== null && p.modeId !== undefined) ? p.modeId : 0;
    if (modeId !== schedulerActiveModeId) continue;
    const hasDays = p.days && p.days.length > 0;
    if (hasDays && !p.days.includes(dow)) continue;

    // בדיקת תאריך מיוחד (calType)
    if (p.calType && p.calType !== 'none') {
      const dd = nowIL.getDate();
      const mm = nowIL.getMonth() + 1;
      const yyyy = nowIL.getFullYear();
      if (p.calType === 'annual') {
        if (dd !== p.calDay || mm !== p.calMonth) continue;
      } else if (p.calType === 'once') {
        if (dd !== p.calDay || mm !== p.calMonth || yyyy !== p.calYear) continue;
      }
    }
    const fireKey = `${p.id}_${todayKey}`;
    if (_firedToday.has(fireKey)) continue;
    const progMin = getProgMinutes(p, zmanim);
    if (progMin < 0 || nowMin !== progMin) continue;

    _firedToday.add(fireKey);
    console.log(`⏰ [תזמון] תוכנית "${p.name}" מופעלת`);

    (p.relay || []).forEach((relayId, idx) => {
      const delayMs = idx * (p.delay || 0) * 1000;
      setTimeout(async () => {
        try {
          await publishRelay(relayId, p.action);
          io.emit('scheduler_fired', { progName: p.name, relayId, action: p.action });
          addServerLog({ type: 'info', msg: `[תזמון] תוכנית "${p.name}" — ממסר ${relayId} → ${p.action}`, user: 'מערכת' });
          console.log(`📤 [תזמון] ממסר ${relayId} → ${p.action}`);

          if (p.durationOn && ((p.durationH || 0) + (p.durationM || 0) > 0)) {
            const totalMs = ((p.durationH || 0) * 60 + (p.durationM || 0)) * 60000;
            const reverseAction = p.action === 'ON' ? 'OFF' : 'ON';
            const timerKey = `${p.id}_${relayId}`;
            clearTimeout(_durationTimers[timerKey]);
            _durationTimers[timerKey] = setTimeout(async () => {
              await publishRelay(relayId, reverseAction);
              io.emit('scheduler_fired', { progName: p.name, relayId, action: reverseAction });
              console.log(`📤 [למשך] ממסר ${relayId} → ${reverseAction}`);
            }, totalMs);
          }
        } catch(err) {
          console.error(`❌ [תזמון] שגיאה בממסר ${relayId}:`, err.message);
        }
      }, delayMs);
    });
  }
}

// הרץ כל 30 שניות
setInterval(schedulerTick, 30000);
schedulerTick();

// ── ימות המשיח ──────────────────────────────────────────
function ymResponse(text) {
  const clean = text
    .replace(/[:]/g, " , ")
    .replace(/\.{2,}/g, " , ")
    .replace(/\.(?!\d)/g, " , ")
    .replace(/[*#_>"]/g, "")
    .replace(/\n/g, " , ")
    .replace(/\s+/g, " ")
    .trim();
  return `id_list_message=t-${clean}`;
}

app.get('/yemot', async (req, res) => {
  const digits      = req.query.Digits    || '';
  const callerPhone = req.query.ApiPhone  || '';
  const hangup      = req.query.hangup === 'yes';

  if (digits && callerPhone && !ALLOWED_NUMBERS.includes(callerPhone)) {
    return res.send('id_list_message=t-אין הרשאה למספר זה&go_to_folder=hangup&');
  }

  if (digits) {
    const action = ACTIONS[digits];
    if (action) {
      try {
        if (action.relay === 'all') {
          for (let i = 1; i <= 6; i++) await publishRelay(i, action.state);
        } else {
          await publishRelay(action.relay, action.state);
        }
      } catch (err) {
        console.error('❌ שגיאת MQTT:', err.message);
      }
    }
  }

  if (hangup) return res.send('');
  if (!digits) return res.send(ymResponse('לא התקבלה ספרה, נסה שוב'));

  const action = ACTIONS[digits];
  if (!action) return res.send(ymResponse(`ספרה ${digits} לא קיימת במערכת`));
  return res.send(ymResponse(`${action.label()}, בוצע בהצלחה`));
});

// דף הבית — מגיש את הדשבורד ישירות (עובד גם בגישה ישירה וגם דרך Ingress)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'smart_home_v3.html')));
app.get('/dashboard', (req, res) => res.redirect('/smart_home_v3.html'));

app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    mqtt: mqttConnected ? 'מחובר' : 'מנותק',
    uptime: Math.floor(process.uptime()) + ' שניות',
    states: relayState,
    controllers: CONTROLLERS.map(c => ({ id: c.id, name: c.name, online: controllerOnline[c.id] || false })),
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`\n🏠 שרת בית חכם פועל על פורט ${PORT}\n`);
  await loadConfig();
  // סיסמת האדמין שבהגדרות התוסף היא תמיד מקור האמת — גם אחרי טעינת config שמור.
  // כך אפשר לאפס את סיסמת האדמין דרך הגדרות התוסף בכל עת.
  const admin = runtimeUsers.find(u => u.role === 'admin');
  if (admin && admin.password !== ADMIN_PASSWORD) {
    admin.password = ADMIN_PASSWORD;
    console.log('🔑 סיסמת האדמין סונכרנה מהגדרות התוסף');
  }
  connectMQTT();
});
