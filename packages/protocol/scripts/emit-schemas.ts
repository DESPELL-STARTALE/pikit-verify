// zod 스키마에서 JSON Schema 파일(schemas/*.schema.json)을 만든다. 다른 언어(Solidity 도구, 감시 봇)가 같은 형식을 쓰게 하기 위함.
// 주의: superRefine/refine으로 건 교차 검사(예: 묶음 개수 합)는 JSON Schema에 담기지 않는다 — 최종 검증은 parse*() 함수가 한다.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AnchorRecord, BatchView, BoardBatchCommitment, CancelIntentMessage, CancelRequest, CancelRequestedEvent, CatalogSchema, ChainSnapshot,
  CreditIntentMessage, CreditPurchaseRequest, DailyClaimRequest, DailyCreditsView, EngineInput, EpochAnchor, EpochInputLog, ExceptionRecord, FeedEvent, HistoryItem, InputLog,
  IntentUsedEvent, JoinOptions, LivenessSignal, MeView, Payout, PickaxeEndMsg, PickaxeHistoryRecord, PickaxeLiveState, PickaxeSettledMsg,
  PurchaseReceiptMsg, PurchasedEvent, QueueState, RefundRecord, RefundedEvent, RelayView, SeedChainCommitment, SessionGrantMessage,
  SettledEvent, SettlementRecord, SystemNotice, TicketsView, TodayStatsView, WorldManifest,
} from "../src/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(packageRoot, "schemas");
mkdirSync(outDir, { recursive: true });

const schemas: Record<string, z.ZodType> = {
  catalog: CatalogSchema,
  "purchased-event": PurchasedEvent,
  "intent-used-event": IntentUsedEvent,
  "cancel-requested-event": CancelRequestedEvent,
  "settled-event": SettledEvent,
  "refunded-event": RefundedEvent,
  payout: Payout,
  "seed-chain-commitment": SeedChainCommitment,
  "epoch-anchor": EpochAnchor,
  "board-batch-commitment": BoardBatchCommitment,
  "pickaxe-history-record": PickaxeHistoryRecord,
  "exception-record": ExceptionRecord,
  "refund-record": RefundRecord,
  "input-log": InputLog,
  "feed-event": FeedEvent,
  "queue-state": QueueState,
  "pickaxe-live-state": PickaxeLiveState,
  "liveness-signal": LivenessSignal,
  "engine-input": EngineInput,
  "epoch-input-log": EpochInputLog,
  "world-manifest": WorldManifest,
  "chain-snapshot": ChainSnapshot,
  "anchor-record": AnchorRecord,
  "settlement-record": SettlementRecord,
  "join-options": JoinOptions,
  "purchase-receipt": PurchaseReceiptMsg,
  "pickaxe-end": PickaxeEndMsg,
  "pickaxe-settled": PickaxeSettledMsg,
  "system-notice": SystemNotice,
  "history-item": HistoryItem,
  "me-view": MeView,
  "batch-view": BatchView,
  "credit-purchase-request": CreditPurchaseRequest,
  "cancel-request": CancelRequest,
  "relay-view": RelayView,
  "daily-credits-view": DailyCreditsView,
  "daily-claim-request": DailyClaimRequest,
  "tickets-view": TicketsView,
  "today-stats-view": TodayStatsView,
  "eip712-credit-intent": CreditIntentMessage,
  "eip712-cancel-intent": CancelIntentMessage,
  "eip712-session-grant": SessionGrantMessage,
};

for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" });
  writeFileSync(join(outDir, `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
}
console.log(`emit-schemas: wrote ${Object.keys(schemas).length} files to schemas/`);
