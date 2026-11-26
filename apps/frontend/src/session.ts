/**
 * Login session: tokens from the auth-service, kept in localStorage, refreshed
 * automatically shortly before the access token expires.
 */
import { useSyncExternalStore } from "react";
import { ApiError } from "./api";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  username: string;
  roles: string[];
}

interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: SessionUser;
}

const KEY = "shop.session";
const CLIENT_ID = "shop-frontend";
let current: Session | null = read();
const listeners = new Set<() => void>();

function read(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function write(s: Session | null) {
  current = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: keep the session in memory only */
  }
  listeners.forEach((l) => l());
}

function decode(token: string): SessionUser {
  const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { id: payload.sub, email: payload.email, name: payload.name, username: payload.preferred_username, roles: payload.roles ?? [] };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>, path = "/api/auth/oauth/token"): Promise<Session> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, client_id: CLIENT_ID }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse & { message?: string };
  if (!res.ok) {
    throw new ApiError(res.status, data.message ?? data.error_description ?? data.error ?? res.statusText, res.headers.get("x-request-id") ?? undefined);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    user: decode(data.access_token),
  };
}

export async function login(username: string, password: string) {
  write(await tokenRequest({ grant_type: "password", username, password }));
}

export interface Registration {
  username: string;
  email: string;
  name: string;
  password: string;
}

/** Create an account; the auth-service signs the new user in straight away. */
export async function register(r: Registration) {
  write(await tokenRequest({ ...r }, "/api/auth/register"));
}

export function logout() {
  const s = current;
  write(null);
  if (s) void fetch("/api/auth/oauth/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: s.refreshToken }) });
}

let refreshing: Promise<void> | null = null;

/** Refresh the access token (once, even if many requests ask at the same time). */
export async function refresh(): Promise<void> {
  if (!current) return;
  refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: current.refreshToken })
    .then(write)
    .catch(() => write(null))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function accessToken(): Promise<string | null> {
  if (current && current.expiresAt - Date.now() < 30_000) await refresh();
  return current?.accessToken ?? null;
}

export function useUser(): SessionUser | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current?.user ?? null,
  );
}
