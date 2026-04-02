/**
 * IRON FIST — Punch Mitt Training Platform
 * Deno Backend (server.ts)
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-write --unstable-kv --import-map=import_map.json server.ts
 *
 * Data is stored in Deno KV so the app can deploy to Deno Deploy.
 * Endpoints:
 *   POST /api/auth/signup
 *   POST /api/auth/login
 *   POST /api/auth/reset-request
 *   POST /api/auth/reset-confirm
 *   GET  /api/me                    (auth required)
 *   GET  /api/sessions              (auth required)
 *   GET  /api/sessions/:id          (auth required)
 *   POST /api/sessions/start        (auth required)
 *   POST /api/sessions/end          (auth required)
 *   GET  /api/progress              (auth required)
 *   POST /hit                       (ESP32 — uses device token)
 *   POST /api/device/token          (auth required — generate device token)
 *   GET  /api/state                 (ESP32 polling — uses device token)
 *   POST /reset                     (device token)
 *   POST /target                    (device token)
 *   GET  /*                         static files from ./public/
 */

import { crypto } from "std/crypto/mod.ts";
import { encodeHex } from "std/encoding/hex.ts";

const kv = await Deno.openKv();

// ── Types ──────────────────────────────────────────────────────────
interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  passwordHash: string;
  createdAt: number;
  deviceToken: string | null;
  resetToken: string | null;
  resetExpiry: number | null;
  activeSessionId: string | null;
}

interface Session {
  id: string;
  userId: string;
  startTime: number;
  endTime: number | null;
  durationSeconds: number | null;
  targetZone: string | null;
  hitCount: number;
  avgForce: number;
  avgPrecision: number;
  peakForce: number;
  zoneBreakdown: Record<string, number>;
  notes: string;
}

interface Hit {
  id: string;
  sessionId: string;
  userId: string;
  direction: string;
  rawForce: number;
  normForce: number;
  precisionScore: number;
  timestamp: number;
  serverTime: number;
  sensors: { up: number; down: number; left: number; right: number };
}

// ── Data helpers ───────────────────────────────────────────────────
async function getUsers(): Promise<User[]> {
  const res = await kv.get<User[]>(["store", "users"]);
  return res.value ?? [];
}

async function saveUsers(users: User[]) {
  await kv.set(["store", "users"], users);
}

async function getSessions(): Promise<Session[]> {
  const res = await kv.get<Session[]>(["store", "sessions"]);
  return res.value ?? [];
}

async function saveSessions(sessions: Session[]) {
  await kv.set(["store", "sessions"], sessions);
}

async function getHits(): Promise<Hit[]> {
  const res = await kv.get<Hit[]>(["store", "hits"]);
  return res.value ?? [];
}

async function saveHits(hits: Hit[]) {
  await kv.set(["store", "hits"], hits);
}

// ── Hash helpers ───────────────────────────────────────────────────
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "ironfist_salt_2024");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hashBuffer));
}

function generateId(): string {
  return crypto.randomUUID();
}

function generateToken(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return encodeHex(arr);
}

// ── Auth token store ───────────────────────────────────────────────
// Auth tokens (web session tokens) are persisted in KV so they survive
// server restarts and page refreshes.
// Key: ["authTokens", token] → userId string

async function createAuthToken(userId: string): Promise<string> {
  const token = generateToken();
  // Store with a 7-day TTL (milliseconds)
  await kv.set(["authTokens", token], userId, { expireIn: 7 * 24 * 60 * 60 * 1000 });
  return token;
}

async function getUserIdFromToken(token: string | null): Promise<string | null> {
  if (!token) return null;
  const res = await kv.get<string>(["authTokens", token]);
  return res.value ?? null;
}

async function getUserById(id: string): Promise<User | null> {
  const users = await getUsers();
  return users.find(u => u.id === id) ?? null;
}

async function getUserByEmail(email: string): Promise<User | null> {
  const users = await getUsers();
  return users.find(u => u.email.toLowerCase() === email.toLowerCase()) ?? null;
}

async function getUserByDeviceToken(token: string): Promise<User | null> {
  const users = await getUsers();
  return users.find(u => u.deviceToken === token) ?? null;
}

async function updateUser(updated: User) {
  const users = await getUsers();
  const idx = users.findIndex(u => u.id === updated.id);
  if (idx >= 0) users[idx] = updated;
  await saveUsers(users);
}

// ── Session helpers ────────────────────────────────────────────────
function calcPrecision(sensors: { up: number; down: number; left: number; right: number }, direction: string): number {
  const vals = [sensors.up, sensors.down, sensors.left, sensors.right];
  const max = Math.max(...vals);
  if (max === 0) return 0;

  if (direction === "center") {
    const avg = vals.reduce((a, b) => a + b, 0) / 4;
    const variance = vals.reduce((s, v) => s + Math.abs(v - avg), 0) / 4;
    return Math.max(0, Math.round(100 - (variance / avg) * 100));
  }

  const dominant = sensors[direction as keyof typeof sensors] || 0;
  const others = vals.filter(v => v !== dominant);
  const othersAvg = others.reduce((a, b) => a + b, 0) / others.length;
  const dominance = (dominant - othersAvg) / max;
  return Math.min(100, Math.max(0, Math.round(dominance * 100)));
}

function detectDirection(sensors: { up: number; down: number; left: number; right: number }, threshold: number): string {
  const vals = [sensors.up, sensors.down, sensors.left, sensors.right];
  const max = Math.max(...vals);

  const spread = Math.max(...vals) - Math.min(...vals);
  if (spread < max * 0.3 && max >= threshold) return "center";

  if (max === sensors.up)   return "up";
  if (max === sensors.down) return "down";
  if (max === sensors.left) return "left";
  return "right";
}

async function recomputeSessionStats(sessionId: string) {
  const hits = await getHits();
  const sessionHits = hits.filter(h => h.sessionId === sessionId);
  if (sessionHits.length === 0) return;

  const forces = sessionHits.map(h => h.normForce);
  const precisions = sessionHits.map(h => h.precisionScore);
  const avgForce = Math.round(forces.reduce((a, b) => a + b, 0) / forces.length);
  const avgPrecision = Math.round(precisions.reduce((a, b) => a + b, 0) / precisions.length);
  const peakForce = Math.max(...forces);

  const zoneBreakdown: Record<string, number> = { up: 0, down: 0, left: 0, right: 0, center: 0 };
  for (const h of sessionHits) zoneBreakdown[h.direction] = (zoneBreakdown[h.direction] || 0) + 1;

  const sessions = await getSessions();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx >= 0) {
    sessions[idx].hitCount      = sessionHits.length;
    sessions[idx].avgForce      = avgForce;
    sessions[idx].avgPrecision  = avgPrecision;
    sessions[idx].peakForce     = peakForce;
    sessions[idx].zoneBreakdown = zoneBreakdown;
    await saveSessions(sessions);
  }
}

// ── CORS headers ───────────────────────────────────────────────────
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function authError(): Response {
  return json({ error: "Unauthorized" }, 401);
}

function getAuthToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header) return null;
  return header.replace("Bearer ", "").trim();
}

// ── Static file serving ────────────────────────────────────────────
async function serveFile(path: string): Promise<Response> {
  try {
    const content = await Deno.readFile(path);
    const ext = path.split(".").pop() ?? "";
    const mime: Record<string, string> = {
      html: "text/html", css: "text/css", js: "application/javascript",
      json: "application/json", png: "image/png", svg: "image/svg+xml",
      ico: "image/x-icon", woff2: "font/woff2",
    };
    return new Response(content, {
      headers: { "Content-Type": mime[ext] ?? "application/octet-stream" },
    });
  } catch {
    const index = await Deno.readFile("./index.html");
    return new Response(index, { headers: { "Content-Type": "text/html" } });
  }
}

// ── Router ─────────────────────────────────────────────────────────
async function handler(req: Request): Promise<Response> {
  const url    = new URL(req.url);
  const path   = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // ── POST /api/auth/signup ────────────────────────────────────────
  if (method === "POST" && path === "/api/auth/signup") {
    const { email, password, firstName, lastName } = await req.json();
    if (!email || !password || !firstName || !lastName)
      return json({ error: "All fields required" }, 400);
    if (password.length < 6)
      return json({ error: "Password must be at least 6 characters" }, 400);
    const existing = await getUserByEmail(email);
    if (existing) return json({ error: "Email already registered" }, 400);

    const user: User = {
      id: generateId(), email, firstName, lastName,
      passwordHash: await hashPassword(password),
      createdAt: Date.now(),
      deviceToken: null, resetToken: null, resetExpiry: null,
      activeSessionId: null,
    };
    const users = await getUsers();
    users.push(user);
    await saveUsers(users);

    const token = await createAuthToken(user.id);
    return json({ token, user: { id: user.id, email, firstName, lastName } });
  }

  // ── POST /api/auth/login ─────────────────────────────────────────
  if (method === "POST" && path === "/api/auth/login") {
    const { email, password } = await req.json();
    const user = await getUserByEmail(email);
    if (!user) return json({ error: "Invalid email or password" }, 401);
    const hash = await hashPassword(password);
    if (hash !== user.passwordHash) return json({ error: "Invalid email or password" }, 401);

    const token = await createAuthToken(user.id);
    return json({ token, user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName } });
  }

  // ── POST /api/auth/reset-request ────────────────────────────────
  if (method === "POST" && path === "/api/auth/reset-request") {
    const { email } = await req.json();
    const user = await getUserByEmail(email);
    if (!user) return json({ ok: true }); // don't reveal
    user.resetToken  = generateToken();
    user.resetExpiry = Date.now() + 3600000; // 1 hour
    await updateUser(user);
    console.log(`Reset token for ${email}: ${user.resetToken}`);
    return json({ ok: true, devToken: user.resetToken });
  }

  // ── POST /api/auth/reset-confirm ─────────────────────────────────
  if (method === "POST" && path === "/api/auth/reset-confirm") {
    const { token, newPassword } = await req.json();
    const users = await getUsers();
    const user = users.find(u => u.resetToken === token && u.resetExpiry && u.resetExpiry > Date.now());
    if (!user) return json({ error: "Invalid or expired token" }, 400);
    user.passwordHash = await hashPassword(newPassword);
    user.resetToken   = null;
    user.resetExpiry  = null;
    await updateUser(user);
    return json({ ok: true });
  }

  // ── GET /api/me ──────────────────────────────────────────────────
  if (method === "GET" && path === "/api/me") {
    const userId = await getUserIdFromToken(getAuthToken(req));
    if (!userId) return authError();
    const user = await getUserById(userId);
    if (!user) return authError();
    // Returns deviceToken so the frontend can display it without
    // calling /api/device/token (which would regenerate it).
    return json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      activeSessionId: user.activeSessionId,
      deviceToken: user.deviceToken,   // ← already-saved token, never rotated here
    });
  }

  // ── POST /api/device/token ───────────────────────────────────────
  // Only generates a NEW token when the user has none yet, or when
  // { "forceNew": true } is sent (e.g. from a "Regenerate" button).
  // Visiting the Settings page must NOT call this endpoint on load —
  // read deviceToken from GET /api/me instead.
  if (method === "POST" && path === "/api/device/token") {
    const userId = await getUserIdFromToken(getAuthToken(req));
    if (!userId) return authError();
    const user = await getUserById(userId);
    if (!user) return authError();

    const body = await req.json().catch(() => ({}));
    if (!user.deviceToken || body.forceNew) {
      user.deviceToken = generateToken();
      await updateUser(user);
    }
    return json({ deviceToken: user.deviceToken });
  }

  // ── POST /api/sessions/start ─────────────────────────────────────
  if (method === "POST" && path === "/api/sessions/start") {
    const userId = await getUserIdFromToken(getAuthToken(req));
    if (!userId) return authError();
    const user = await getUserById(userId);
    if (!user) return authError();

    const session: Session = {
      id: generateId(), userId,
      startTime: Date.now(), endTime: null, durationSeconds: null,
      targetZone: null, hitCount: 0, avgForce: 0, avgPrecision: 0,
      peakForce: 0, zoneBreakdown: { up: 0, down: 0, left: 0, right: 0, center: 0 },
      notes: "",
    };
    const sessions = await getSessions();
    sessions.push(session);
    await saveSessions(sessions);

    user.activeSessionId = session.id;
    await updateUser(user);
    return json({ sessionId: session.id });
  }

  // ── POST /api/sessions/end ───────────────────────────────────────
  if (method === "POST" && path === "/api/sessions/end") {
    const userId = await getUserIdFromToken(getAuthToken(req));
    if (!userId) return authError();
    const user = await getUserById(userId);
    if (!user || !user.activeSessionId) return json({ error: "No active session" }, 400);

    const sessions = await getSessions();
    const idx = sessions.findIndex(s => s.id === user.activeSessionId);
    if (idx >= 0) {
      sessions[idx].endTime = Date.now();
      sessions[idx].durationSeconds = Math.round((sessions[idx].endTime! - sessions[idx].startTime) / 1000);
      await saveSessions(sessions);
    }
    await recomputeSessionStats(user.activeSessionId);

    user.activeSessionId = null;
    await updateUser(user);
    return json({ ok: true });
  }

  // ── GET /api/sessions ────────────────────────────────────────────
  if (method === "GET" && path === "/api/sessions") {
    const userId = await getUserIdFromToken(getAuthToken(req));
    if (!userId) return authError();
    const sessions = await getSessions();
    const mine = sessions.filter(s => s.userId === userId)
      .sort((a, b) => b.startTime - a.startTime);
    return json(mine);
  }

  // ── GET /api/sessions/:id ────────────────────────────────────────
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === "GET" && sessionMatch) {
    const userId = await getUserIdFromToken(getAuthToken(req));
    if (!userId) return authError();
    const sessionId = sessionMatch[1];
    const sessions = await getSessions();
    const session = sessions.find(s => s.id === sessionId && s.userId === userId);
    if (!session) return json({ error: "Not found" }, 404);

    const allHits = await getHits();
    const hits = allHits.filter(h => h.sessionId === sessionId)
      .sort((a, b) => a.serverTime - b.serverTime);

    return json({ session, hits });
  }

  // ── GET /api/progress ────────────────────────────────────────────
  if (method === "GET" && path === "/api/progress") {
    const userId = await getUserIdFromToken(getAuthToken(req));
    if (!userId) return authError();
    const sessions = await getSessions();
    const mine = sessions.filter(s => s.userId === userId && s.endTime !== null)
      .sort((a, b) => a.startTime - b.startTime)
      .slice(-20);
    return json(mine);
  }

  // ── GET /api/state (ESP32 polling) ──────────────────────────────
  if (method === "GET" && path === "/api/state") {
    const deviceToken = url.searchParams.get("token");
    const user = deviceToken ? await getUserByDeviceToken(deviceToken) : null;
    if (!user) return json({ error: "Invalid device token" }, 401);

    const allHits = await getHits();
    const sessionId = user.activeSessionId;
    const sessionHits = sessionId ? allHits.filter(h => h.sessionId === sessionId) : [];
    const latest = sessionHits.length > 0 ? sessionHits[sessionHits.length - 1] : null;

    const sessions = await getSessions();
    const session = sessionId ? sessions.find(s => s.id === sessionId) : null;

    return json({
      activeSession: !!sessionId,
      sessionId,
      latestHit: latest,
      totalHits: sessionHits.length,
      hitHistory: sessionHits.slice(-50),
      session,
      targetZone: session?.targetZone ?? null,
    });
  }

  // ── POST /hit (ESP32 sends hits) ─────────────────────────────────
  if (method === "POST" && path === "/hit") {
    const body = await req.json();
    const deviceToken = body.deviceToken || url.searchParams.get("token");
    const user = deviceToken ? await getUserByDeviceToken(deviceToken) : null;
    if (!user) return json({ error: "Invalid device token" }, 401);
    if (!user.activeSessionId) return json({ error: "No active session" }, 400);

    const rawSensors = body.sensors || { up: 0, down: 0, left: 0, right: 0 };
    const HIT_THRESHOLD = body.threshold || 500;
    const direction = detectDirection(rawSensors, HIT_THRESHOLD);
    const maxVal = Math.max(rawSensors.up, rawSensors.down, rawSensors.left, rawSensors.right);
    const normForce = Math.min(100, Math.max(0, Math.round(((maxVal - 150) / (4095 - 150)) * 100)));
    const precisionScore = calcPrecision(rawSensors, direction);

    const hit: Hit = {
      id: generateId(),
      sessionId: user.activeSessionId,
      userId: user.id,
      direction,
      rawForce: maxVal,
      normForce,
      precisionScore,
      timestamp: Number(body.timestamp) || Date.now(),
      serverTime: Date.now(),
      sensors: rawSensors,
    };

    const hits = await getHits();
    hits.push(hit);
    await saveHits(hits);
    await recomputeSessionStats(user.activeSessionId);

    console.log(`HIT [${user.firstName}] zone:${direction} force:${normForce} precision:${precisionScore}`);
    return json({ ok: true, id: hit.id, direction, normForce, precisionScore });
  }

  // ── POST /reset ──────────────────────────────────────────────────
  if (method === "POST" && path === "/reset") {
    const body = await req.json();
    const user = await getUserByDeviceToken(body.deviceToken);
    if (!user || !user.activeSessionId) return json({ error: "Not found" }, 400);

    const hits = await getHits();
    const filtered = hits.filter(h => h.sessionId !== user.activeSessionId);
    await saveHits(filtered);
    await recomputeSessionStats(user.activeSessionId);
    return json({ ok: true });
  }

  // ── POST /target ─────────────────────────────────────────────────
  if (method === "POST" && path === "/target") {
    const body = await req.json();
    const user = await getUserByDeviceToken(body.deviceToken);
    if (!user || !user.activeSessionId) return json({ error: "Not found" }, 400);

    const sessions = await getSessions();
    const idx = sessions.findIndex(s => s.id === user.activeSessionId);
    if (idx >= 0) {
      sessions[idx].targetZone = body.zone || null;
      await saveSessions(sessions);
    }
    return json({ ok: true });
  }

  // ── Static files ─────────────────────────────────────────────────
  if (method === "GET") {
    const filePath = path === "/" ? "./index.html" : `.${path}`;
    return await serveFile(filePath);
  }

  return new Response("Not Found", { status: 404 });
}

// ── Boot ───────────────────────────────────────────────────────────
const PORT = 8080;
console.log(`\n🥊 Iron Fist server → http://localhost:${PORT}\n`);
Deno.serve({ port: PORT, hostname: "0.0.0.0" }, handler);
