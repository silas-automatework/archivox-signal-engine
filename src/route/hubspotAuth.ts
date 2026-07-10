import { requireEnv } from "../config.js";

let cached: { token: string; expiresAt: number } | null = null;

/**
 * Accepts both token formats: a private app token (pat-*) is used directly;
 * a personal access key (CLI format) is exchanged for a short-lived access
 * token. Note: personal access keys cannot write CRM objects; production
 * routing requires a private app token.
 */
export async function hubspotToken(): Promise<string> {
  const raw = requireEnv("HUBSPOT_TOKEN");
  if (raw.startsWith("pat-")) return raw;

  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const res = await fetch("https://api.hubapi.com/localdevauth/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encodedOAuthRefreshToken: raw }),
  });
  if (!res.ok) throw new Error(`HubSpot personal-access-key exchange failed: ${res.status}`);
  const data = (await res.json()) as { oauthAccessToken: string; expiresAtMillis: number };
  cached = { token: data.oauthAccessToken, expiresAt: data.expiresAtMillis };
  return cached.token;
}

export async function hs(path: string, init?: RequestInit & { json?: unknown }): Promise<any> {
  const token = await hubspotToken();
  const res = await fetch(`https://api.hubapi.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`HubSpot ${init?.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}
