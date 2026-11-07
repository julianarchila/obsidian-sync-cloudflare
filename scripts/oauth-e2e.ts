/**
 * OAuth for the MCP endpoint against a running server (`bun run dev`): what a
 * connector such as Claude or ChatGPT does, from discovery to MCP calls, plus
 * the ways it must fail. Uses a fresh `e2e-oauth-*` vault and OSCF_TOKEN.
 */
import * as Effect from "effect/Effect";

import { fetchHttp, makeHttpRemote } from "../packages/plugin/src/core/http-remote.ts";
import { openPlainVault } from "../packages/plugin/src/core/plain-vault.ts";

const serverUrl = process.env.OSCF_URL ?? "http://localhost:1337";
const token = process.env.OSCF_TOKEN ?? "";
const vaultId = `e2e-oauth-${Date.now()}`;
const mcpUrl = `${serverUrl}/mcp/${vaultId}`;
const redirectUri = "http://localhost:53682/callback";

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail && !ok ? `\n    ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const challengeOf = async (verifier: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

const mcp = async (bearer: string, method: string, params: Record<string, unknown> = {}) => {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(params.name ? { "mcp-name": String(params.name) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "oauth-e2e", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return { status: response.status, body: response.status === 200 ? ((await response.json()) as any) : await response.text() };
};

await Effect.runPromise(openPlainVault(makeHttpRemote({ serverUrl, vaultId, token, http: fetchHttp() })));

// ---- discovery, the way connectors start
const unauth = await fetch(mcpUrl, { method: "POST" });
const www = unauth.headers.get("www-authenticate") ?? "";
const metadataUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1] ?? "";
check("401 points to the protected resource metadata", unauth.status === 401 && metadataUrl.endsWith(`/mcp/${vaultId}`), www);
const resource = (await (await fetch(metadataUrl)).json()) as { resource: string; authorization_servers: string[] };
check("resource metadata names this exact MCP URL", resource.resource === mcpUrl, JSON.stringify(resource));
const as = (await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
check(
  "authorization server metadata: PKCE S256, public clients, DCR and CIMD",
  as.code_challenge_methods_supported?.includes("S256") &&
    as.token_endpoint_auth_methods_supported?.includes("none") &&
    typeof as.registration_endpoint === "string" &&
    as.client_id_metadata_document_supported === true,
  JSON.stringify(as),
);

// ---- dynamic client registration
const badReg = await fetch(as.registration_endpoint, { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
check("registration refuses non-https redirect URIs", badReg.status === 400);
const reg = (await (
  await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Claude" }),
  })
).json()) as { client_id: string };
check("registration returns a client id", typeof reg.client_id === "string" && reg.client_id.startsWith("hb1."));

// ---- authorization: consent page, then approval with the owner token
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const authorizeUrl = new URL(as.authorization_endpoint);
for (const [k, v] of Object.entries({
  response_type: "code",
  client_id: reg.client_id,
  redirect_uri: redirectUri,
  code_challenge: await challengeOf(verifier),
  code_challenge_method: "S256",
  state: "xyz",
  resource: mcpUrl,
}))
  authorizeUrl.searchParams.set(k, v);
const consent = await fetch(authorizeUrl);
const html = await consent.text();
check(
  "consent page shows the client and pre-fills the vault",
  consent.status === 200 && html.includes("Connect Claude") && html.includes(`value="${vaultId}"`) && consent.headers.get("x-frame-options") === "DENY",
);
const wrongRedirect = new URL(authorizeUrl);
wrongRedirect.searchParams.set("redirect_uri", "https://evil.example/cb");
check("an unregistered redirect_uri is refused without redirecting", (await fetch(wrongRedirect, { redirect: "manual" })).status === 400);
const noPkce = new URL(authorizeUrl);
noPkce.searchParams.delete("code_challenge");
const noPkceRes = await fetch(noPkce, { redirect: "manual" });
check("PKCE is required", noPkceRes.status === 302 && (noPkceRes.headers.get("location") ?? "").includes("error=invalid_request"));

const approve = (fields: Record<string, string>) =>
  fetch(as.authorization_endpoint, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_challenge: authorizeUrl.searchParams.get("code_challenge")!,
      state: "xyz",
      vault: vaultId,
      access: "write",
      folders: "",
      name: "claude",
      decision: "approve",
      ...fields,
    }),
  });
check("a wrong owner token is refused", (await approve({ owner_token: "not-the-token" })).status === 400);
const denied = await approve({ owner_token: token, decision: "deny" });
check("deny returns access_denied to the client", (denied.headers.get("location") ?? "").includes("error=access_denied"));
const approved = await approve({ owner_token: token });
const location = new URL(approved.headers.get("location") ?? "http://x/");
const code = location.searchParams.get("code") ?? "";
check("approval redirects back with a code and the state", approved.status === 302 && code !== "" && location.searchParams.get("state") === "xyz");

// ---- token exchange
const tokenRequest = (fields: Record<string, string>) =>
  fetch(as.token_endpoint, { method: "POST", body: new URLSearchParams(fields) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
const badVerifier = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: "wrong" });
check("a wrong PKCE verifier is refused", badVerifier.status === 400 && badVerifier.body.error === "invalid_grant");
const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier });
check("the code is exchanged for access and refresh tokens", tokens.status === 200 && tokens.body.access_token && tokens.body.refresh_token, JSON.stringify(tokens.body));

// ---- MCP with the access token
const created = await mcp(tokens.body.access_token, "tools/call", { name: "create_note", arguments: { path: "Inbox/from-claude.md", content: "hi\n" } });
check("the access token works on the MCP endpoint", created.status === 200 && !created.body.result?.isError, JSON.stringify(created.body));
const recent = await mcp(token, "tools/call", { name: "recent_changes", arguments: {} });
check("changes are attributed to the connection name", JSON.stringify(recent.body).includes("by mcp:claude"), JSON.stringify(recent.body));
check("the token doesn't open other vaults", (await fetch(`${serverUrl}/mcp/${vaultId}-other`, { method: "POST", headers: { authorization: `Bearer ${tokens.body.access_token}` } })).status === 401);
const tampered = tokens.body.access_token.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
check("a tampered token is refused", (await mcp(tampered, "tools/list")).status === 401);

// ---- refresh
const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.body.refresh_token, client_id: reg.client_id });
check("refresh issues a new access token", refreshed.status === 200 && (await mcp(refreshed.body.access_token, "tools/list")).status === 200);
check("an access token is not accepted as a refresh token", (await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.body.access_token })).status === 400);

// ---- a read-only grant limited to a folder
const verifier2 = b64url(crypto.getRandomValues(new Uint8Array(32)));
const approved2 = await fetch(as.authorization_endpoint, {
  method: "POST",
  redirect: "manual",
  body: new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    code_challenge: await challengeOf(verifier2),
    state: "",
    vault: vaultId,
    access: "read",
    folders: "Work",
    name: "chatgpt",
    decision: "approve",
    owner_token: token,
  }),
});
const code2 = new URL(approved2.headers.get("location") ?? "http://x/").searchParams.get("code") ?? "";
const tokens2 = await tokenRequest({ grant_type: "authorization_code", code: code2, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier2 });
const tools = await mcp(tokens2.body.access_token, "tools/list");
const names = (tools.body.result?.tools ?? []).map((t: { name: string }) => t.name);
check("a read-only grant hides write tools", names.includes("read_note") && !names.includes("create_note"), names.join(","));
const outside = await mcp(tokens2.body.access_token, "tools/call", { name: "read_note", arguments: { path: "Inbox/from-claude.md" } });
check("a folder-limited grant can't read outside its folder", outside.body.result?.isError === true, JSON.stringify(outside.body));

console.log(process.exitCode ? "OAUTH E2E FAILED" : "OAUTH E2E OK");
process.exit();
