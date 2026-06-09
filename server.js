require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let cachedVehicles = [];
let cachedAlerts = [];
let adminMessages = [];
let lastFetch = 0;
let fetchError = null;

const ADMIN_PASS = process.env.ADMIN_PASS || 'yyctransit2024';
const APP_TOKEN = process.env.CALGARY_APP_TOKEN || 'qcf0fYeug3dhEefuN2wv1Ybq4';

const VEHICLE_URL = 'https://data.calgary.ca/resource/am7c-qe3u.json?$limit=2000';
const ALERTS_URL  = 'https://data.calgary.ca/resource/jhgn-ynqj.json?$limit=50';

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'X-App-Token': APP_TOKEN,
        'Accept': 'application/json'
      }
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch(e) {
    clearTimeout(timer);
    throw e;
  }
}

async function refreshData() {
  console.log(`[${new Date().toISOString()}] Fetching... token: ${APP_TOKEN.slice(0,8)}...`);
  try {
    const raw = await fetchJSON(VEHICLE_URL);
    if (!Array.isArray(raw)) throw new Error('Not array: ' + typeof raw);
    console.log(`Got ${raw.length} records. Keys: ${raw.length>0?Object.keys(raw[0]).join(','):''}`);

    cachedVehicles = raw
      .filter(v => v.latitude && v.longitude)
      .map(v => ({
        id:       v.vehicle_id || v.id || `${v.latitude},${v.longitude}`,
        label:    v.vehicle_label || v.vehicle_id || '',
        route:    v.route_id || v.route_short_name || '',
        tripId:   v.trip_id || '',
        headsign: v.trip_headsign || '',
        lat:      parseFloat(v.latitude),
        lng:      parseFloat(v.longitude),
        bearing:  v.bearing ? parseFloat(v.bearing) : null,
        speed:    v.speed ? Math.round(parseFloat(v.speed) * 3.6) : 0,
        status:   v.current_status || 'IN_TRANSIT_TO',
        delay:    0,
        ts:       v.timestamp || Date.now() / 1000
      }));

    lastFetch = Date.now();
    fetchError = null;
    console.log(`✅ ${cachedVehicles.length} vehicles loaded`);

    try {
      const ar = await fetchJSON(ALERTS_URL);
      if (Array.isArray(ar)) {
        cachedAlerts = ar.map(a => ({
          id: a.alert_id || String(Math.random()),
          header: a.header_text || 'Service Alert',
          description: a.description_text || '',
          route: a.route_id || ''
        }));
        console.log(`✅ ${cachedAlerts.length} alerts`);
      }
    } catch(e) { console.warn('Alerts failed:', e.message); }

  } catch(e) {
    fetchError = e.message;
    console.error(`❌ Failed: ${e.message}`);
    if (cachedVehicles.length === 0) setTimeout(refreshData, 15000);
  }
}

refreshData();
setInterval(refreshData, 30000);

app.get('/api/status', (req, res) => res.json({
  ok: true,
  vehicles: cachedVehicles.length,
  alerts: cachedAlerts.length,
  messages: adminMessages.filter(m=>m.active).length,
  lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
  ageSeconds: lastFetch ? Math.round((Date.now()-lastFetch)/1000) : null,
  error: fetchError
}));

app.get('/api/debug', async (req, res) => {
  try {
    const raw = await fetchJSON('https://data.calgary.ca/resource/am7c-qe3u.json?$limit=2');
    res.json({ ok: true, count: raw.length, fields: raw.length>0?Object.keys(raw[0]):[], sample: raw[0] });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/vehicles', (req, res) => {
  let v = cachedVehicles;
  if (req.query.route) v = v.filter(x => x.route === req.query.route);
  res.json({ vehicles: v, lastFetch, count: v.length });
});

app.get('/api/nearby', (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius) || 1.5;
  if (isNaN(lat)||isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });

  const withDist = cachedVehicles.map(v => {
    const dist = haversine(v.lat, v.lng, lat, lng);
    return { ...v, distKm: parseFloat(dist.toFixed(2)), etaMin: Math.round((dist/(v.speed>5?v.speed:20))*60) };
  });

  const nearby = withDist.filter(v=>v.distKm<=radius).sort((a,b)=>a.etaMin-b.etaMin);
  let nearbyRoutes = [];
  if (!nearby.length) {
    const seen = new Set();
    nearbyRoutes = withDist.filter(v=>v.distKm<=5).sort((a,b)=>a.distKm-b.distKm)
      .filter(v=>{ if(seen.has(v.route)) return false; seen.add(v.route); return true; }).slice(0,20);
  }
  res.json({ userLat:lat, userLng:lng, nearby, nearbyRoutes, noBusesClose:!nearby.length, lastFetch, count:nearby.length });
});

app.get('/api/alerts', (req, res) => res.json({ alerts: cachedAlerts }));
app.get('/api/messages', (req, res) => res.json({ messages: adminMessages.filter(m=>m.active) }));

app.post('/api/admin/login', (req, res) => {
  req.body.password === ADMIN_PASS
    ? res.json({ ok:true, token: Buffer.from(ADMIN_PASS).toString('base64') })
    : res.status(401).json({ error:'Invalid password' });
});

function adminAuth(req, res, next) {
  const t = req.headers['x-admin-token'];
  if (!t || Buffer.from(t,'base64').toString() !== ADMIN_PASS)
    return res.status(401).json({ error:'Unauthorized' });
  next();
}

app.post('/api/admin/messages', adminAuth, (req, res) => {
  const { text, type, expiresIn } = req.body;
  if (!text?.trim()) return res.status(400).json({ error:'text required' });
  const msg = { id: Date.now().toString(), text: text.trim().slice(0,280),
    type: ['info','warning','alert'].includes(type)?type:'info', active:true,
    createdAt: new Date().toISOString(),
    expiresAt: expiresIn ? new Date(Date.now()+expiresIn*60000).toISOString() : null };
  adminMessages.unshift(msg);
  if (adminMessages.length>20) adminMessages=adminMessages.slice(0,20);
  if (expiresIn) setTimeout(()=>{ const m=adminMessages.find(x=>x.id===msg.id); if(m) m.active=false; }, expiresIn*60000);
  res.json({ ok:true, message:msg });
});

app.delete('/api/admin/messages/:id', adminAuth, (req, res) => {
  const m = adminMessages.find(x=>x.id===req.params.id);
  if (!m) return res.status(404).json({ error:'Not found' });
  m.active = false; res.json({ ok:true });
});

app.get('/api/admin/messages', adminAuth, (req, res) => res.json({ messages: adminMessages }));

app.post('/api/admin/refresh', adminAuth, async (req, res) => {
  await refreshData();
  res.json({ ok:true, vehicles: cachedVehicles.length, error: fetchError });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚌 YYC Transit on port ${PORT}`));
