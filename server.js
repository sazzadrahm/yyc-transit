
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store ───────────────────────────────────────────────────────
let cachedVehicles = [];
let cachedAlerts = [];
let adminMessages = [];
let lastFetch = 0;

const ADMIN_PASS = process.env.ADMIN_PASS || 'yyctransit2024';

// Calgary Open Data — JSON endpoints (no protobuf, no CORS issues server-side)
const VEHICLE_URL = 'https://data.calgary.ca/resource/am7c-qe3u.json?$limit=2000';
const TRIPS_URL   = 'https://data.calgary.ca/resource/gs4m-mdc2.json?$limit=2000';
const ALERTS_URL  = 'https://data.calgary.ca/resource/jhgn-ynqj.json?$limit=50';

// ── Haversine distance (km) ───────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
    Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Fetch Calgary Transit data ────────────────────────────────────────────
async function refreshData() {
  try {
    console.log('🔄 Fetching Calgary Transit data…');

    const headers = { 'User-Agent': 'YYCTransit/1.0 (yyctransit.ca)' };

    const [vRes, tRes, aRes] = await Promise.allSettled([
      fetch(VEHICLE_URL, { headers, timeout: 15000 }).then(r => r.json()),
      fetch(TRIPS_URL,   { headers, timeout: 15000 }).then(r => r.json()),
      fetch(ALERTS_URL,  { headers, timeout: 15000 }).then(r => r.json())
    ]);

    // Build trip headsign lookup from trip updates
    const headsigns = {};
    if (tRes.status === 'fulfilled' && Array.isArray(tRes.value)) {
      tRes.value.forEach(t => {
        const tripId = t.trip_id || t.id;
        if (tripId && t.trip_headsign) headsigns[tripId] = t.trip_headsign;
      });
      console.log(`✅ ${tRes.value.length} trip updates loaded`);
    }

    // Process vehicles
    if (vRes.status === 'fulfilled' && Array.isArray(vRes.value)) {
      cachedVehicles = vRes.value
        .filter(v => v.latitude && v.longitude)
        .map(v => {
          const lat = parseFloat(v.latitude);
          const lng = parseFloat(v.longitude);
          const speed = v.speed ? Math.round(parseFloat(v.speed) * 3.6) : 0;
          const route = v.route_id || v.route_short_name || '';
          const tripId = v.trip_id || '';
          return {
            id:       v.vehicle_id || v.id || `${lat},${lng}`,
            label:    v.vehicle_label || v.vehicle_id || '',
            route:    route,
            tripId:   tripId,
            headsign: v.trip_headsign || headsigns[tripId] || '',
            lat,
            lng,
            bearing:  v.bearing  ? parseFloat(v.bearing)  : null,
            speed,
            status:   v.current_status || 'IN_TRANSIT_TO',
            stopId:   v.stop_id || '',
            delay:    0,
            ts:       v.timestamp || Date.now() / 1000
          };
        });

      lastFetch = Date.now();
      console.log(`✅ ${cachedVehicles.length} vehicles loaded`);
    } else {
      console.error('❌ Vehicle fetch failed:', vRes.reason?.message || 'unknown');
    }

    // Process alerts
    if (aRes.status === 'fulfilled' && Array.isArray(aRes.value)) {
      cachedAlerts = aRes.value.map(a => ({
        id:          a.alert_id || String(Math.random()),
        header:      a.header_text || 'Service Alert',
        description: a.description_text || '',
        route:       a.route_id || '',
        effect:      a.effect || '',
        cause:       a.cause  || ''
      }));
      console.log(`✅ ${cachedAlerts.length} alerts loaded`);
    }

  } catch (e) {
    console.error('❌ refreshData error:', e.message);
  }
}

// Refresh on startup and every 30 seconds
refreshData();
setInterval(refreshData, 30000);

// ── API Routes ────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    vehicles: cachedVehicles.length,
    alerts:   cachedAlerts.length,
    messages: adminMessages.filter(m => m.active).length,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
    ageSeconds: lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null
  });
});

app.get('/api/vehicles', (req, res) => {
  let v = cachedVehicles;
  if (req.query.route) v = v.filter(x => x.route === req.query.route);
  res.json({ vehicles: v, lastFetch, count: v.length });
});

app.get('/api/nearby', (req, res) => {
  const lat    = parseFloat(req.query.lat);
  const lng    = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius) || 1.5;

  if (isNaN(lat) || isNaN(lng))
    return res.status(400).json({ error: 'lat and lng required' });

  const withDist = cachedVehicles.map(v => {
    const dist = haversine(v.lat, v.lng, lat, lng);
    const speedKmh = v.speed > 5 ? v.speed : 20;
    const etaMin = Math.round((dist / speedKmh) * 60);
    return { ...v, distKm: parseFloat(dist.toFixed(2)), etaMin };
  });

  const nearby = withDist
    .filter(v => v.distKm <= radius)
    .sort((a, b) => a.etaMin - b.etaMin);

  // If nothing close, return unique routes within 5km
  let nearbyRoutes = [];
  if (nearby.length === 0) {
    const seen = new Set();
    nearbyRoutes = withDist
      .filter(v => v.distKm <= 5)
      .sort((a, b) => a.distKm - b.distKm)
      .filter(v => { if (seen.has(v.route)) return false; seen.add(v.route); return true; })
      .slice(0, 20);
  }

  res.json({ userLat: lat, userLng: lng, nearby, nearbyRoutes,
             noBusesClose: nearby.length === 0, lastFetch, count: nearby.length });
});

app.get('/api/vehicle/:id', (req, res) => {
  const v = cachedVehicles.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(v);
});

app.get('/api/alerts', (req, res) => {
  res.json({ alerts: cachedAlerts, count: cachedAlerts.length });
});

app.get('/api/messages', (req, res) => {
  res.json({ messages: adminMessages.filter(m => m.active) });
});

// ── Admin Routes ──────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) {
    res.json({ ok: true, token: Buffer.from(ADMIN_PASS).toString('base64') });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || Buffer.from(token, 'base64').toString() !== ADMIN_PASS)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/admin/messages', adminAuth, (req, res) => {
  const { text, type, expiresIn } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const msg = {
    id: Date.now().toString(),
    text: text.trim().slice(0, 280),
    type: ['info','warning','alert'].includes(type) ? type : 'info',
    active: true,
    createdAt: new Date().toISOString(),
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 60000).toISOString() : null
  };
  adminMessages.unshift(msg);
  if (adminMessages.length > 20) adminMessages = adminMessages.slice(0, 20);
  if (expiresIn) setTimeout(() => {
    const m = adminMessages.find(x => x.id === msg.id);
    if (m) m.active = false;
  }, expiresIn * 60000);
  res.json({ ok: true, message: msg });
});

app.delete('/api/admin/messages/:id', adminAuth, (req, res) => {
  const m = adminMessages.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  m.active = false;
  res.json({ ok: true });
});

app.get('/api/admin/messages', adminAuth, (req, res) => {
  res.json({ messages: adminMessages });
});

app.post('/api/admin/refresh', adminAuth, async (req, res) => {
  await refreshData();
  res.json({ ok: true, vehicles: cachedVehicles.length });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚌 YYC Transit running on port ${PORT}`);
});
