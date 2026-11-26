/**
 * Scheduler: for every enabled target, starts journeys at the rate given by the active
 * traffic profile (x the target's rate multiplier) and picks the persona by weight.
 * All settings live in `settings` and can be changed at runtime from the web UI.
 */
import { logger, env, envNumber, envBool } from "@shop/telemetry";
import { journeyNames, runJourney, JourneyError, thinkTime } from "./journeys.js";
import type { JourneyName } from "./journeys.js";
import { journeyScope, randomUserAgent, targets } from "./targets.js";
import type { Target } from "./targets.js";

export const profileNames = [
  "steady",
  "diurnal",
  "ramp",
  "flash-sale",
  "black-friday",
  "cyber-monday",
  "midnight-sale",
  "lunch-rush",
  "payday",
  "weekend",
  "bot-attack",
] as const;
export type ProfileName = (typeof profileNames)[number];

interface Profile {
  title: string;
  description: string;
  /** Multiplier of baseRate at `t` seconds since the profile started. */
  multiplier: (t: number, s: typeof settings) => number;
  /** Products that get 80% of the attention while the profile is active. */
  hotProducts?: string[];
  /** Persona mix used INSTEAD of the configured weights while the profile is active. */
  weights?: Partial<Record<JourneyName, number>>;
  /** Fresh-login rate used instead of the configured one. */
  freshLoginRate?: number;
}

const P = (s: typeof settings) => s.peakMultiplier;
const electronics = ["p001", "p002", "p004", "p005", "p006"];

export const profiles: Record<ProfileName, Profile> = {
  steady: { title: "Steady", description: "Constant background traffic at the base rate.", multiplier: () => 1 },
  diurnal: {
    title: "Diurnal day",
    description: "A compressed day: quiet at night, busy at midday (period = diurnal period).",
    multiplier: (t, s) => 0.2 + 1.6 * ((1 - Math.cos((2 * Math.PI * t) / s.diurnalPeriodSeconds)) / 2),
  },
  ramp: {
    title: "Ramp (capacity test)",
    description: "Linear climb to the peak multiplier over the ramp duration, then hold. Find where latency bends.",
    multiplier: (t, s) => 1 + (P(s) - 1) * Math.min(1, t / s.rampSeconds),
  },
  "flash-sale": {
    title: "Flash sale",
    description: "Spike to the peak within 30 s; 80% of interest on three hot products (stock contention, cache hot keys).",
    multiplier: (t, s) => 1 + (P(s) - 1) * Math.min(1, t / 30),
    hotProducts: ["p004", "p005", "p019"],
  },
  "black-friday": {
    title: "Black Friday",
    description: "Doors open: climb to 80% of peak in 2 minutes, then a 'doorbuster' surge for 45 s every 5 minutes. Many buyers, electronics sell out.",
    multiplier: (t, s) => {
      const open = Math.min(1, t / 120);
      const surge = t > 120 && (t - 120) % 300 < 45 ? 1.35 : 1;
      return Math.max(1, (1 + (P(s) - 1) * 0.8) * open * surge);
    },
    hotProducts: electronics,
    weights: { window_shopper: 30, cart_abandoner: 25, buyer: 40, returning_customer: 4, misbehaving_client: 1 },
  },
  "cyber-monday": {
    title: "Cyber Monday",
    description: "Long, sustained high load (60% of peak) with small waves; online buyers and returning customers re-ordering electronics.",
    multiplier: (t, s) => 1 + (P(s) - 1) * 0.6 * Math.min(1, t / 60) * (0.9 + 0.1 * Math.sin((2 * Math.PI * t) / 180)),
    hotProducts: electronics,
    weights: { window_shopper: 35, cart_abandoner: 20, buyer: 30, returning_customer: 14, misbehaving_client: 1 },
  },
  "midnight-sale": {
    title: "Midnight sale",
    description: "Quiet countdown for 60 s, everyone hits 'buy' at midnight (peak for 90 s), then the crowd fades out over a few minutes.",
    multiplier: (t, s) => {
      if (t < 60) return 0.3;
      if (t < 150) return P(s);
      return 1 + (P(s) - 1) * Math.exp(-(t - 150) / 180);
    },
    hotProducts: ["p016", "p017", "p019", "p020"],
    weights: { window_shopper: 25, cart_abandoner: 20, buyer: 50, returning_customer: 4, misbehaving_client: 1 },
  },
  "lunch-rush": {
    title: "Lunch rush",
    description: "Every 10 minutes a short bell-shaped peak (half the peak multiplier) of people browsing on their break. Mostly window shopping.",
    multiplier: (t, s) => {
      const phase = (t % 600) / 600;
      return 0.5 + (Math.max(1, P(s) / 2) - 0.5) * Math.exp(-((phase - 0.5) ** 2) / (2 * 0.08 ** 2));
    },
    weights: { window_shopper: 70, cart_abandoner: 18, buyer: 10, returning_customer: 1, misbehaving_client: 1 },
  },
  payday: {
    title: "Payday",
    description: "3x traffic for the whole period and people actually buy: high checkout share, larger orders, many returning customers.",
    multiplier: (_t, s) => Math.min(3, P(s)),
    weights: { window_shopper: 30, cart_abandoner: 20, buyer: 35, returning_customer: 14, misbehaving_client: 1 },
  },
  weekend: {
    title: "Lazy weekend",
    description: "A slow, long day (twice the diurnal period) of relaxed browsing with long think times and few purchases.",
    multiplier: (t, s) => 0.4 + 1.1 * ((1 - Math.cos((2 * Math.PI * t) / (2 * s.diurnalPeriodSeconds))) / 2),
    weights: { window_shopper: 65, cart_abandoner: 25, buyer: 8, returning_customer: 1, misbehaving_client: 1 },
  },
  "bot-attack": {
    title: "Bot attack",
    description: "Credential stuffing and junk requests: 2x traffic, 70% misbehaving clients, every login is fresh. Floods auth with 401s and bcrypt work.",
    multiplier: () => 2,
    weights: { window_shopper: 15, cart_abandoner: 10, buyer: 4, returning_customer: 1, misbehaving_client: 70 },
    freshLoginRate: 1,
  },
};

/** Multipliers over time, for the preview chart in the UI. */
export function previewOf(p: ProfileName, points = 80) {
  const horizon = p === "diurnal" ? settings.diurnalPeriodSeconds : p === "weekend" ? 2 * settings.diurnalPeriodSeconds : p === "ramp" ? Math.round(settings.rampSeconds * 1.3) : 1800;
  return {
    horizonSeconds: horizon,
    values: Array.from({ length: points }, (_, i) => Math.round(profiles[p].multiplier((horizon * i) / (points - 1), settings) * 100) / 100),
  };
}

export const effectiveWeights = (): Record<JourneyName, number> => {
  const w = profiles[settings.profile].weights;
  return w ? (Object.fromEntries(journeyNames.map((j) => [j, w[j] ?? 0])) as Record<JourneyName, number>) : settings.weights;
};
export const effectiveFreshLoginRate = () => profiles[settings.profile].freshLoginRate ?? settings.freshLoginRate;

function parseWeights(s: string): Record<JourneyName, number> {
  const w = Object.fromEntries(journeyNames.map((n) => [n, 0])) as Record<JourneyName, number>;
  for (const part of s.split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if ((journeyNames as string[]).includes(k)) w[k as JourneyName] = Number(v) || 0;
  }
  return w;
}

const initialProfile = env("PROFILE", "steady") as ProfileName;

/** Everything adjustable from the UI. */
export const settings = {
  running: envBool("AUTOSTART", true),
  profile: (profileNames.includes(initialProfile) ? initialProfile : "steady") as ProfileName,
  /** Journeys started per second per target at multiplier 1. */
  baseRate: envNumber("BASE_RATE", 2),
  /** Max journeys in flight per target. */
  maxConcurrent: envNumber("MAX_CONCURRENT_JOURNEYS", 150),
  /** Probability that an authenticated journey logs in again instead of reusing its token. */
  freshLoginRate: envNumber("FRESH_LOGIN_RATE", 0.1),
  peakMultiplier: envNumber("PEAK_MULTIPLIER", 10),
  rampSeconds: envNumber("RAMP_SECONDS", 600),
  diurnalPeriodSeconds: envNumber("DIURNAL_PERIOD_SECONDS", 1800),
  thinkTime,
  weights: parseWeights(env("PERSONA_WEIGHTS", "window_shopper=55,cart_abandoner=25,buyer=15,returning_customer=4,misbehaving_client=1")),
};
let profileStartedAt = Date.now();

export function setProfile(p: ProfileName) {
  settings.profile = p;
  profileStartedAt = Date.now();
  logger.info({ profile: p }, "traffic profile changed");
}

export const profileElapsedSeconds = () => (Date.now() - profileStartedAt) / 1000;
export const multiplier = () => profiles[settings.profile].multiplier(profileElapsedSeconds(), settings);
export const rateFor = (t: Target) => (settings.running && t.config.enabled ? settings.baseRate * multiplier() * t.config.rateMultiplier : 0);

// ---- per-target runtime counters ---------------------------------------------------------

interface Runtime {
  active: number;
  started: number;
  skipped: number;
  outcomes: Record<string, number>;
  durations: Record<string, { count: number; totalMs: number }>;
  recentErrors: { at: string; journey: string; message: string }[];
}
const runtime = new Map<string, Runtime>();
export function runtimeOf(name: string): Runtime {
  let r = runtime.get(name);
  if (!r) {
    r = { active: 0, started: 0, skipped: 0, outcomes: {}, durations: {}, recentErrors: [] };
    runtime.set(name, r);
  }
  return r;
}
export const resetRuntime = () => runtime.clear();

function pickJourney(): JourneyName {
  const weights = effectiveWeights();
  const total = journeyNames.reduce((n, j) => n + weights[j], 0);
  if (total <= 0) return "window_shopper";
  let r = Math.random() * total;
  for (const j of journeyNames) {
    r -= weights[j];
    if (r <= 0) return j;
  }
  return "window_shopper";
}

async function launch(target: Target, name: JourneyName) {
  const rt = runtimeOf(target.config.name);
  rt.active++;
  rt.started++;
  const started = Date.now();
  let outcome = "failed";
  try {
    outcome = await journeyScope.run({ journey: name, userAgent: randomUserAgent() }, () =>
      runJourney(name, { target, hotProducts: profiles[settings.profile].hotProducts ?? [], freshLoginRate: effectiveFreshLoginRate() }),
    );
  } catch (err) {
    const e = err as Error;
    rt.recentErrors.unshift({ at: new Date().toISOString(), journey: name, message: e.message });
    rt.recentErrors.length = Math.min(rt.recentErrors.length, 25);
    logger.debug({ target: target.config.name, journey: name, err: e.message, status: e instanceof JourneyError ? e.status : undefined }, "journey failed");
  } finally {
    rt.active--;
    const key = `${name}:${outcome}`;
    rt.outcomes[key] = (rt.outcomes[key] ?? 0) + 1;
    const d = (rt.durations[name] ??= { count: 0, totalMs: 0 });
    d.count++;
    d.totalMs += Date.now() - started;
  }
}

let timer: NodeJS.Timeout | undefined;

export function startEngine() {
  const TICK_MS = 100;
  timer = setInterval(() => {
    for (const target of targets.values()) {
      const rt = runtimeOf(target.config.name);
      target.carry += (rateFor(target) * TICK_MS) / 1000;
      while (target.carry >= 1) {
        target.carry -= 1;
        if (rt.active >= settings.maxConcurrent) {
          rt.skipped++;
          continue;
        }
        void launch(target, pickJourney());
      }
    }
  }, TICK_MS);
  logger.info({ profile: settings.profile, baseRate: settings.baseRate, running: settings.running, targets: [...targets.keys()] }, "traffic engine started");
}

export const stopEngine = () => timer && clearInterval(timer);
