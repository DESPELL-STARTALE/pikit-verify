// sky-sim.mjs — 하늘 이벤트 "✨ 별"(D125) 시뮬레이터. 저장소 엔진(packages/engine/dist)을 그대로 돌린다 (먼저 `pnpm --filter @pikit/engine build`).
// 스크래치 도구 _analysis/sim-sky-event-2026-10-11/sky.mjs를 저장소 엔진·카탈로그 이름(skyEvent.grow 등)으로 옮긴 것 — 숫자는 docs/sky-event-balance.md.
// 모드:
//   board : 플레이어 N명이 쉬지 않고(또는 --gap 평균 초만큼 쉬고) 무작위 등급을 산다. 등급별 표(광산 RTP·POP·수명·비정상 종료),
//           이벤트 빈도(조건 충족 시간 기준), 잡기 공정성(아이템이 떨어질 때 판에 있던 등급별 잡을 확률), 커진 몸 겹침 안전.
//   pairs : board처럼 돌다가 잡힌 윈도마다 상태를 둘로 복제해 A(효과 그대로) / B(효과 취소, 원래 크기)를 같은 미래 난수로 끝까지 굴린다
//           (새 구매·새 아이템 없음). 잡은 곡괭이 하나의 광산·POP·남은 수명·타격 차이 = 효과 1번의 인과 효과.
//   snipe : 아이템이 떨어진 윈도마다 "그걸 보고 바로 사는 사람"(지연 L 윈도 뒤 구매가 엔진에 들어감)을 등급별로 굴려
//           무작위 순간(조건 충족, 아이템 없음)에 산 것과 광산 몫을 비교 → κ_sky. 새 아이템은 두 쪽 다 끔.
// usage: node packages/engine/scripts/sky-sim.mjs --mode=board --sky=on|none|<skyEvent json> --players=6 --seeds=40 --windows=6000 --workers=3 [--gap=0] [--tiers=r|0,0,4]
//   --sky=on   = 카탈로그(catalogs/normal.json)의 skyEvent 그대로, none = 절을 뺀 카탈로그(규칙 5와 같은 엔진 경로), 경로 = 그 JSON으로 바꿈
//   eligible·skyLive는 윈도 끝 판 위 플레이어 곡괭이 수로 센다(스크래치는 떨어뜨리기 검사 순간 — 거의 같다).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ENG = `${HERE}..`;
const { parseCatalog } = await import("@pikit/protocol");
const E = await import(`${ENG}/dist/src/index.js`);
const { seedFrom, windowFactory } = await import(`${ENG}/dist/test/helpers.js`);
const NORMAL = fileURLToPath(import.meta.resolve("@pikit/protocol/catalogs/normal.json"));

function parseOptions(argv) {
  const o = {
    mode: "board", cat: NORMAL, sky: "on", players: 6, tiers: "r", gap: 0,
    seeds: 40, windows: 6000, workers: 3, seedoff: 0, label: "", lat: "0,5,10", every: 150, tierset: "0,1,2,3,4", maxdrops: 0,
  };
  for (const a of argv) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unknown arg ${a}`);
    const [, k, v] = m;
    if (!(k in o)) throw new Error(`unknown option --${k}`);
    o[k] = typeof o[k] === "number" ? Number(v) : (v ?? "");
  }
  return o;
}

function loadCat(o) {
  const c = parseCatalog(JSON.parse(readFileSync(o.cat, "utf8")));
  if (o.sky === "none") delete c.skyEvent;
  else if (o.sky !== "on") c.skyEvent = JSON.parse(readFileSync(o.sky, "utf8"));
  return parseCatalog(c);
}
const ownerOf = (i) => `0x${(i + 1).toString(16).padStart(40, "a")}`;
const SNIPER = "0xffffffffffffffffffffffffffffffffffff5555";   // ownerOf가 만들 수 없는 주소 (balance.ts --skilled와 같은 이유)
const BIG = 9_000_000_000_000;
const rngFrom = (seed, tag) => E.Xoshiro128ss.fromBytes(new Uint8Array(createHash("sha256").update(seed).update(tag).digest()));

/** 몸 조각과 살아 있는 블록의 가장 깊은 겹침 (벽 제외) — 틱 끝 박힘 검사. */
function blockOverlap(physics, p, blocks, width) {
  let best = 0;
  for (const prim of physics.primitivesOf(p)) {
    const sx = Math.max(0, Math.floor(Math.min(prim.ax, prim.bx) - prim.r));
    const ex = Math.min(width - 1, Math.floor(Math.max(prim.ax, prim.bx) + prim.r));
    const sy = Math.floor(Math.min(prim.ay, prim.by) - prim.r);
    const ey = Math.floor(Math.max(prim.ay, prim.by) + prim.r);
    for (let y = sy; y <= ey; y++) for (let x = sx; x <= ex; x++) {
      const b = E.getActiveBlockFromRingBuffer(blocks, width, x, y);
      if (!b) continue;
      const ct = E.capsuleBlockContact(prim, b);
      if (ct && ct.depth > best) best = ct.depth;
    }
  }
  return best;
}

/** 방 하나를 돌린다. hook(state, res, w, ctl)이 윈도마다 불린다. */
function runRoom(o, c, s, hook) {
  const seed = seedFrom(10_000 + o.seedoff + s);
  const pick = rngFrom(seed, "balance-tiers");
  const gapRng = rngFrom(seed, "balance-gaps");
  const secPerWindow = c.world.ticksPerWindow / c.physics.fps;
  const policies = o.tiers === "r" ? Array.from({ length: o.players }, () => -1) : o.tiers.split(",").map(Number);
  const owners = policies.map((_, i) => ownerOf(i));
  const state = E.createRoom(c, windowFactory(seed, 1, 0), 1, 0);
  const readyAt = new Map();
  let ref = 1;
  for (let w = 1; w <= o.windows; w++) {
    const inputs = [];
    owners.forEach((owner, i) => {
      const slot = state.owners.find((x) => x.owner === owner);
      if ((!slot || (slot.activeKey === null && slot.queue.length === 0)) && w >= (readyAt.get(owner) ?? 1)) {
        const tier = policies[i] < 0 ? Math.floor(pick.next() * c.pickaxes.length) : policies[i];
        inputs.push({ type: "purchase", ref: String(ref++), owner, tiers: [tier] });
      }
    });
    const res = E.runWindow(state, c, w, inputs, windowFactory(seed, 1, w));
    hook(state, res, w, seed);
    for (const r of res.ended) {
      const gap = o.gap > 0 ? Math.round((-o.gap * Math.log(1 - gapRng.next())) / secPerWindow) : 0;
      readyAt.set(r.owner, w + 1 + gap);
    }
  }
}

// ── board ───────────────────────────────────────────────────────────────────
function board(o, seeds) {
  const c = loadCat(o);
  const physics = E.physicsFor(c);
  const width = c.world.width;
  const rows = [];
  const st = {
    windows: 0, eligible: 0, itemWindows: 0, noSpot: 0, interceptions: 0, drops: 0, catches: 0, expired: 0, delays: [], presence: [0, 0, 0, 0, 0], caughtBy: [0, 0, 0, 0, 0],
    boostedSamples: 0, boostedOver05: 0, boostedMax: 0, normalSamples: 0, normalOver05: 0, normalMax: 0, liveHist: new Array(12).fill(0),
    reachedFull: 0, boostedEnded: 0, ticksToFull: [],
  };
  for (const s of seeds) {
    const caught = new Map();   // key → { tick, durLeft, popAt, maxScale, fullTick }
    const dropTick = new Map();
    const dropTarget = new Map();
    runRoom(o, c, s, (state, res, w) => {
      st.windows += 1;
      const live = state.pickaxes.filter((p) => p.owner !== null).length;
      st.liveHist[Math.min(11, live)] += 1;
      if (c.skyEvent && live >= c.skyEvent.minPlayers) st.eligible += 1;
      for (const e of res.sky) {
        if (e.kind === "DROP") {
          st.drops += 1;
          dropTick.set(e.id, e.tick);
          dropTarget.set(e.id, e.key);
          for (const p of state.pickaxes) if (p.owner !== null) st.presence[p.tier] += 1;
        } else if (e.kind === "CAUGHT") {
          st.catches += 1;
          st.caughtBy[e.tier] += 1;
          if (dropTarget.get(e.id) !== null && dropTarget.get(e.id) !== e.key) st.interceptions += 1;
          st.delays.push(e.tick - dropTick.get(e.id));
          const p = state.pickaxes.find((q) => q.key === e.key);
          caught.set(e.key, { tick: e.tick, durLeft: p ? p.durabilityLeft / p.durabilityTotal : 0, popAt: p ? p.popDone : false, maxScale: p ? p.scale : 0, fullTick: -1 });
        } else st.expired += 1;
      }
      if (state.sky?.item || res.sky.length > 0) st.itemWindows += 1;
      // 커진 몸 박힘 (윈도 끝 표본): 효과 중인 몸은 매 윈도, 보통 몸은 10윈도마다
      for (const p of state.pickaxes) {
        if (p.owner === null) continue;
        const base = c.pickaxes[p.tier].scale;
        const boosted = p.scale !== base || (state.sky?.boosts ?? []).some((b) => b.key === p.key);
        if (boosted) {
          const d = blockOverlap(physics, p, state.blocks, width);
          st.boostedSamples += 1; if (d > 0.05) st.boostedOver05 += 1; if (d > st.boostedMax) st.boostedMax = d;
          const k = caught.get(p.key);
          if (k) {
            if (p.scale > k.maxScale) k.maxScale = p.scale;
            const target = E.skyGrowScale(c.skyEvent, base);
            if (k.fullTick < 0 && p.scale >= target - 1e-9) k.fullTick = state.tick - 1;
          }
        } else if (w % 10 === 0) {
          const d = blockOverlap(physics, p, state.blocks, width);
          st.normalSamples += 1; if (d > 0.05) st.normalOver05 += 1; if (d > st.normalMax) st.normalMax = d;
        }
      }
      for (const r of res.ended) {
        const k = caught.get(r.key);
        if (k) {
          st.boostedEnded += 1;
          const target = E.skyGrowScale(c.skyEvent, c.pickaxes[r.tier].scale);
          if (k.maxScale >= target - 1e-9) st.reachedFull += 1;
          if (k.fullTick >= 0) st.ticksToFull.push(k.fullTick - k.tick);
        }
        rows.push({
          tier: r.tier, mine: r.paidMilli, price: r.priceMilli, pop: r.pop ? 1 : 0, life: (r.endTick + 1 - r.spawnTick) / c.physics.fps,
          hits: r.hits, broken: r.blocksBroken, end: r.endReason, caught: k ? 1 : 0, catchFrac: k ? (k.tick - r.spawnTick) / (r.endTick + 1 - r.spawnTick) : null,
          durLeft: k ? k.durLeft : null, popAt: k ? (k.popAt ? 1 : 0) : null,
        });
        caught.delete(r.key);
      }
    });
  }
  return { rows, st };
}

// ── pairs ───────────────────────────────────────────────────────────────────
function rollToEnd(c, s0, key, seed, w0, watch) {
  for (let x = w0; x < w0 + 3000; x++) {
    const res = E.runWindow(s0, c, x, [], windowFactory(seed, 1, x));
    if (watch) watch(s0, res);
    const r = res.ended.find((q) => q.key === key);
    if (r) return r;
  }
  throw new Error(`pair rollout did not end (${key})`);
}

function pairs(o, seeds) {
  const c = loadCat(o);
  const out = [];
  let drops = 0;
  for (const s of seeds) {
    runRoom(o, c, s, (state, res, w, seed) => {
      for (const e of res.sky) {
        if (e.kind === "DROP") drops += 1;
        if (e.kind !== "CAUGHT") continue;
        const p0 = state.pickaxes.find((q) => q.key === e.key);
        if (!p0) continue;   // 잡은 틱에 끝남 (정산 뒤 잡기라 원칙상 없음)
        const base = c.pickaxes[p0.tier].scale;
        const target = E.skyGrowScale(c.skyEvent, base);
        const A = E.cloneRoom(state);
        const B = E.cloneRoom(state);
        for (const S of [A, B]) { S.sky.nextWindow = BIG; S.sky.item = null; }
        B.sky.boosts = B.sky.boosts.filter((b) => b.key !== e.key);
        { const pb = B.pickaxes.find((q) => q.key === e.key); pb.scale = base; pb.attack = c.pickaxes[pb.tier].attack; }
        let fullTick = -1;
        let maxScale = 0;
        let hitsInBoost = 0;
        let brokenInBoost = 0;
        let brokenInBoostB = 0;
        const untilTick = e.tick + c.skyEvent.grow.durationTicks;
        const ra = rollToEnd(c, A, e.key, seed, w + 1, (S) => {
          const p = S.pickaxes.find((q) => q.key === e.key);
          if (!p) return;
          if (p.scale > maxScale) maxScale = p.scale;
          if (fullTick < 0 && p.scale >= target - 1e-9) fullTick = S.tick - 1;
          if (S.tick <= untilTick) { hitsInBoost = p.hits; brokenInBoost = p.blocksBroken; }
        });
        let hitsInWindowB = 0;
        const rb = rollToEnd(c, B, e.key, seed, w + 1, (S) => {
          const p = S.pickaxes.find((q) => q.key === e.key);
          if (p && S.tick <= untilTick) { hitsInWindowB = p.hits; brokenInBoostB = p.blocksBroken; }
        });
        out.push({
          tier: p0.tier, price: p0.priceMilli, popAt: p0.popDone ? 1 : 0, durLeft: p0.durabilityLeft / p0.durabilityTotal, hitsAt: p0.hits,
          aMine: ra.paidMilli, bMine: rb.paidMilli, aPop: ra.pop ? 1 : 0, bPop: rb.pop ? 1 : 0,
          aRest: ra.endTick - e.tick, bRest: rb.endTick - e.tick, aHits: ra.hits, bHits: rb.hits, aBroken: ra.blocksBroken, bBroken: rb.blocksBroken,
          aEnd: ra.endReason, bEnd: rb.endReason, maxScale, target, fullTicks: fullTick >= 0 ? fullTick - e.tick : null,
          boostHits: hitsInBoost - p0.hits, boostHitsB: hitsInWindowB - p0.hits, boostBroken: brokenInBoost - p0.blocksBroken, boostBrokenB: brokenInBoostB - p0.blocksBroken,
          diedInBoost: ra.endTick <= untilTick ? 1 : 0, diedInBoostB: rb.endTick <= untilTick ? 1 : 0, aDistinct: ra.distinctBlocks, bDistinct: rb.distinctBlocks,
        });
      }
    });
  }
  return { out, drops };
}

// ── snipe ───────────────────────────────────────────────────────────────────
function snipeRoll(c, state, seed, w, L, tier) {
  const S = E.cloneRoom(state);
  if (S.sky) S.sky.nextWindow = BIG;
  const key = `snipe${w}x${L}x${tier}:0`;
  let caught = 0;
  for (let x = w + 1; x < w + 3000; x++) {
    const inputs = x === w + 1 + L ? [{ type: "purchase", ref: `snipe${w}x${L}x${tier}`, owner: SNIPER, tiers: [tier] }] : [];
    const res = E.runWindow(S, c, x, inputs, windowFactory(seed, 1, x));
    if (S.sky) S.sky.nextWindow = BIG;   // 지금 아이템 하나만 — 끝나며 쿨다운이 다시 써도 새 아이템 없음
    for (const e of res.sky) if (e.kind === "CAUGHT" && e.key === key) caught = 1;
    const r = res.ended.find((q) => q.key === key);
    if (r) return { mine: r.paidMilli / r.priceMilli, pop: r.pop ? 1 : 0, caught, life: (r.endTick + 1 - r.spawnTick) / c.physics.fps };
  }
  throw new Error("snipe rollout did not end");
}

function snipe(o, seeds) {
  const c = loadCat(o);
  const Ls = o.lat.split(",").map(Number);
  const tierset = o.tierset.split(",").map(Number);
  const rec = [];
  let drops = 0;
  for (const s of seeds) {
    let lastBase = -1e9;
    runRoom(o, c, s, (state, res, w, seed) => {
      const drop = res.sky.find((e) => e.kind === "DROP");
      if (drop && state.sky?.item) {
        if (o.maxdrops > 0 && drops >= o.maxdrops) return;
        drops += 1;
        for (const L of Ls) for (const t of tierset) rec.push({ kind: "drop", L, tier: t, ...snipeRoll(c, state, seed, w, L, t) });
      } else if (!state.sky?.item && res.sky.length === 0 && state.pickaxes.filter((p) => p.owner !== null).length >= c.skyEvent.minPlayers && w - lastBase >= o.every) {
        lastBase = w;
        for (const t of tierset) rec.push({ kind: "base", L: 0, tier: t, ...snipeRoll(c, state, seed, w, 0, t) });
      }
    });
  }
  return { rec, drops };
}

// ── tables ──────────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const se = (a) => sd(a) / Math.sqrt(Math.max(1, a.length));
const quant = (a, q) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(q * b.length))] : NaN; };
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "–");
const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : "–");
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "–");
const pct2 = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "–");

function boardTables(o, c, parts) {
  const rows = parts.flatMap((p) => p.rows);
  const st = parts.map((p) => p.st).reduce((a, b) => {
    for (const k of Object.keys(a)) {
      if (Array.isArray(a[k])) a[k] = a[k].length === b[k].length && typeof a[k][0] === "number" && k !== "delays" && k !== "ticksToFull" ? a[k].map((v, i) => v + b[k][i]) : a[k].concat(b[k]);
      else if (k.endsWith("Max")) a[k] = Math.max(a[k], b[k]);
      else a[k] += b[k];
    }
    return a;
  });
  const out = [];
  const spw = c.world.ticksPerWindow / c.physics.fps;
  out.push("| tier | n | mining RTP Σ/Σ ± SE | POP | lifetime s (med) | hits | broken | abnormal | caught | caught: catch at % of life · durability left · POP already |");
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  const line = (label, rs) => {
    const sp = rs.reduce((a, r) => a + r.price, 0);
    const R = rs.reduce((a, r) => a + r.mine, 0) / sp;
    const seR = Math.sqrt(rs.reduce((a, r) => a + (r.mine - R * r.price) ** 2, 0)) / sp;
    const cs = rs.filter((r) => r.caught);
    out.push(`| ${label} | ${rs.length} | **${f4(R)}** ±${f4(seR)} | ${pct(mean(rs.map((r) => r.pop)))} | ${f1(mean(rs.map((r) => r.life)))} (${f1(quant(rs.map((r) => r.life), 0.5))}) | ${f1(mean(rs.map((r) => r.hits)))} | ${f1(mean(rs.map((r) => r.broken)))} | ${rs.filter((r) => r.end !== "DURABILITY").length} | ${cs.length} (${pct2(cs.length / rs.length)}) | ${pct(mean(cs.map((r) => r.catchFrac)))} · ${pct(mean(cs.map((r) => r.durLeft)))} · ${pct(mean(cs.map((r) => r.popAt)))} |`);
  };
  for (let t = 0; t < c.pickaxes.length; t++) line(`${c.pickaxes[t].code} ×${c.pickaxes[t].priceCredits / 1000}`, rows.filter((r) => r.tier === t));
  line("all", rows);
  out.push("");
  const hours = (st.windows * spw) / 3600;
  const eligH = (st.eligible * spw) / 3600;
  out.push(`board time ${f1(hours)} h (${st.windows} windows); eligible (≥ ${c.skyEvent?.minPlayers ?? "–"} live player pickaxes at the drop check) ${pct(st.eligible / st.windows)}; live player pickaxes histogram (0…11+): ${st.liveHist.map((v) => pct(v / st.windows)).join(" ")}`);
  if (c.skyEvent) {
    out.push(`drops ${st.drops} = **${f1(st.drops / hours)} / board-hour**, ${f1(st.drops / Math.max(eligH, 1e-9))} / eligible-hour (mean interval ${f1((eligH * 60) / Math.max(1, st.drops))} eligible-min); caught ${st.catches} (${pct(st.catches / Math.max(1, st.drops))}; by another pickaxe than the target ${pct(st.interceptions / Math.max(1, st.catches))}), expired ${st.expired}; drop→catch ${f1(mean(st.delays) / c.physics.fps * 1000)} ms mean, p50 ${f1(quant(st.delays, 0.5) / c.physics.fps * 1000)} ms, p90 ${f1(quant(st.delays, 0.9) / c.physics.fps * 1000)} ms; item on screen ${pct(st.itemWindows / st.windows)} of windows`);
    out.push("");
    out.push("| tier | on board at drop (pickaxe-drops) | caught | P(catch \\| on board at drop) | share of catches | share of presence |");
    out.push("|---|---|---|---|---|---|");
    const P = st.presence.reduce((a, b) => a + b, 0), C = st.caughtBy.reduce((a, b) => a + b, 0);
    for (let t = 0; t < c.pickaxes.length; t++) out.push(`| ${c.pickaxes[t].code} ×${c.pickaxes[t].priceCredits / 1000} | ${st.presence[t]} | ${st.caughtBy[t]} | ${pct(st.caughtBy[t] / Math.max(1, st.presence[t]))} | ${pct(st.caughtBy[t] / Math.max(1, C))} | ${pct(st.presence[t] / Math.max(1, P))} |`);
    out.push("");
    out.push(`boosted bodies: reached target size ${st.reachedFull}/${st.boostedEnded} (${pct(st.reachedFull / Math.max(1, st.boostedEnded))}), ticks catch→full size mean ${f1(mean(st.ticksToFull))} (p90 ${f1(quant(st.ticksToFull, 0.9))}); window-end block overlap > 0.05 tile: boosted ${st.boostedOver05}/${st.boostedSamples} (max ${f3(st.boostedMax)}), normal ${st.normalOver05}/${st.normalSamples} (max ${f3(st.normalMax)})`);
    const perPick = rows.filter((r) => r.caught).length / rows.length;
    out.push(`fun: ${pct2(perPick)} of player pickaxes catch an item here → a 65-pickaxe day on this board catches ≥ 1 with P = ${pct(1 - (1 - perPick) ** 65)}; catches per player-hour ${f1(rows.filter((r) => r.caught).length / (hours * (o.tiers === "r" ? o.players : o.tiers.split(",").length)))}`);
  }
  return out;
}

function pairTables(c, parts) {
  const out = [];
  const ps = parts.flatMap((p) => p.out);
  const drops = parts.reduce((a, p) => a + p.drops, 0);
  out.push(`catches ${ps.length} (drops ${drops}). Per catch, A = effect kept, B = effect cancelled at the end of the catch window (same future randomness, no new buys/items):`);
  out.push("");
  out.push("| tier | catches | Δ mining ÷ price (A − B) ± SE | Δ POP (A − B) | POP already at catch | Δ remaining life s (A − B) | hits in the 6 s (A vs B) | broken in the 6 s (A vs B) | ended within the 6 s (A vs B) | Δ new blocks | Δ broken | reached target | ticks to target | abnormal A / B |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const line = (label, rs) => {
    if (!rs.length) return out.push(`| ${label} | 0 |`);
    const dm = rs.map((r) => (r.aMine - r.bMine) / r.price);
    const dp = rs.map((r) => r.aPop - r.bPop);
    const dl = rs.map((r) => (r.aRest - r.bRest) / c.physics.fps);
    out.push(`| ${label} | ${rs.length} | ${f4(mean(dm))} ±${f4(se(dm))} | ${pct(mean(dp))} ±${pct(se(dp))} | ${pct(mean(rs.map((r) => r.popAt)))} | ${f1(mean(dl))} (A ${f1(mean(rs.map((r) => r.aRest / c.physics.fps)))} / B ${f1(mean(rs.map((r) => r.bRest / c.physics.fps)))}) | ${f1(mean(rs.map((r) => r.boostHits)))} vs ${f1(mean(rs.map((r) => r.boostHitsB)))} | ${f1(mean(rs.map((r) => r.boostBroken)))} vs ${f1(mean(rs.map((r) => r.boostBrokenB)))} | ${pct(mean(rs.map((r) => r.diedInBoost)))} vs ${pct(mean(rs.map((r) => r.diedInBoostB)))} | ${f1(mean(rs.map((r) => r.aDistinct - r.bDistinct)))} | ${f1(mean(rs.map((r) => r.aBroken - r.bBroken)))} | ${pct(mean(rs.map((r) => (r.maxScale >= r.target - 1e-9 ? 1 : 0))))} | ${f1(mean(rs.filter((r) => r.fullTicks !== null).map((r) => r.fullTicks)))} | ${rs.filter((r) => r.aEnd !== "DURABILITY").length} / ${rs.filter((r) => r.bEnd !== "DURABILITY").length} |`);
  };
  for (let t = 0; t < c.pickaxes.length; t++) line(`${c.pickaxes[t].code} ×${c.pickaxes[t].priceCredits / 1000}`, ps.filter((r) => r.tier === t));
  line("all", ps);
  return out;
}

function snipeTables(c, parts) {
  const out = [];
  const rec = parts.flatMap((p) => p.rec);
  const drops = parts.reduce((a, p) => a + p.drops, 0);
  const Ls = [...new Set(rec.filter((r) => r.kind === "drop").map((r) => r.L))].sort((a, b) => a - b);
  out.push(`drops sniped ${drops}; base moments ${rec.filter((r) => r.kind === "base").length / Math.max(1, new Set(rec.map((r) => r.tier)).size)} (eligible board, no item, no new items). κ_sky(L) = mean mining at drop+L ÷ mean mining at base moments (same tier). L = windows between the drop window and the window the purchase enters the engine (0 = impossible zero-latency oracle; real ≥ 4–6).`);
  out.push("");
  out.push(`| tier | base mining (n) | ${Ls.map((L) => `L=${L}: P(catch) · mining · **κ_sky** ± SE`).join(" | ")} |`);
  out.push(`|---|---|${Ls.map(() => "---").join("|")}|`);
  const tiers = [...new Set(rec.map((r) => r.tier))].sort((a, b) => a - b);
  for (const t of [...tiers, -1]) {
    const pick = (r) => t < 0 || r.tier === t;
    const base = rec.filter((r) => r.kind === "base" && pick(r)).map((r) => r.mine);
    const cells = Ls.map((L) => {
      const d = rec.filter((r) => r.kind === "drop" && r.L === L && pick(r));
      const m = d.map((r) => r.mine);
      const k = mean(m) / mean(base);
      const kse = k * Math.sqrt((se(m) / mean(m)) ** 2 + (se(base) / mean(base)) ** 2);
      return `${pct(mean(d.map((r) => r.caught)))} · ${f4(mean(m))} · **${f4(k)}** ±${f4(kse)}`;
    });
    out.push(`| ${t < 0 ? "all" : `${c.pickaxes[t].code} ×${c.pickaxes[t].priceCredits / 1000}`} | ${f4(mean(base))} (${base.length}) | ${cells.join(" | ")} |`);
  }
  return out;
}

async function main() {
  const o = parseOptions(process.argv.slice(2));
  const c = loadCat(o);
  const t0 = Date.now();
  const n = Math.max(1, Math.min(o.workers, o.seeds));
  const seedsAll = Array.from({ length: o.seeds }, (_, i) => i + 1);
  const parts = await Promise.all(Array.from({ length: n }, (_, id) => new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { o, seeds: seedsAll.filter((s) => s % n === id) }, env: process.env });
    worker.once("message", resolve);
    worker.once("error", reject);
  })));
  const sk = c.skyEvent;
  const head = `## ${o.label || o.mode} — mode ${o.mode}, sky ${o.sky}${sk ? ` (min ${sk.minPlayers}, p ${sk.chancePerWindow}, cooldown ${sk.cooldownWindows} w, star ⌀${sk.item.diameter} ${sk.item.aboveRows} rows above a random player pickaxe, catch centre ${sk.item.catchRadius}, life ${sk.item.lifeTicks} t, GROW max(tier, ${sk.grow.scale}) @${sk.grow.stepPerTick}/t for ${sk.grow.durationTicks} t)` : ""}, players ${o.tiers === "r" ? `${o.players} random-tier` : o.tiers}${o.gap ? `, idle gap exp mean ${o.gap} s` : ", continuous"}, seeds ${o.seeds}${o.seedoff ? ` (+${o.seedoff})` : ""} × ${o.windows} windows, ${((Date.now() - t0) / 1000).toFixed(1)} s`;
  const out = [head, ""];
  if (o.mode === "board") out.push(...boardTables(o, c, parts));
  else if (o.mode === "pairs") out.push(...pairTables(c, parts));
  else out.push(...snipeTables(c, parts));
  console.log(out.join("\n"));
}

if (isMainThread) {
  main().catch((e) => { console.error(e); process.exit(1); });
} else {
  const { o, seeds } = workerData;
  parentPort.postMessage(o.mode === "board" ? board(o, seeds) : o.mode === "pairs" ? pairs(o, seeds) : snipe(o, seeds));
}
