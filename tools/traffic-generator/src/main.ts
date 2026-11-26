/**
 * Traffic generator: web UI on "/" and a control API on /api/* (Bearer CONTROL_TOKEN).
 * Published only on the instructor's machine (127.0.0.1:8091), never through the shop.
 *
 *   GET  /api/status                         settings, targets, drills
 *   PUT  /api/settings                       change any setting (partial)
 *   GET  /api/stats?target=all|<name>        dashboard data   POST /api/stats/reset
 *   GET|POST /api/targets   PUT|DELETE /api/targets/:name   POST /api/targets/:name/test
 *   POST /api/drills/:name  { targets?, durationSeconds? }    POST /api/drills/stop
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createServer, start, logger, env, envNumber, HttpError } from "@shop/telemetry";
import { effectiveFreshLoginRate, effectiveWeights, multiplier, previewOf, profileElapsedSeconds, profileNames, profiles, rateFor, resetRuntime, runtimeOf, setProfile, settings, startEngine, stopEngine } from "./engine.js";
import { activeDrill, drills, startDrill, stopDrill } from "./drills.js";
import { journeyNames } from "./journeys.js";
import { loadTargets, removeTarget, targets, upsertTarget } from "./targets.js";
import { reset as resetStats, snapshot } from "./stats.js";

const PORT = envNumber("PORT", 8080);
const CONTROL_TOKEN = env("CONTROL_TOKEN");

const app = createServer({ requestLogging: false });

app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  const h = req.headers.authorization ?? "";
  const a = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const b = Buffer.from(CONTROL_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.status(401).send({ error: "unauthorized", message: "invalid control token" });
});

app.get("/", async (_req, reply) => {
  reply.type("text/html").header("cache-control", "no-cache").send(await readFile(path.join(__dirname, "../public/index.html"), "utf8"));
});

const status = () => ({
  settings: { ...settings, thinkTime: { ...settings.thinkTime } },
  multiplier: Math.round(multiplier() * 100) / 100,
  profileElapsedSeconds: Math.round(profileElapsedSeconds()),
  effectiveWeights: effectiveWeights(),
  effectiveFreshLoginRate: effectiveFreshLoginRate(),
  profiles: profileNames.map((p) => ({
    name: p,
    title: profiles[p].title,
    description: profiles[p].description,
    hotProducts: profiles[p].hotProducts ?? [],
    weights: profiles[p].weights ?? null,
    freshLoginRate: profiles[p].freshLoginRate ?? null,
    preview: previewOf(p),
  })),
  journeys: journeyNames,
  drills: Object.entries(drills).map(([name, d]) => ({ name, description: d.description, durationSeconds: d.durationSeconds, needsProvider: Boolean(d.chaos) })),
  activeDrill: activeDrill(),
  targets: [...targets.values()].map((t) => {
    const rt = runtimeOf(t.config.name);
    return {
      ...t.view(),
      effectiveRate: Math.round(rateFor(t) * 100) / 100,
      activeJourneys: rt.active,
      journeysStarted: rt.started,
      journeysSkipped: rt.skipped,
      outcomes: rt.outcomes,
      avgJourneyMs: Object.fromEntries(Object.entries(rt.durations).map(([k, d]) => [k, Math.round(d.totalMs / d.count)])),
      recentErrors: rt.recentErrors,
    };
  }),
});

app.get("/api/status", async () => status());

const SettingsPatch = z
  .object({
    running: z.boolean(),
    profile: z.enum(profileNames),
    baseRate: z.number().min(0).max(200),
    maxConcurrent: z.number().int().min(1).max(5000),
    freshLoginRate: z.number().min(0).max(1),
    peakMultiplier: z.number().min(1).max(100),
    rampSeconds: z.number().int().min(10).max(7200),
    diurnalPeriodSeconds: z.number().int().min(60).max(86400),
    thinkTime: z.object({ minMs: z.number().int().min(0).max(60_000), maxMs: z.number().int().min(0).max(60_000) }),
    weights: z.record(z.enum(journeyNames as [string, ...string[]]), z.number().min(0).max(1000)),
  })
  .partial();

app.put("/api/settings", async (req) => {
  const patch = SettingsPatch.parse(req.body);
  if (patch.profile && patch.profile !== settings.profile) setProfile(patch.profile);
  if (patch.running !== undefined) settings.running = patch.running;
  for (const k of ["baseRate", "maxConcurrent", "freshLoginRate", "peakMultiplier", "rampSeconds", "diurnalPeriodSeconds"] as const) {
    if (patch[k] !== undefined) settings[k] = patch[k] as number;
  }
  if (patch.thinkTime) Object.assign(settings.thinkTime, patch.thinkTime);
  if (patch.weights) Object.assign(settings.weights, patch.weights);
  logger.info({ settings: patch }, "settings changed");
  return status();
});

app.get("/api/stats", async (req) => snapshot(z.object({ target: z.string().optional() }).parse(req.query).target));
app.post("/api/stats/reset", async () => {
  resetStats();
  resetRuntime();
  return { reset: true };
});

app.get("/api/targets", async () => [...targets.values()].map((t) => t.view()));
app.post("/api/targets", async (req, reply) => {
  const name = (req.body as { name?: string })?.name;
  if (name && targets.has(name)) throw new HttpError(409, `target ${name} already exists`, "exists");
  return reply.status(201).send(upsertTarget(req.body).view());
});
app.put("/api/targets/:name", async (req) => {
  const { name } = z.object({ name: z.string() }).parse(req.params);
  if (!targets.has(name)) throw new HttpError(404, `no target ${name}`, "not_found");
  return upsertTarget(req.body, name).view();
});
app.delete("/api/targets/:name", async (req) => {
  const { name } = z.object({ name: z.string() }).parse(req.params);
  if (!removeTarget(name)) throw new HttpError(404, `no target ${name}`, "not_found");
  return { removed: name };
});

/** Check that a target is reachable and that its seed password works. */
app.post("/api/targets/:name/test", async (req) => {
  const { name } = z.object({ name: z.string() }).parse(req.params);
  const t = targets.get(name);
  if (!t) throw new HttpError(404, `no target ${name}`, "not_found");
  const check = async (label: string, fn: () => Promise<string>) => {
    try {
      return { check: label, ok: true, detail: await fn() };
    } catch (err) {
      return { check: label, ok: false, detail: (err as Error).message };
    }
  };
  return {
    target: name,
    results: [
      await check("catalog reachable", async () => {
        const r = await t.anonymous.get("/catalog/products?limit=1");
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        return "HTTP 200";
      }),
      await check("seed user login", async () => {
        const s = t.leaseUser();
        try {
          await t.authenticate(s, true);
          return `${s.username} signed in`;
        } finally {
          t.releaseUser(s);
        }
      }),
      await check("payment provider admin", async () => {
        if (!t.config.providerAdminUrl) return "not configured (drills with chaos unavailable)";
        const r = await fetch(new URL("/admin/chaos", t.config.providerAdminUrl), {
          headers: { authorization: `Bearer ${t.config.providerAdminToken ?? ""}` },
          signal: AbortSignal.timeout(5000),
        });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        return "HTTP 200";
      }),
    ],
  };
});

app.post("/api/drills/stop", async () => {
  await stopDrill();
  return status();
});
app.post("/api/drills/:name", async (req) => {
  const { name } = z.object({ name: z.string() }).parse(req.params);
  const body = z.object({ targets: z.array(z.string()).optional(), durationSeconds: z.number().int().min(10).max(7200).optional() }).parse(req.body ?? {});
  if (!drills[name]) throw new HttpError(404, `unknown drill ${name}`, "unknown_drill");
  try {
    await startDrill(name, body.targets, body.durationSeconds);
  } catch (err) {
    throw new HttpError(400, (err as Error).message, "drill_failed");
  }
  return status();
});

async function main() {
  loadTargets();
  startEngine();
  await start(app, PORT, [stopEngine]);
}

main().catch((err) => {
  logger.fatal({ err }, "traffic generator failed to start");
  process.exit(1);
});
