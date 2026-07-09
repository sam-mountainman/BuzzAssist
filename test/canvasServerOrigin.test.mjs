import test from "node:test";
import assert from "node:assert/strict";
import {
  handleTunnelAccess,
  isAllowedOrigin,
  isLocalHostHeader,
  isLocalOperatorRequest,
} from "../lib/canvasServerRuntime.mjs";

const ENV_KEYS = ["EXCALIDRAW_ALLOW_TUNNEL_ORIGINS", "EXCALIDRAW_ALLOWED_ORIGINS", "EXCALIDRAW_TUNNEL_ACCESS_TOKEN"];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, vars);
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("local origins are always allowed; foreign origins are rejected by default", () => {
  withEnv({}, () => {
    assert.equal(isAllowedOrigin("http://localhost:43219"), true);
    assert.equal(isAllowedOrigin("http://127.0.0.1:43219"), true);
    assert.equal(isAllowedOrigin("http://127.0.0.1:51235", { port: 43219 }), true, "local preview/widget ports are allowed");
    assert.equal(isAllowedOrigin("https://evil.example.com"), false);
    assert.equal(isAllowedOrigin("https://random.ngrok-free.dev"), false, "wildcard tunnel origins are NOT allowed unless opted in");
  });
});

test("an exact pinned origin is allowed while other tunnel hosts stay rejected", () => {
  withEnv({ EXCALIDRAW_ALLOWED_ORIGINS: "https://mine.ngrok-free.dev" }, () => {
    assert.equal(isAllowedOrigin("https://mine.ngrok-free.dev"), true);
    assert.equal(isAllowedOrigin("https://other.ngrok-free.dev"), false, "a different tunnel host must not ride the pinned allowance");
    assert.equal(isAllowedOrigin("https://evil.example.com"), false);
  });
});

test("the wildcard tunnel flag is strictly opt-in", () => {
  withEnv({ EXCALIDRAW_ALLOW_TUNNEL_ORIGINS: "1" }, () => {
    assert.equal(isAllowedOrigin("https://anything.ngrok-free.dev"), true);
    assert.equal(isAllowedOrigin("http://anything.ngrok-free.dev"), false, "wildcard tunnel allowance requires https");
    assert.equal(isAllowedOrigin("https://anything.example.com"), false, "only ngrok hosts match the wildcard");
  });
});

test("local-operator guard: only local (or origin-less) requests count as the operator", () => {
  assert.equal(isLocalOperatorRequest({ headers: {} }), true, "no Origin = local CLI / same-origin nav");
  assert.equal(isLocalOperatorRequest({ headers: { origin: "http://localhost:43219" } }), true);
  assert.equal(isLocalOperatorRequest({ headers: { origin: "http://127.0.0.1:51000" } }), true);
  assert.equal(isLocalOperatorRequest({ headers: { origin: "https://mine.ngrok-free.dev" } }), false, "a tunnel browser is never the local operator");
  assert.equal(isLocalOperatorRequest({ headers: { origin: "https://evil.example.com" } }), false);
});

test("tunnel access token only gates non-local host requests", () => {
  withEnv({ EXCALIDRAW_TUNNEL_ACCESS_TOKEN: "secret-token" }, () => {
    assert.equal(isLocalHostHeader("127.0.0.1:43219"), true);
    assert.equal(isLocalHostHeader("mine.ngrok-free.dev"), false);

    const localReq = { url: "/", headers: { host: "127.0.0.1:43219" } };
    const localRes = fakeResponse();
    assert.equal(handleTunnelAccess(localReq, localRes), false, "local canvas remains usable without tunnel token");

    const deniedReq = { url: "/", headers: { host: "mine.ngrok-free.dev" } };
    const deniedRes = fakeResponse();
    assert.equal(handleTunnelAccess(deniedReq, deniedRes), true);
    assert.equal(deniedRes.statusCode, 401);

    const queryReq = { url: "/?t=secret-token&x=1", headers: { host: "mine.ngrok-free.dev" } };
    const queryRes = fakeResponse();
    assert.equal(handleTunnelAccess(queryReq, queryRes), false);
    assert.equal(queryReq.url, "/?x=1");
    assert.match(queryRes.headers["set-cookie"], /buzzassist_tunnel_token=secret-token/);

    const cookieReq = { url: "/", headers: { host: "mine.ngrok-free.dev", cookie: "buzzassist_tunnel_token=secret-token" } };
    const cookieRes = fakeResponse();
    assert.equal(handleTunnelAccess(cookieReq, cookieRes), false);
  });
});

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(value = "") {
      this.body += String(value);
    },
  };
}
