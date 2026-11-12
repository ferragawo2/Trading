import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const CLIENT_ID = process.env.DERIV_CLIENT_ID;
const REDIRECT_URI = process.env.DERIV_REDIRECT_URI;
const APP_ORIGIN = process.env.APP_ORIGIN;
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const API_BASE = "https://api.derivws.com";
const transactions = new Map();
const sessions = new Map();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf("="); return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
  }));
}
function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function clearCookie(name) {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
async function bodyJson(req) {
  let raw = ""; for await (const chunk of req) raw += chunk;
  if (raw.length > 20000) throw new Error("Request too large");
  return raw ? JSON.parse(raw) : {};
}
function cleanAccount(a) {
  return {
    account_type: a.account_type || a.account_type_name || "Deriv account",
    currency: a.currency || "",
    is_virtual: Boolean(a.is_virtual ?? a.account_type === "demo"),
    account_id: typeof a.account_id === "string" ? a.account_id : ""
  };
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && origin !== APP_ORIGIN) return send(res, 403, { error: "Origin not allowed" });
  if (origin === APP_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true, service: "accumulator-oauth-api" });
    if (!CLIENT_ID || !REDIRECT_URI || !APP_ORIGIN) return send(res, 503, { stage: "configuration", code: "OAUTH_CONFIG_MISSING", error: "OAuth service is not configured. Check OAuth environment variables on Render." });

    if (req.method === "POST" && url.pathname === "/oauth/start") {
      const verifier = crypto.randomBytes(48).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const state = crypto.randomBytes(24).toString("hex");
      // Use the high-entropy state as the transaction key; no redirect cookie required.
      transactions.set(state, { verifier, expires: Date.now() + 10 * 60 * 1000 });
      const params = new URLSearchParams({
        response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
        scope: "trade", state, code_challenge: challenge, code_challenge_method: "S256"
      });
      return send(res, 200, { authorization_url: `${AUTH_URL}?${params}` });
    }

    if (req.method === "POST" && url.pathname === "/oauth/exchange") {
      const input = await bodyJson(req);
      const state = typeof input.state === "string" ? input.state : "";
      const tx = state && transactions.get(state);
      if (!tx || tx.expires < Date.now() || typeof input.code !== "string") {
        if (state) transactions.delete(state);
        return send(res, 400, { stage: "state_validation", code: "OAUTH_STATE_INVALID_OR_EXPIRED", error: "OAuth state was not found or expired. The backend may have restarted during login. Start a fresh connection." });
      }
      transactions.delete(state);
      const form = new URLSearchParams({
        grant_type: "authorization_code", client_id: CLIENT_ID, code: input.code,
        code_verifier: tx.verifier, redirect_uri: REDIRECT_URI
      });
      const tokenResponse = await fetch(TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form
      });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenData.access_token) {
        const providerMessage = String(tokenData.error_description || tokenData.message || tokenData.error || "Deriv did not return an access token").slice(0, 500);
        console.error("OAuth stage=token_exchange status=" + tokenResponse.status);
        return send(res, 502, { stage: "token_exchange", code: "DERIV_TOKEN_EXCHANGE_REJECTED", http_status: tokenResponse.status, error: providerMessage });
      }
      const sid = crypto.randomBytes(32).toString("base64url");
      const expiresIn = Math.max(60, Number(tokenData.expires_in) || 3600);
      sessions.set(sid, { accessToken: tokenData.access_token, expires: Date.now() + expiresIn * 1000 });
      // Return only an opaque, random app-session handle. The Deriv access token
      // remains server-side; the browser stores this handle in same-origin sessionStorage.
      console.info("OAuth stage=session_created");
      return send(res, 200, { connected: true, stage: "session_created", expires_in: expiresIn, session_id: sid }, {
        "Set-Cookie": cookie("deriv_session", sid, expiresIn)
      });
    }

    const bearer = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    const sid = bearer ? bearer[1] : cookies(req).deriv_session;
    const session = sid && sessions.get(sid);
    if (session && session.expires <= Date.now()) sessions.delete(sid);

    if (req.method === "GET" && url.pathname === "/api/me") {
      const active = sid && sessions.get(sid);
      if (!active || active.expires <= Date.now()) return send(res, 401, { connected: false, stage: "session_lookup", code: "APP_SESSION_NOT_FOUND", error: "The app session is missing or expired on the backend. Reconnect to create a fresh session." });
      const response = await fetch(`${API_BASE}/trading/v1/options/accounts`, {
        headers: { Authorization: `Bearer ${active.accessToken}` }
      });
      const data = await response.json();
      if (!response.ok) return send(res, response.status, { error: "Could not read Deriv account details. Reconnect and check the app's granted permissions." });
      const accounts = Array.isArray(data.accounts) ? data.accounts.map(cleanAccount) : [];
      return send(res, 200, { connected: true, accounts });
    }

    if (req.method === "POST" && url.pathname === "/api/disconnect") {
      if (sid) sessions.delete(sid);
      return send(res, 200, { connected: false }, { "Set-Cookie": clearCookie("deriv_session") });
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("OAuth stage=server_exception", error?.name || "Error", String(error?.message || error).slice(0, 300));
    return send(res, 500, { stage: "server", code: "OAUTH_BACKEND_EXCEPTION", error: String(error?.message || "Unexpected backend error").slice(0, 300) });
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(`Accumulator OAuth API listening on ${PORT}`));
