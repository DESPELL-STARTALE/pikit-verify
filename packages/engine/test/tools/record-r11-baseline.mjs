// (규칙 12, 명세 25 §5.3-1) 고정 기준 기록기 — 5세계(규칙 11) 엔진 빌드로 "출시 규칙 11 카탈로그 − buffs"를 돌려
// 끝난 곡괭이 결과 · 사건 · 정산 · 묶음 종류 해시 · 끝 상태 해시(v12)를 test/fixtures/r11-baseline.json에 적는다.
// 규칙 12 엔진은 같은 카탈로그의 새 꼴(luckyWeight = 행운 가능 종류의 batchCount, buffs·bounce·quadChanceBps 없음)에서 같은 값을 내야 한다
// (test/r11-baseline.test.ts). 입력(윈도마다 구매·취소·무효·동결)도 여기서 정해 기록에 넣는다 — 시험은 그 입력을 그대로 재생한다.
//
// 쓰는 법 (5세계 코드를 따로 체크아웃해 빌드한 뒤):
//   git worktree add <base> --detach 2f401a40 && (cd <base> && pnpm install --frozen-lockfile && pnpm --filter "@pikit/engine..." build)
//   node packages/engine/test/tools/record-r11-baseline.mjs --base=<base> --out=packages/engine/test/fixtures/r11-baseline.json
// 같은 시드를 두 번 돌려 같은 값인지 먼저 확인한다(결정론) — 다르면 기록하지 않고 멈춘다.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"]; }));
if (!args.base || !args.out) {
  console.error("usage: record-r11-baseline.mjs --base=<world-5 checkout> --out=<fixture.json>");
  process.exit(2);
}
const base = resolve(args.base);
const protocol = await import(pathToFileURL(join(base, "packages/protocol/dist/src/index.js")).href);
const engine = await import(pathToFileURL(join(base, "packages/engine/dist/src/index.js")).href);

const sha256 = (bytes) => `0x${createHash("sha256").update(bytes).digest("hex")}`;
const hh = (n) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
const hexBytes = (h) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));
const ZERO = new Uint8Array(32);
const SHOP = "0x5b0b000000000000000000000000000000000005";

// ── 카탈로그: 5세계 출시 규칙 11 − buffs (옛 꼴로 검사) → 새 꼴(luckyWeight)
const r11 = JSON.parse(readFileSync(join(base, "packages/protocol/catalogs/normal.json"), "utf8"));
if (r11.rulesVersion !== 11) throw new Error(`expected the rules-11 release catalog, got rulesVersion ${r11.rulesVersion}`);
const oldForm = structuredClone(r11);
delete oldForm.buffs;
const oldCatalog = protocol.parseCatalog(oldForm);
const newForm = structuredClone(oldForm);
for (const b of newForm.blocks) {
  b.luckyWeight = b.luckyEligible ? b.batchCount : 0;
  delete b.luckyEligible;
}

/** 잭팟 균열까지 덮는 넷째 판: 같은 카탈로그에서 잭팟만 verifier golden-4 값(기여 1 bps · κ 49 ppm · minPool 1)으로 — 통이 작아 균열이 잦다. */
const JACKPOT_PATCH = { contributionBpsByTier: r11.pickaxes.map(() => 1), kappaPpm: 49, minPoolCredits: 1 };
const withPatch = (c, patch) => (patch ? { ...c, jackpot: { ...c.jackpot, ...patch } } : c);

const RUNS = [
  { name: "seed 0x62 (golden-2 seed)", seed: hh(0x62), roomId: 2, jackpotPatch: null },
  { name: "seed 0x42", seed: hh(0x42), roomId: 1, jackpotPatch: null },
  { name: "seed 0x07", seed: hh(0x07), roomId: 3, jackpotPatch: null },
  { name: "seed 0x01 + golden-4 jackpot (1 bps · κ 49 ppm · minPool 1)", seed: hh(0x01), roomId: 4, jackpotPatch: JACKPOT_PATCH },
];
const FIRST = 1000;
const WINDOWS = 600;
const CHECKPOINT = 100;   // 이 윈도마다 끝 상태 해시(v12) — 어긋나면 어느 100윈도에서인지 보인다
const BOARD_BATCHES = 3;   // 판 생성만 3묶음(600줄, 줄마다 윈도 하나) — 4칸 확률이 없으면 묶음 종류가 규칙 11과 같아야 한다
const WALLETS = Array.from({ length: 8 }, (_, i) => `0x${String(i + 1).repeat(40).slice(0, 40)}`);

/**
 * 판 하나: 지갑 8개가 앞 곡괭이가 끝나면 바로 다음 1개를 산다(등급 = (ref + i) % 등급 수 — test/helpers.ts busyBoard와 같은 정책).
 * 더해서 w+200에 지갑 0이 6개를 더 사고 w+201에 그중 하나를 취소, w+400에 지갑 1의 살아 있는 곡괭이 구매를 무효, w+590에 동결.
 * 입력은 옛 엔진 상태로 정하고 그대로 기록한다(시험은 기록된 입력을 재생 — 되먹임 없음).
 */
function runOnce(catalog, run) {
  const seed = hexBytes(run.seed);
  const shop = hexBytes(SHOP);
  const state = engine.createRoom(catalog, engine.windowRngFactory(seed, 143, shop, run.roomId, FIRST, ZERO), run.roomId, FIRST);
  const out = { windows: [], ended: [], spawned: [], events: [], lastHits: [], jackpots: [], payouts: [], sky: [], voided: [], buffs: [], batches: [], checkpoints: [] };
  let ref = 1;
  let extraRef = null;
  for (let w = FIRST + 1; w <= FIRST + WINDOWS; w++) {
    const inputs = [];
    WALLETS.forEach((owner, i) => {
      const slot = state.owners.find((x) => x.owner === owner);
      if (!slot || (slot.activeKey === null && slot.queue.length === 0)) {
        inputs.push({ type: "purchase", ref: String(ref++), owner, tiers: [(ref + i) % catalog.pickaxes.length] });
      }
    });
    if (w === FIRST + 200) {
      extraRef = String(ref++);
      inputs.push({ type: "purchase", ref: extraRef, owner: WALLETS[0], tiers: [0, 1, 2, 3, 4, 0] });
    }
    if (w === FIRST + 201) inputs.push({ type: "cancel", owner: WALLETS[0], itemKey: `${extraRef}:3` });
    if (w === FIRST + 400) {
      const slot = state.owners.find((x) => x.owner === WALLETS[1]);
      if (slot?.activeKey) inputs.push({ type: "voidPurchase", ref: slot.activeKey.split(":")[0], owner: WALLETS[1] });
    }
    if (w === FIRST + 590) inputs.push({ type: "freeze", reason: "FREEZE" });
    if (inputs.length > 0) out.windows.push([w, inputs.map(packInput)]);
    const res = engine.runWindow(state, catalog, w, inputs, engine.windowRngFactory(seed, 143, shop, run.roomId, w, ZERO));
    out.ended.push(...res.ended);
    out.spawned.push(...res.spawned.map((s) => ({ window: w, ...s })));
    out.events.push(...res.events);
    out.lastHits.push(...res.lastHits);
    out.jackpots.push(...res.jackpots);
    out.payouts.push(...res.payouts);
    out.sky.push(...res.sky);
    out.voided.push(...res.voided);
    out.buffs.push(...res.buffs);
    for (const b of res.batches) out.batches.push({ batchIndex: b.batchIndex, kinds: sha256(Uint8Array.from(b.kinds)), rowWindows: sha256(Buffer.from(JSON.stringify(b.rowWindows))) });
    if ((w - FIRST) % CHECKPOINT === 0) out.checkpoints.push([w, sha256(engine.serializeRoom(state))]);
  }
  out.batchKindsSoFar = sha256(Uint8Array.from(state.batchKinds));
  out.generatedRowCount = state.generatedRowCount;
  out.tick = state.tick;
  return out;
}

/** 입력 압축: 지갑 주소 → 번호. purchase [0, 지갑, ref, tiers] · cancel [1, 지갑, itemKey] · voidPurchase [2, 지갑, ref] · freeze [3, reason]. */
function packInput(i) {
  switch (i.type) {
    case "purchase": return [0, WALLETS.indexOf(i.owner), i.ref, i.tiers];
    case "cancel": return [1, WALLETS.indexOf(i.owner), i.itemKey];
    case "voidPurchase": return [2, WALLETS.indexOf(i.owner), i.ref];
    case "freeze": return [3, i.reason];
  }
  throw new Error(`packInput: ${i.type}`);
}

/** 판 생성만: 큰 링(줄이 지워지지 않게)에 BOARD_BATCHES 묶음, 줄 y = 윈도 y의 스트림 — test/helpers.ts generateRows와 같은 방식. */
function boardOnly(catalog, seedHex) {
  const width = catalog.world.width;
  const rows = (catalog.limits.batchBlocks / width) * BOARD_BATCHES;
  const seed = hexBytes(seedHex);
  const shop = hexBytes(SHOP);
  const state = { blocks: Array.from({ length: width * rows }, () => ({ kind: 0, x: 0, y: 0, health: 0 })), generatedRowCount: 0, batchIndex: -1, batchRemaining: [], batchKinds: [], batchRowWindows: [] };
  const batches = [];
  for (let y = 0; y < rows; y++) {
    for (const b of engine.generateBlockRows(state, catalog, 1, engine.windowRngFactory(seed, 143, shop, 9, y, ZERO), y)) batches.push(sha256(Uint8Array.from(b.kinds)));
  }
  return { batches, health: sha256(Buffer.from(JSON.stringify(state.blocks.map((b) => b.health)))) };
}

const digest = (list) => ({ count: list.length, sha256: sha256(Buffer.from(JSON.stringify(list))) });

const runs = [];
for (const run of RUNS) {
  const catalog = protocol.parseCatalog(withPatch(oldForm, run.jackpotPatch));
  const a = runOnce(catalog, run);
  const b = runOnce(catalog, run);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${run.name}: not deterministic — two runs of the same seed differ`);
  if (a.buffs.length !== 0) throw new Error(`${run.name}: buffs without catalog.buffs`);
  const board = boardOnly(catalog, run.seed);
  if (JSON.stringify(board) !== JSON.stringify(boardOnly(catalog, run.seed))) throw new Error(`${run.name}: board generation not deterministic`);
  const expect = {
    ended: a.ended,
    lists: Object.fromEntries(["spawned", "events", "lastHits", "jackpots", "payouts", "sky", "voided", "batches"].map((k) => [k, digest(a[k])])),
    checkpoints: a.checkpoints, batchKindsSoFar: a.batchKindsSoFar, generatedRowCount: a.generatedRowCount, tick: a.tick, board,
  };
  runs.push({ name: run.name, seed: run.seed, roomId: run.roomId, chainId: 143, shop: SHOP, firstWindow: FIRST, lastWindow: FIRST + WINDOWS, jackpotPatch: run.jackpotPatch, wallets: WALLETS, inputs: a.windows, expect });
  console.log(`${run.name}: deterministic ✓ — ended ${a.ended.length} · spawned ${a.spawned.length} · POP/BIG ${a.events.length} · LAST HIT ${a.lastHits.length} · jackpots ${a.jackpots.length} · LUCKY PICK ${a.spawned.filter((s) => s.pickLevelBps > 0).length} · payouts ${a.payouts.length} · sky ${a.sky.length} · rows ${a.generatedRowCount} · board batches ${board.batches.length} · end state ${a.checkpoints.at(-1)[1].slice(0, 18)}…`);
}

const fixture = {
  about: "명세 25 §5.3-1 고정 기준 — 5세계 엔진(규칙 11) 빌드로 기록. 손으로 고치지 않는다(test/tools/record-r11-baseline.mjs로 다시 만든다).",
  recordedWith: { commit: "2f401a40", engineVersionHash: engine.engineVersionHash(), stateTag: engine.STATE_ENCODING_TAG, oldCatalogHash: protocol.canonicalHash(oldCatalog) },
  catalog: newForm,
  runs,
};
writeFileSync(resolve(args.out), `${JSON.stringify(fixture)}\n`);
console.log(`wrote ${resolve(args.out)} (${Buffer.byteLength(JSON.stringify(fixture))} bytes)`);
