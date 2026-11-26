/**
 * Incident drills: a traffic profile and/or chaos settings on a target's payment
 * provider, applied for a fixed time and then reverted automatically.
 * Drills that change the provider need the target's providerAdminUrl + token.
 */
import { callService, logger } from "@shop/telemetry";
import { setProfile, settings } from "./engine.js";
import type { ProfileName } from "./engine.js";
import { targets } from "./targets.js";
import type { Target } from "./targets.js";

interface Drill {
  description: string;
  durationSeconds: number;
  profile?: ProfileName;
  chaos?: Record<string, number>;
  freshLoginRate?: number;
}

export const drills: Record<string, Drill> = {
  "black-friday": {
    description: "black-friday traffic profile (all targets), slower provider and some duplicate webhooks",
    durationSeconds: 900,
    profile: "black-friday",
    chaos: { latencyMs: 1200, latencyJitterMs: 800, duplicateWebhookRate: 0.2 },
  },
  "provider-outage": { description: "the payment provider fails 70% of calls", durationSeconds: 300, chaos: { errorRate: 0.7 } },
  "slow-provider": {
    description: "provider latency close to the shop's 3s timeout: retries, timeouts, late successes",
    durationSeconds: 300,
    chaos: { latencyMs: 2500, latencyJitterMs: 1500, timeoutRate: 0.1 },
  },
  "lost-webhooks": { description: "half of the webhooks never arrive (the reconciler must fix them)", durationSeconds: 300, chaos: { dropWebhookRate: 0.5 } },
  "decline-wave": { description: "many cards declined, synchronously and via webhook", durationSeconds: 300, chaos: { declineRate: 0.4, asyncDeclineRate: 0.2 } },
  "webhook-forgery": { description: "webhooks arrive with invalid signatures", durationSeconds: 300, chaos: { badSignatureRate: 0.5 } },
  "login-storm": { description: "ramp traffic (all targets) where every journey logs in again (bcrypt CPU)", durationSeconds: 300, profile: "ramp", freshLoginRate: 1 },
  "midnight-meltdown": {
    description: "midnight-sale profile while the provider is slow and drops webhooks",
    durationSeconds: 600,
    profile: "midnight-sale",
    chaos: { latencyMs: 1500, latencyJitterMs: 1000, dropWebhookRate: 0.3 },
  },
};

interface Active {
  drill: string;
  endsAt: string;
  targets: string[];
  timer: NodeJS.Timeout;
  restore: { profile: ProfileName; freshLoginRate: number } | null;
}
let active: Active | null = null;

export const activeDrill = () => (active ? { name: active.drill, endsAt: active.endsAt, targets: active.targets } : null);

async function provider(t: Target, path: string, method: string, body?: unknown) {
  const { providerAdminUrl, providerAdminToken } = t.config;
  if (!providerAdminUrl) throw new Error(`target ${t.config.name} has no provider admin URL`);
  const res = await callService(providerAdminUrl, path, { method, body, headers: { authorization: `Bearer ${providerAdminToken ?? ""}` } });
  if (res.status !== 200) throw new Error(`${t.config.name}: provider admin ${path} returned ${res.status}`);
}

/** Start a drill on the given targets (default: all enabled targets). */
export async function startDrill(name: string, targetNames?: string[], durationSeconds?: number) {
  const drill = drills[name];
  if (!drill) throw new Error(`unknown drill ${name}`);
  if (active) await stopDrill();
  const chosen = (targetNames?.length ? targetNames : [...targets.values()].filter((t) => t.config.enabled).map((t) => t.config.name))
    .map((n) => targets.get(n))
    .filter((t): t is Target => Boolean(t));
  if (drill.chaos) {
    const missing = chosen.filter((t) => !t.config.providerAdminUrl).map((t) => t.config.name);
    if (missing.length) throw new Error(`no provider admin URL configured for: ${missing.join(", ")}`);
    await Promise.all(chosen.map((t) => provider(t, "/admin/chaos", "PUT", drill.chaos)));
  }
  const restore = drill.profile || drill.freshLoginRate !== undefined ? { profile: settings.profile, freshLoginRate: settings.freshLoginRate } : null;
  if (drill.profile) setProfile(drill.profile);
  if (drill.freshLoginRate !== undefined) settings.freshLoginRate = drill.freshLoginRate;
  const seconds = durationSeconds ?? drill.durationSeconds;
  active = {
    drill: name,
    endsAt: new Date(Date.now() + seconds * 1000).toISOString(),
    targets: chosen.map((t) => t.config.name),
    restore,
    timer: setTimeout(() => void stopDrill().catch((err) => logger.error({ err }, "could not end drill")), seconds * 1000),
  };
  logger.warn({ drill: name, seconds, targets: active.targets }, "incident drill started");
}

export async function stopDrill() {
  if (!active) return;
  const a = active;
  active = null;
  clearTimeout(a.timer);
  if (a.restore) {
    setProfile(a.restore.profile);
    settings.freshLoginRate = a.restore.freshLoginRate;
  }
  if (drills[a.drill].chaos) {
    const results = await Promise.allSettled(
      a.targets.map((n) => targets.get(n)).filter((t): t is Target => Boolean(t)).map((t) => provider(t, "/admin/chaos/reset", "POST")),
    );
    for (const r of results) if (r.status === "rejected") logger.error({ err: (r.reason as Error).message }, "could not reset provider chaos");
  }
  logger.warn({ drill: a.drill }, "incident drill ended");
}
