// zod 스키마에서 JSON Schema 파일(schemas/*.schema.json)을 만든다. 다른 언어(Solidity 도구, 감시 봇)가 같은 형식을 쓰게 하기 위함.
// 주의: superRefine/refine으로 건 교차 검사(예: 묶음 개수 합)는 JSON Schema에 담기지 않는다 — 최종 검증은 parse*() 함수가 한다.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BatchView, CatalogSchema,
  DailyClaimRequest, DailyCreditsView, EngineInput, EpochInputLog, ExceptionRecord, FeedEvent, HistoryItem, InputLog,
  JackpotView, JoinOptions, LivenessSignal, MeView, PickaxeEndMsg, PickaxeHistoryRecord, PickaxeLiveState, PickaxeSettledMsg,
  PurchaseReceiptMsg, QueueState,
  SystemNotice, TicketsView, TodayStatsView, WorldManifest, CreditsPolicyView,
  BuyIntentMessage, CancelQueueMessage, GrantMessage, IntentRequest, IntentResultMsg, IntentView, LedgerEpochFile, LedgerLeaf,
  ChatHistoryMsg, ChatMsg, ChatRejectedMsg, ChatSend,
  LedgerLeavesFile, LedgerRootRecord, LedgerSessionMessage, ListMsg, PayoutLeaf, RootView, LatestRootView, SignedWindowList, WindowListMessage,
} from "../src/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(packageRoot, "schemas");
mkdirSync(outDir, { recursive: true });

const schemas: Record<string, z.ZodType> = {
  catalog: CatalogSchema,
  "pickaxe-history-record": PickaxeHistoryRecord,
  "exception-record": ExceptionRecord,
  "input-log": InputLog,
  "feed-event": FeedEvent,
  "queue-state": QueueState,
  "pickaxe-live-state": PickaxeLiveState,
  "liveness-signal": LivenessSignal,
  "engine-input": EngineInput,
  "epoch-input-log": EpochInputLog,
  "world-manifest": WorldManifest,
  "join-options": JoinOptions,
  "purchase-receipt": PurchaseReceiptMsg,
  "pickaxe-end": PickaxeEndMsg,
  "pickaxe-settled": PickaxeSettledMsg,
  "system-notice": SystemNotice,
  "history-item": HistoryItem,
  "me-view": MeView,
  "batch-view": BatchView,
  "daily-credits-view": DailyCreditsView,
  "daily-claim-request": DailyClaimRequest,
  "tickets-view": TicketsView,
  "today-stats-view": TodayStatsView,
  "credits-policy-view": CreditsPolicyView,
  "jackpot-view": JackpotView,   // 규칙 10 (명세 23 §4)
  // 명세 20 장부 (D196)
  "eip712-buy-intent": BuyIntentMessage,
  "eip712-cancel-queue": CancelQueueMessage,
  "eip712-ledger-session": LedgerSessionMessage,
  "eip712-window-list": WindowListMessage,
  "ledger-grant": GrantMessage,
  "ledger-leaf": LedgerLeaf,
  "ledger-payout-leaf": PayoutLeaf,
  "ledger-root-record": LedgerRootRecord,
  "signed-window-list": SignedWindowList,
  "ledger-epoch-file": LedgerEpochFile,
  "ledger-leaves-file": LedgerLeavesFile,
  "intent-request": IntentRequest,
  "intent-view": IntentView,
  "root-view": RootView,
  "latest-root-view": LatestRootView,
  "list-msg": ListMsg,
  "intent-result": IntentResultMsg,
  // 방 채팅 (D212)
  "chat-send": ChatSend,
  "chat-msg": ChatMsg,
  "chat-history": ChatHistoryMsg,
  "chat-rejected": ChatRejectedMsg,
};

for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" });
  writeFileSync(join(outDir, `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
}
console.log(`emit-schemas: wrote ${Object.keys(schemas).length} files to schemas/`);
