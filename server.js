require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const protobuf = require('protobufjs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store ───────────────────────────────────────────────────────
let cachedVehicles = [];
let cachedAlerts = [];
let adminMessages = []; // admin broadcast messages
let lastFetch = 0;
const CACHE_TTL = 25000; // 25 seconds

// Admin password (set in .env as ADMIN_PASS, default for demo)
const ADMIN_PASS = process.env.ADMIN_PASS || 'yyctransit2024';

// Calgary Transit GTFS-RT URLs
const VEHICLE_URL = 'https://data.calgary.ca/api/views/am7c-qe3u/files/0d60de09-7529-4b6e-89d3-e1c770f6e18d?filename=vehiclepositions.pb';
const TRIPS_URL   = 'https://data.calgary.ca/api/views/gs4m-mdc2/files/c7a42b72-5e83-4c35-9b75-d48ced5b3cd2?filename=tripupdates.pb';
const ALERTS_URL  = 'https://data.calgary.ca/resource/jhgn-ynqj.json?$limit=30';

// Load protobuf schema
let FeedMessage = null;
protobuf.load(path.join(__dirname, 'lib', 'gtfs-realtime.proto'), (err, root) => {
  if (err) { console.error('Proto load error:', err); return; }
  FeedMessage = root.lookupType('transit_realtime.FeedMessage');
  console.log('✅ Protobuf schema loaded');
  // Fetch immediately on startup
  refreshData();
});

// ── Parse protobuf feed ───────────────────────────────────────────────────
async function parsePB(url) {
  const res = await fetch(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'YYCTransit/1.0' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buf = await res.buffer();
  const msg = FeedMessage.decode(buf);
  return FeedMessage.toObject(msg, { longs: String, enums: String, defaults: true });
}

// ── Refresh vehicle data ──────────────────────────────────────────────────
async function refreshData() {
  if (!FeedMessage) return;
  try {
    console.log('🔄 Fetching Calgary Transit data…');

    // Fetch vehicles and trip updates in parallel
    const [vFeed, tFeed] = await Promise.allSettled([
      parsePB(VEHICLE_URL),
      parsePB(TRIPS_URL)
    ]);

    // Build trip update lookup: tripId → { delay, headsign, stopTimes }
    const tripUpdates = {};
    if (tFeed.status === 'fulfilled') {
      (tFeed.value.entity || []).forEach(e => {
        if (!e.tripUpdate) return;
        const tu = e.tripUpdate;
        const tid = tu.trip?.tripId;
        if (!tid) return;
        const stops = (tu.stopTimeUpdate || []).map(s => ({
          stopId: s.stopId,
          seq: s.stopSequence,
          arrival: s.arrival?.time ? parseInt(s.arrival.time) : null,
          delay: s.arrival?.delay || s.departure?.delay || 0
        }));
        tripUpdates[tid] = {
          headsign: tu.trip?.headsign || '',
          routeId: tu.trip?.routeId || '',
          delay: stops[0]?.delay || 0,
          stops
        };
      });
    }

    // Process vehicles
    if (vFeed.status === 'fulfilled') {
      const vehicles = [];
      (vFeed.value.entity || []).forEach(e => {
        if (!e.vehicle) return;
        const v = e.vehicle;
        const pos = v.position;
        if (!pos?.latitude || !pos?.longitude) return;

        const tripId = v.trip?.tripId || '';
        const tu = tripUpdates[tripId] || {};

        vehicles.push({
          id: v.vehicle?.id || e.id,
          label: v.vehicle?.label || '',
          route: v.trip?.routeId || tu.routeId || '',
          tripId,
          headsign: v.trip?.headsign || tu.headsign || '',
          lat: parseFloat(pos.latitude),
          lng: parseFloat(pos.longitude),
          bearing: pos.bearing ? parseFloat(pos.bearing) : null,
          speed: pos.speed ? Math.round(parseFloat(pos.speed) * 3.6) : 0, // km/h
          status: v.currentStatus || 'IN_TRANSIT_TO',
          stopId: v.stopId || '',
          delay: tu.delay || 0,
          upcomingStops: tu.stops || [],
          ts: v.timestamp || Date.now() / 1000
        });
      });
      cachedVehicles = vehicles;
      console.log(`✅ ${vehicles.length} vehicles loaded`);
    }

    // Fetch alerts (JSON endpoint — no CORS issues server-side)
    try {
      const aRes = await fetch(ALERTS_URL, { timeout: 8000 });
      if (aRes.ok) {
        const aData = await aRes.json();
        cachedAlerts = (aData || []).map(a => ({
          id: a.alert_id || Math.random(),
          header: a.header_text || 'Service Alert',
          description: a.description_text || '',
          route: a.route_id || '',
          effect: a.effect || '',
          cause: a.cause || ''
        }));
        console.log(`✅ ${cachedAlerts.length} alerts loaded`);
      }
    } catch (e) {
      console.warn('Alerts fetch failed:', e.message);
    }

    lastFetch = Date.now();
  } catch (e) {
    console.error('❌ Data refresh failed:', e.message);
  }
}

// Auto-refresh every 30 seconds
setInterval(refreshData, 30000);

// ── Haversine distance (km) ───────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Estimate minutes until bus reaches a location (rough calc based on distance + speed)
function estimateArrival(vehicle, destLat, destLng) {
  const dist = haversine(vehicle.lat, vehicle.lng, destLat, destLng);
  const speedKmh = vehicle.speed > 5 ? vehicle.speed : 20; // assume 20 km/h if stopped/slow
  const minutes = Math.round((dist / speedKmh) * 60);
  return { dist: dist.toFixed(2), minutes };
}

// ── API Routes ────────────────────────────────────────────────────────────

// GET /api/status — health check
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    vehicles: cachedVehicles.length,
    alerts: cachedAlerts.length,
    messages: adminMessages.length,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
    ageSeconds: lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null
  });
});

// GET /api/vehicles — all vehicles (with optional bbox)
app.get('/api/vehicles', (req, res) => {
  let v = cachedVehicles;
  if (req.query.route) {
    v = v.filter(x => x.route === req.query.route);
  }
  res.json({ vehicles: v, lastFetch, count: v.length });
});

// GET /api/nearby?lat=XX&lng=XX&radius=XX — buses near a point
// Returns buses heading toward the user's location sorted by ETA
app.get('/api/nearby', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius) || 1.5; // km

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng required' });
  }

  // Filter vehicles within radius
  let nearby = cachedVehicles
    .map(v => {
      const { dist, minutes } = estimateArrival(v, lat, lng);
      return { ...v, distKm: parseFloat(dist), etaMin: minutes };
    })
    .filter(v => v.distKm <= radius)
    .sort((a, b) => a.etaMin - b.etaMin);

  // If nothing found nearby, return unique routes within 5km with full list
  let nearbyRoutes = [];
  if (nearby.length === 0) {
    const expanded = cachedVehicles
      .map(v => ({ ...v, distKm: parseFloat(haversine(v.lat, v.lng, lat, lng).toFixed(2)) }))
      .filter(v => v.distKm <= 5)
      .sort((a, b) => a.distKm - b.distKm);

    const seen = new Set();
    nearbyRoutes = expanded.filter(v => {
      if (seen.has(v.route)) return false;
      seen.add(v.route);
      return true;
    }).slice(0, 20);
  }

  res.json({
    userLat: lat,
    userLng: lng,
    nearby,
    nearbyRoutes,
    noBusesClose: nearby.length === 0,
    lastFetch,
    count: nearby.length
  });
});

// GET /api/vehicle/:id — single vehicle detail
app.get('/api/vehicle/:id', (req, res) => {
  const v = cachedVehicles.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(v);
});

// GET /api/alerts — service alerts
app.get('/api/alerts', (req, res) => {
  res.json({ alerts: cachedAlerts, count: cachedAlerts.length });
});

// GET /api/messages — admin broadcast messages (public read)
app.get('/api/messages', (req, res) => {
  res.json({ messages: adminMessages.filter(m => m.active) });
});

// ── Admin Routes ──────────────────────────────────────────────────────────

// POST /api/admin/login — verify password
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) {
    res.json({ ok: true, token: Buffer.from(ADMIN_PASS).toString('base64') });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Middleware to check admin token
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || Buffer.from(token, 'base64').toString() !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /api/admin/messages — post a new message
app.post('/api/admin/messages', adminAuth, (req, res) => {
  const { text, type, expiresIn } = req.body; // type: info|warning|alert
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });

  const msg = {
    id: Date.now().toString(),
    text: text.trim().slice(0, 280),
    type: ['info', 'warning', 'alert'].includes(type) ? type : 'info',
    active: true,
    createdAt: new Date().toISOString(),
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 60000).toISOString() : null
  };

  adminMessages.unshift(msg);
  if (adminMessages.length > 20) adminMessages = adminMessages.slice(0, 20);

  // Auto-expire
  if (expiresIn) {
    setTimeout(() => {
      const m = adminMessages.find(x => x.id === msg.id);
      if (m) m.active = false;
    }, expiresIn * 60000);
  }

  res.json({ ok: true, message: msg });
});

// DELETE /api/admin/messages/:id — delete a message
app.delete('/api/admin/messages/:id', adminAuth, (req, res) => {
  const m = adminMessages.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  m.active = false;
  res.json({ ok: true });
});

// GET /api/admin/messages — all messages including inactive (admin only)
app.get('/api/admin/messages', adminAuth, (req, res) => {
  res.json({ messages: adminMessages });
});

// ── Force refresh ─────────────────────────────────────────────────────────
app.post('/api/admin/refresh', adminAuth, async (req, res) => {
  await refreshData();
  res.json({ ok: true, vehicles: cachedVehicles.length });
});

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚌 YYC Transit server running on port ${PORT}`);
  console.log(`🔐 Admin password: ${ADMIN_PASS}`);
});
