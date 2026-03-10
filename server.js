import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ─── Configuration ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.BOUNCIE_WEBHOOK_SECRET || "";

// ─── In-memory bus state ────────────────────────────────────────────────────
let busState = {
  lat: null,
  lng: null,
  speed: null,        // mph
  heading: null,      // degrees
  timestamp: null,    // ISO string
  tripActive: false,
  lastUpdated: null,
  trail: [],          // last N GPS points for drawing the route trail
};

const MAX_TRAIL_POINTS = 200;

// ─── SSE (Server-Sent Events) for real-time push to browsers ────────────────
const clients = new Set();

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send current state immediately on connect
  res.write(`data: ${JSON.stringify(busState)}\n\n`);
  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
});

// ─── REST endpoint for current state (fallback / polling) ───────────────────
app.get("/api/status", (req, res) => {
  res.json(busState);
});

// ─── Bouncie Webhook Receiver ───────────────────────────────────────────────
// Bouncie sends POST requests with event types:
//   - tripData  (GPS coordinates during a trip)
//   - tripStart (trip begins)
//   - tripEnd   (trip ends / vehicle parked)
//   - tripMetrics, chargingStatus, etc.

app.post("/api/webhook", (req, res) => {
  // Optional: validate webhook secret
  if (WEBHOOK_SECRET && req.headers["authorization"] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const event = req.body;

  try {
    handleBouncieEvent(event);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(200).json({ ok: true }); // still 200 so Bouncie doesn't disable the hook
  }
});

function handleBouncieEvent(event) {
  const eventType = event.eventType || event.type;
  const now = new Date().toISOString();

  switch (eventType) {
    case "tripData": {
      // tripData contains GPS breadcrumbs during an active trip
      const data = event.data || event;
      const lat = data.latitude || data.lat;
      const lng = data.longitude || data.lon || data.lng;
      const speed = data.speed ?? null;        // mph from Bouncie
      const heading = data.heading ?? null;

      if (lat && lng) {
        busState.lat = lat;
        busState.lng = lng;
        busState.speed = speed;
        busState.heading = heading;
        busState.timestamp = data.timestamp || now;
        busState.tripActive = true;
        busState.lastUpdated = now;

        // Append to trail
        busState.trail.push({ lat, lng, t: busState.timestamp });
        if (busState.trail.length > MAX_TRAIL_POINTS) {
          busState.trail = busState.trail.slice(-MAX_TRAIL_POINTS);
        }

        broadcast(busState);
      }
      break;
    }

    case "tripStart": {
      busState.tripActive = true;
      busState.trail = []; // reset trail for new trip
      busState.lastUpdated = now;
      broadcast(busState);
      console.log(`[${now}] Trip started`);
      break;
    }

    case "tripEnd": {
      const data = event.data || event;
      // Capture final position if provided
      const lat = data.latitude || data.lat || busState.lat;
      const lng = data.longitude || data.lon || data.lng || busState.lng;
      busState.lat = lat;
      busState.lng = lng;
      busState.speed = 0;
      busState.tripActive = false;
      busState.lastUpdated = now;
      broadcast(busState);
      console.log(`[${now}] Trip ended`);
      break;
    }

    default: {
      // Other events (diagnostics, charging, etc.) — log and ignore
      console.log(`[${now}] Unhandled event: ${eventType}`);
      break;
    }
  }
}

// ─── Manual location update endpoint (for testing / fallback) ───────────────
app.post("/api/update", (req, res) => {
  const { lat, lng, speed, heading, tripActive } = req.body;
  if (lat && lng) {
    const now = new Date().toISOString();
    busState.lat = lat;
    busState.lng = lng;
    busState.speed = speed ?? busState.speed;
    busState.heading = heading ?? busState.heading;
    busState.tripActive = tripActive ?? busState.tripActive;
    busState.lastUpdated = now;
    busState.timestamp = now;
    busState.trail.push({ lat, lng, t: now });
    if (busState.trail.length > MAX_TRAIL_POINTS) {
      busState.trail = busState.trail.slice(-MAX_TRAIL_POINTS);
    }
    broadcast(busState);
    return res.json({ ok: true });
  }
  res.status(400).json({ error: "lat and lng required" });
});

// ─── Serve static frontend ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚌 Meadowbrook Shuttle Tracker running on port ${PORT}`);
  console.log(`   Webhook endpoint: POST /api/webhook`);
  console.log(`   Live tracker:     http://localhost:${PORT}`);
});
