/**
 * OAuth 2.1 for the MCP endpoint, so Claude (web, desktop, mobile), ChatGPT
 * and other connectors can be added with just the server URL.
 *
 * One owner, no database: every artifact (client ids from dynamic
 * registration, authorization codes, access and refresh tokens) is a signed
 * token (HMAC-SHA256 with a key derived from OSCF_TOKEN). Rotating OSCF_TOKEN
 * revokes every connection at once.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp/<vault>]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server               RFC 8414
 *   POST /oauth/register                                       RFC 7591 (dynamic client registration)
 *   GET  /oauth/authorize                                      consent page (owner enters the deploy token)
 *   POST /oauth/authorize                                      approve / deny
 *   POST /oauth/token                                          authorization_code (PKCE S256) | refresh_token
 *
 * Clients may also identify with a Client ID Metadata Document (an https URL).
 * The owner picks, per connection, the vault, read or write access and
 * optional folders; the connection name is recorded on every change it makes.
 */
import { safeEqual } from "./auth.ts";
import type { McpClient } from "./mcp.ts";

const PREFIX = "hb1";
const CODE_TTL_S = 120;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 90 * 24 * 60 * 60;

export interface Grant {
  readonly name: string;
  readonly access: "read" | "write";
  readonly folders: ReadonlyArray<string>;
  readonly vaults: ReadonlyArray<string>;
}

type Signed =
  | { typ: "client"; redirect_uris: string[]; name: string }
  | { typ: "code"; cid: string; redirect_uri: string; challenge: string; grant: Grant }
  | { typ: "access"; cid: string; grant: Grant }
  | { typ: "refresh"; cid: string; grant: Grant };

// ---------------------------------------------------------------- signing

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const utf8 = (text: string) => new TextEncoder().encode(text);

const keys = new Map<string, Promise<CryptoKey>>();
const signingKey = (secret: string) => {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const derived = new Uint8Array(await crypto.subtle.sign("HMAC", base, utf8("homebase-oauth-v1")));
      return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })();
    keys.set(secret, key);
  }
  return key;
};

const sign = async (secret: string, payload: Signed, ttlSeconds?: number) => {
  const body = b64url(utf8(JSON.stringify({ ...payload, ...(ttlSeconds ? { exp: Math.floor(Date.now() / 1000) + ttlSeconds } : {}) })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), utf8(`${PREFIX}.${body}`)));
  return `${PREFIX}.${body}.${b64url(sig)}`;
};

const verify = async <T extends Signed["typ"]>(secret: string, token: string, typ: T) => {
  const [prefix, body, sig] = token.split(".");
  if (prefix !== PREFIX || !body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await signingKey(secret), fromB64url(sig), utf8(`${PREFIX}.${body}`));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Signed & { exp?: number };
    if (payload.typ !== typ) return null;
    if (payload.exp !== undefined && payload.exp < Date.now() / 1000) return null;
    return payload as Extract<Signed, { typ: T }>;
  } catch {
    return null;
  }
};

const sha256b64url = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))));

// ---------------------------------------------------------------- helpers

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", ...extra },
  });

const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** https, or http on loopback (desktop clients such as Claude Code). */
const isAllowedRedirect = (uri: string) => {
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
};

const cleanName = (name: string) => name.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40) || "connector";
const slug = (name: string) => cleanName(name).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "connector";

interface ClientInfo {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
}

/** A client from dynamic registration (signed id) or a Client ID Metadata Document (https URL). */
const resolveClient = async (secret: string, clientId: string): Promise<ClientInfo | null> => {
  if (clientId.startsWith(`${PREFIX}.`)) {
    const client = await verify(secret, clientId, "client");
    return client ? { id: clientId, name: client.name, redirectUris: client.redirect_uris } : null;
  }
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return null;
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const doc = (await response.json()) as { client_id?: string; client_name?: string; redirect_uris?: unknown };
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
    const redirectUris = doc.redirect_uris.filter((u): u is string => typeof u === "string" && isAllowedRedirect(u));
    return { id: clientId, name: cleanName(doc.client_name ?? url.hostname), redirectUris };
  } catch {
    return null;
  }
};

const parseFolders = (text: string) =>
  text
    .split(/[\n,]/)
    .map((f) => f.trim().replace(/^\/+|\/+$/g, ""))
    .filter((f) => f !== "" && !f.split("/").some((p) => p === "" || p === "." || p === ".." || p.startsWith(".")))
    .map((f) => `${f}/`);

// ---------------------------------------------------------------- consent page

interface AuthorizeParams {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly state: string;
  readonly vault: string;
}

const page = (client: ClientInfo, params: AuthorizeParams, error = "") => {
  const host = new URL(params.redirect_uri).host;
  const hidden = (["client_id", "redirect_uri", "code_challenge", "state"] as const)
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}">`)
    .join("");
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${escapeHtml(client.name)} to Homebase</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 30rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  .muted { opacity: .7; font-size: .9rem; margin-top: 0; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  .hint { font-weight: 400; opacity: .7; font-size: .85rem; }
  input[type=text], input[type=password], textarea { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; margin-top: .25rem; }
  fieldset { border: 0; padding: 0; margin: 1rem 0 0; }
  fieldset label { display: inline; font-weight: 400; margin-right: 1rem; }
  .error { color: #c62828; font-weight: 600; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .55rem 1.1rem; border-radius: .4rem; border: 1px solid currentColor; background: none; cursor: pointer; }
  button[value=approve] { background: #4b4bd8; color: white; border-color: #4b4bd8; }
</style></head>
<body>
<h1>Connect ${escapeHtml(client.name)} to your notes</h1>
<p class="muted">It will be sent back to <strong>${escapeHtml(host)}</strong>. Every change it makes is recorded under the connection name, and can be undone from version history.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden}
<label>Vault id<input type="text" name="vault" value="${escapeHtml(params.vault)}" required pattern="[a-z0-9][a-z0-9_-]{0,62}" autocomplete="off"></label>
<fieldset><legend><strong>Access</strong></legend>
  <label><input type="radio" name="access" value="write" checked> Read and edit</label>
  <label><input type="radio" name="access" value="read"> Read only</label>
</fieldset>
<label>Folders <span class="hint">optional, one per line; empty means the whole vault</span><textarea name="folders" rows="2" placeholder="Work"></textarea></label>
<label>Connection name <span class="hint">shown in history as mcp:&lt;name&gt;</span><input type="text" name="name" value="${escapeHtml(slug(client.name))}" maxlength="40"></label>
<label>Owner token <span class="hint">the OSCF_TOKEN you deployed with</span><input type="password" name="owner_token" required autocomplete="current-password"></label>
<div class="actions"><button type="submit" name="decision" value="approve">Allow</button><button type="submit" name="decision" value="deny" formnovalidate>Deny</button></div>
</form>
</body></html>`,
    {
      status: error ? 400 : 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      },
    },
  );
};

const redirectTo = (uri: string, params: Record<string, string>) => {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== "") url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: url.href, "cache-control": "no-store" } });
};

// ---------------------------------------------------------------- endpoints

const VAULT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** `WWW-Authenticate` for a 401 on `/mcp/<vault>`: tells clients where to start OAuth. */
export const authenticateHeader = (origin: string, vault: string) =>
  `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/${vault}"`;

/** Handle an OAuth route, or return null if `pathname` isn't one. */
export const handleOAuth = async (request: Request, secret: string): Promise<Response | null> => {
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname;

  if (request.method === "OPTIONS" && (path.startsWith("/.well-known/oauth") || path.startsWith("/oauth/")))
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
      },
    });

  const resource = /^\/\.well-known\/oauth-protected-resource(\/mcp\/([^/]+))?\/?$/.exec(path);
  if (resource && request.method === "GET")
    return json({
      resource: resource[1] ? `${origin}${resource[1]}` : `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Homebase notes",
    });

  if ((path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") && request.method === "GET")
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      scopes_supported: ["notes"],
    });

  if (path === "/oauth/register" && request.method === "POST") {
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return oauthError("invalid_client_metadata", "Body must be JSON.");
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every(isAllowedRedirect))
      return oauthError("invalid_redirect_uri", "redirect_uris must be https URLs (or http on localhost).");
    const name = cleanName(typeof body.client_name === "string" ? body.client_name : new URL(uris[0]!).hostname);
    const clientId = await sign(secret, { typ: "client", redirect_uris: uris, name });
    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  if (path === "/oauth/authorize" && request.method === "GET") {
    const q = url.searchParams;
    const client = await resolveClient(secret, q.get("client_id") ?? "");
    const redirectUri = q.get("redirect_uri") ?? "";
    // Never redirect to an unverified URI: show the error here instead.
    if (!client) return new Response("Unknown client.", { status: 400 });
    if (!client.redirectUris.includes(redirectUri)) return new Response("redirect_uri is not registered for this client.", { status: 400 });
    const state = q.get("state") ?? "";
    if (q.get("response_type") !== "code") return redirectTo(redirectUri, { error: "unsupported_response_type", state });
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
      return redirectTo(redirectUri, { error: "invalid_request", error_description: "PKCE with S256 is required.", state });
    const fromResource = /\/mcp\/([^/?#]+)/.exec(q.get("resource") ?? "")?.[1] ?? "";
    return page(client, {
      client_id: client.id,
      redirect_uri: redirectUri,
      code_challenge: q.get("code_challenge")!,
      state,
      vault: VAULT_ID.test(fromResource) ? fromResource : "",
    });
  }

  if (path === "/oauth/authorize" && request.method === "POST") {
    const form = await request.formData();
    const field = (k: string) => String(form.get(k) ?? "");
    const client = await resolveClient(secret, field("client_id"));
    const redirectUri = field("redirect_uri");
    if (!client || !client.redirectUris.includes(redirectUri)) return new Response("Unknown client or redirect_uri.", { status: 400 });
    const params = { client_id: client.id, redirect_uri: redirectUri, code_challenge: field("code_challenge"), state: field("state"), vault: field("vault") };
    if (field("decision") !== "approve") return redirectTo(redirectUri, { error: "access_denied", state: params.state, iss: origin });
    if (!safeEqual(field("owner_token"), secret)) return page(client, params, "That owner token is not right.");
    if (!VAULT_ID.test(params.vault)) return page(client, params, "Enter a valid vault id (the one your devices use).");
    const grant: Grant = {
      name: slug(field("name") || client.name),
      access: field("access") === "read" ? "read" : "write",
      folders: parseFolders(field("folders")),
      vaults: [params.vault],
    };
    const code = await sign(secret, { typ: "code", cid: client.id, redirect_uri: redirectUri, challenge: params.code_challenge, grant }, CODE_TTL_S);
    return redirectTo(redirectUri, { code, state: params.state, iss: origin });
  }

  if (path === "/oauth/token" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    if (!form) return oauthError("invalid_request", "Body must be application/x-www-form-urlencoded.");
    const field = (k: string) => String(form.get(k) ?? "");
    const clientId = field("client_id");
    const issue = async (cid: string, grant: Grant) =>
      json({
        access_token: await sign(secret, { typ: "access", cid, grant }, ACCESS_TTL_S),
        token_type: "Bearer",
        expires_in: ACCESS_TTL_S,
        refresh_token: await sign(secret, { typ: "refresh", cid, grant }, REFRESH_TTL_S),
        scope: "notes",
      });

    if (field("grant_type") === "authorization_code") {
      const code = await verify(secret, field("code"), "code");
      if (!code) return oauthError("invalid_grant", "The code is invalid or expired.");
      if (code.cid !== clientId) return oauthError("invalid_grant", "The code was issued to another client.");
      if (code.redirect_uri !== field("redirect_uri")) return oauthError("invalid_grant", "redirect_uri does not match.");
      if ((await sha256b64url(field("code_verifier"))) !== code.challenge) return oauthError("invalid_grant", "PKCE verification failed.");
      return issue(code.cid, code.grant);
    }
    if (field("grant_type") === "refresh_token") {
      const refresh = await verify(secret, field("refresh_token"), "refresh");
      if (!refresh) return oauthError("invalid_grant", "The refresh token is invalid or expired.");
      if (clientId !== "" && refresh.cid !== clientId) return oauthError("invalid_grant", "The token was issued to another client.");
      return issue(refresh.cid, refresh.grant);
    }
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  return null;
};

/** The MCP client an OAuth access token stands for, if it is valid for `vault`. */
export const verifyAccessToken = async (secret: string, token: string, vault: string): Promise<McpClient | null> => {
  const access = await verify(secret, token, "access");
  if (!access || !access.grant.vaults.includes(vault)) return null;
  return { name: access.grant.name, access: access.grant.access, folders: access.grant.folders };
};
