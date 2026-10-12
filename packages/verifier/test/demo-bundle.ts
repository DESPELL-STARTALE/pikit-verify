// 데모 검증 묶음: 방 2개, 에폭 7개(1,400윈도). 체인 구매(purchaseId 순서), 취소, 대기열 넘침, 무효 구간(PurchasesVoided),
// 끝난 블록 묶음, 매 에폭 앵커, 앵커 뒤 settler 정산(Settled, 마지막 에폭은 일부만 → unsettled 경고)을 모두 담는다.
// 입력은 모두 체인 사건으로만 넣는다(D111): 블록 b의 사건 → 윈도 b + 1 (WorldProducer가 연결 규칙대로).
// 무효가 되기 전에 정상 종료해 over > 0인 곡괭이(F, 방 1)도 있다 — settler는 그 over를 payOverAfterVoid(VoidOverPaid)로 준다(개정 6).
// 에폭마다 끝 세계 스냅숏(epochs/snapshots/<e>.json, game-server와 같은 모양)도 쓴다 — 스냅숏 시작(--from-snapshot) 시험용.
// 테스트와 verifier-cli 테스트가 함께 쓴다: `node dist/test/demo-bundle.js <outDir> [cheat]`로 파일을 쓴다.
// 입력 속임(delay|retier|dropcancel|extra): "운영자가 체인과 다르게 넣은" 묶음 — 세계·입력 기록·앵커·정산은 서로 맞고(운영자가 일관되게 속임)
// 체인 값만 진짜 사건 그대로라, 검증기의 "입력 = 체인 사건" 검사만 실패해야 한다(H-1 ①②③ + 지어낸 입력).
// 지급 속임(위조 기록, 감사 F-1 ②): 재생·앵커는 정직하고 체인의 지급 기록만 틀렸다 — 정산 검사(또는 파일 검사)만 실패해야 한다.
//   이때 settler는 마지막까지 모두 보냈고 체인 값은 마지막 윈도 + SETTLE_STALL + 1블록까지 읽은 것으로 한다(시한이 지난 상태).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash, keccak256, parseCatalog, SeedChain, SETTLE_STALL, type Catalog, type Hex32 } from "@pikit/protocol";
import { WorldProducer, type LinkedInput } from "../src/index.js";

export const SHOP = "0x5b0b000000000000000000000000000000000005";
export const CHAIN_ID = 143;
export const W0 = 1000;
export const EPOCHS = 7;
export const A = "0xa11ce00000000000000000000000000000000001";
export const B = "0xb0b0000000000000000000000000000000000002";
export const D = "0xd1ce000000000000000000000000000000000003";
export const E = "0xe1e1000000000000000000000000000000000004";
/** 마지막 에폭에서 settler가 보내는 정산 수 (나머지는 unsettled 경고로 남는다). */
export const LAST_EPOCH_SETTLE_LIMIT = 3;

export function loadNormal(): Catalog {
  return parseCatalog(JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@pikit/protocol/catalogs/normal.json")), "utf8")));
}

/** 묶음이 빨리 끝나도록 묶음 크기만 400칸(40줄)으로 줄인 시험용 카탈로그 (방 2). */
export function smallBatchCatalog(): Catalog {
  const c = structuredClone(loadNormal());
  c.limits.batchBlocks = 400;
  const counts = [136, 90, 60, 40, 27, 18, 12, 8, 5, 4];
  c.blocks.forEach((b, i) => { b.batchCount = counts[i]!; });
  return parseCatalog(c);
}

export interface DemoBundle {
  world: unknown;
  chain: unknown;
  catalogs: Map<string, unknown>;
  epochs: (unknown | null)[];      // null = 공개되지 않은 파일 (missingfile)
  snapshots: unknown[];            // snapshots[e − 1] = 에폭 e 끝 세계 스냅숏
  voidPurchaseId: string;          // 무효 구간으로 지워지는 구매의 purchaseId (방 2, 에폭 3)
  voidOverPurchaseId: string;      // 무효 전에 정상 종료(over > 0)한 구매 (방 1, 에폭 4)
  forgedKey: string | null;        // 지급 속임이 건드린 곡괭이
}

/**
 * 운영자가 체인과 다르게 넣는 방법 (보안 리뷰 H-1):
 *   delay      A의 첫 구매(블록 W0, 윈도 W0 + 1)를 한 윈도 늦게(W0 + 2) 넣는다  → WINDOW (①)
 *   retier     B의 첫 구매(×1 [0])를 ×20 [4]로 바꿔 넣는다                      → FIELDS (②)
 *   dropcancel A의 취소(블록 W0 + 1)를 빼먹는다                                  → MISSING (③)
 *   extra      체인에 없는 구매를 지어내 넣는다                                   → EXTRA
 */
export type InputCheat = "delay" | "retier" | "dropcancel" | "extra";
/**
 * 지급 속임 (감사 F-1 ②, 위조 기록 — 하나마다 실패 하나):
 *   nosettle    over > 0인 정상 종료 하나의 settleEnd를 빼먹었고 시한이 지났다         → OVERDUE
 *   overzero    over > 0인 정상 종료 하나를 over 0으로 보냈다                          → AMOUNT
 *   voidover    무효가 된 구매의 정상 종료 over를 payOverAfterVoid로 주지 않았다        → VOID_OVER
 *   missingfile 에폭 파일 4.json을 공개하지 않았다                                      → 파일 검사 실패
 */
export type PayoutCheat = "nosettle" | "overzero" | "voidover" | "missingfile";
export type Cheat = InputCheat | PayoutCheat;
export const INPUT_CHEATS: readonly InputCheat[] = ["delay", "retier", "dropcancel", "extra"];
export const PAYOUT_CHEATS: readonly PayoutCheat[] = ["nosettle", "overzero", "voidover", "missingfile"];
export const CHEATS: readonly Cheat[] = [...INPUT_CHEATS, ...PAYOUT_CHEATS];
/** 데모의 다섯 번째 사람: 무효가 될 구매(방 1, 에폭 4)를 사서 무효 전에 정상 종료(over > 0)한다. */
export const F = "0xf00f000000000000000000000000000000000007";

/** 체인 사건 계획 줄 (블록 block에 실린 사건 → 윈도 block + 1). label로 뒤 사건이 그 구매 번호를 가리킨다. */
type PlanEvent =
  | { block: number; roomId: number; kind: "purchase"; owner: string; tiers: number[]; label?: string }
  | { block: number; roomId: number; kind: "cancel"; owner: string; label: string; item: number }
  | { block: number; kind: "void"; label: string };

/** 운영자의 속임 (producer tamper): 연결 규칙이 정한 윈도 입력을 바꾼다. 연결(link)은 진짜 체인 자리 그대로 둔다. */
function cheater(cheat: InputCheat): (window: number, inputs: Map<number, LinkedInput[]>) => Map<number, LinkedInput[]> {
  let stash: LinkedInput | null = null;
  return (w, inputs) => {
    const room1 = inputs.get(1) ?? [];
    if (cheat === "delay") {
      if (w === W0 + 1) {
        stash = room1.find((x) => x.input.type === "purchase" && x.input.ref === "0") ?? null;
        inputs.set(1, room1.filter((x) => x !== stash));
      } else if (w === W0 + 2 && stash) {
        inputs.set(1, [stash, ...room1]);
        stash = null;
      }
    }
    if (cheat === "retier" && w === W0 + 5) {
      inputs.set(1, room1.map((x) => (x.input.type === "purchase" && x.input.owner === B ? { ...x, input: { ...x.input, tiers: [4] } } : x)));
    }
    if (cheat === "dropcancel" && w === W0 + 2) inputs.set(1, room1.filter((x) => x.input.type !== "cancel"));
    if (cheat === "extra" && w === W0 + 301) {
      const fake: LinkedInput = {
        roomId: 1, input: { type: "purchase", ref: "424242", owner: E, tiers: [2] },
        link: { block: W0 + 300, logIndex: 9, pos: 0, txHash: keccak256(new TextEncoder().encode("never-on-chain")) as Hex32 },
      };
      inputs.set(1, [...room1, fake]);
    }
    return inputs;
  };
}

/** voidOverBlock: "voidover" 구매를 무효로 하는 PurchasesVoided의 블록 (기본 W0 + 760, 같은 에폭). 에폭 4 끝(W0 + 799) 뒤로 옮기면
 *  "범위 끝 뒤에 실린 무효"(장애 뒤 늦은 앵커, 리뷰 rev6 I-1)를 --epoch 4로 흉내 낸다 — settler는 그 무효까지 멈춰 있다가 over를
 *  VoidOverPaid로 준다(정직한 세계). */
export function buildDemoBundle(cheat?: Cheat, epochs = EPOCHS, o: { voidOverBlock?: number } = {}): DemoBundle {
  const inputCheat = cheat && (INPUT_CHEATS as readonly string[]).includes(cheat) ? (cheat as InputCheat) : undefined;
  const payoutCheat = cheat && (PAYOUT_CHEATS as readonly string[]).includes(cheat) ? (cheat as PayoutCheat) : undefined;
  const normal = loadNormal();
  const small = smallBatchCatalog();
  const seeds = new SeedChain(keccak256(new TextEncoder().encode("pikit-demo-seed-top")), Math.max(64, epochs), 8);
  const producer = new WorldProducer({
    chainId: CHAIN_ID, shop: SHOP, genesisBlock: W0, seeds,
    rooms: [{ roomId: 1, createdWindow: W0, catalog: normal }, { roomId: 2, createdWindow: W0 + 50, catalog: small }],
    blockHash: (w) => keccak256(new TextEncoder().encode(`block-${w}`)),
    ...(inputCheat ? { tamper: cheater(inputCheat) } : {}),
  });

  const events: PlanEvent[] = [
    { block: W0, roomId: 1, kind: "purchase", owner: A, tiers: [0, 0, 4], label: "a1" },
    { block: W0 + 1, roomId: 1, kind: "cancel", owner: A, label: "a1", item: 2 },                    // REFUND CANCEL (×20)
    { block: W0 + 4, roomId: 1, kind: "purchase", owner: B, tiers: [0] },
    { block: W0 + 59, roomId: 2, kind: "purchase", owner: A, tiers: [1] },
    { block: W0 + 60, roomId: 2, kind: "purchase", owner: A, tiers: [4] },
    { block: W0 + 62, roomId: 2, kind: "purchase", owner: E, tiers: Array.from({ length: 9 }, () => 0) },
    { block: W0 + 62, roomId: 2, kind: "purchase", owner: E, tiers: [1, 1] },             // 두 번째 항목은 대기열 넘침 → REFUND OVERFLOW
    { block: W0 + 449, roomId: 2, kind: "purchase", owner: A, tiers: [0, 0], label: "void" },
    { block: W0 + 454, kind: "void", label: "void" },                                                // PurchasesVoided [void, void + 1): 정산 없음
    { block: W0 + 631, roomId: 1, kind: "purchase", owner: F, tiers: [2], label: "voidover" },             // 윈도 W0 + 670에 정상 종료(over > 0)
    { block: o.voidOverBlock ?? W0 + 760, kind: "void", label: "voidover" },                                            // 그 뒤 무효 → settler가 payOverAfterVoid
    { block: W0 + 1289, roomId: 1, kind: "purchase", owner: B, tiers: [4, 4] },
  ];
  for (let w = W0 + 70; w < W0 + epochs * 200; w += 5) events.push({ block: w - 1, roomId: 2, kind: "purchase", owner: D, tiers: [4, 4] });
  events.sort((x, y) => x.block - y.block);   // 안정 정렬: 같은 블록은 적은 순서 (= 로그 순서)
  const byBlock = new Map<number, PlanEvent[]>();
  for (const ev of events) byBlock.set(ev.block, [...(byBlock.get(ev.block) ?? []), ev]);

  const ids = new Map<string, string>();
  const snapshots: unknown[] = [];
  let forgedKey: string | null = null;
  // 지급 속임의 대상: over > 0인 정상 종료 중 첫 것(무효 구매 제외), voidover는 무효 구매의 그것
  const target = (p: { key: string; purchaseId: string; overMilli: number }) => {
    if (forgedKey !== null) return p.key === forgedKey;
    const hit = p.overMilli > 0 && (payoutCheat === "voidover" ? p.purchaseId === ids.get("voidover") : (payoutCheat === "nosettle" || payoutCheat === "overzero") && p.purchaseId !== ids.get("voidover"));
    if (hit) forgedKey = p.key;
    return hit;
  };
  const skip = (p: { key: string; purchaseId: string; overMilli: number }) => (payoutCheat === "nosettle" || payoutCheat === "voidover") && target(p);
  for (let w = W0; w < W0 + epochs * 200; w++) {
    for (const ev of byBlock.get(w - 1) ?? []) {   // 블록 w − 1의 사건은 윈도 w를 돌리기 전에 체인에 적는다
      if (ev.kind === "purchase") {
        const ref = producer.purchase({ block: ev.block, roomId: ev.roomId, buyer: ev.owner, tiers: ev.tiers });
        if (ev.label) ids.set(ev.label, ref);
      } else if (ev.kind === "cancel") {
        producer.cancel({ block: ev.block, roomId: ev.roomId, wallet: ev.owner, items: [`${ids.get(ev.label)!}:${ev.item}`] });
      } else {
        const id = ids.get(ev.label)!;
        producer.voidRange({ block: ev.block, fromId: id, toId: String(BigInt(id) + 1n) });
      }
    }
    producer.step();
    if ((w - W0 + 1) % 200 === 0) {
      const e = (w - W0 + 1) / 200;
      snapshots.push(producer.snapshotFile());
      producer.anchor(w + 30);
      // 앵커가 덮은 구매만 (마지막은 일부만 — settler 지연. 지급 속임 묶음은 마지막까지 모두 보낸다)
      // voidOverBlock 변형: settler가 그 무효 전까지 멈춰 있었다(장애) — 그 곡괭이는 무효 뒤 VoidOverPaid로만 갈 수 있다
      const outage = (p: { purchaseId: string }) => o.voidOverBlock !== undefined && p.purchaseId === ids.get("voidover") && w <= o.voidOverBlock;
      producer.settle(w + 40, e === epochs && !payoutCheat ? LAST_EPOCH_SETTLE_LIMIT : Number.POSITIVE_INFINITY, (p) => skip(p) || outage(p));
    }
  }
  const catalogs = new Map<string, unknown>([[canonicalHash(normal), normal], [canonicalHash(small), small]]);
  const chain = producer.chainFacts();
  if (payoutCheat === "overzero") {
    const s = chain.settlements.find((x) => target({ key: `${x.purchaseId}:${x.itemIndex}`, purchaseId: x.purchaseId, overMilli: Number(x.overMilli) }));
    if (!s) throw new Error("demo: no settlement with over > 0 to forge");
    s.overMilli = "0";
  }
  if (payoutCheat) chain.throughBlock = W0 + epochs * 200 - 1 + SETTLE_STALL + 1;   // 시한이 지난 뒤에 읽은 체인
  if (payoutCheat && payoutCheat !== "missingfile" && forgedKey === null) throw new Error(`demo: cheat ${payoutCheat} found nothing to forge`);
  const logs: (unknown | null)[] = producer.epochLogs();
  if (payoutCheat === "missingfile") logs[3] = null;
  return {
    world: producer.manifest(), chain, catalogs, epochs: logs, snapshots, voidPurchaseId: ids.get("void")!, voidOverPurchaseId: ids.get("voidover")!, forgedKey,
  };
}

/** 묶음을 디렉터리에 쓴다: world.json, chain.json, catalogs/<catalogHash>.json, epochs/<e>.json, epochs/snapshots/<e>.json (null 파일은 쓰지 않는다) */
export function writeBundle(dir: string, b: DemoBundle): void {
  mkdirSync(join(dir, "catalogs"), { recursive: true });
  mkdirSync(join(dir, "epochs", "snapshots"), { recursive: true });
  const w = (p: string, v: unknown) => writeFileSync(join(dir, p), `${JSON.stringify(v, null, 2)}\n`);
  w("world.json", b.world);
  w("chain.json", b.chain);
  for (const [h, c] of b.catalogs) w(`catalogs/${h}.json`, c);
  b.epochs.forEach((e, i) => { if (e !== null) w(`epochs/${i + 1}.json`, e); });
  b.snapshots.forEach((s, i) => writeFileSync(join(dir, "epochs", "snapshots", `${i + 1}.json`), JSON.stringify(s)));
}

export type { Hex32 };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  const cheat = (process.argv[3] || undefined) as Cheat | undefined;
  const epochs = process.argv[4] ? Number(process.argv[4]) : EPOCHS;
  if (!out || (cheat !== undefined && !CHEATS.includes(cheat)) || !Number.isInteger(epochs) || epochs < 1) {
    throw new Error(`usage: node demo-bundle.js <outDir> [${CHEATS.join("|")}|""] [epochs]`);
  }
  writeBundle(out, buildDemoBundle(cheat, epochs));
  console.log(`demo bundle${cheat ? ` (operator cheat: ${cheat})` : ""} written to ${out}`);
}
