import type { Hex32 } from "@pikit/protocol";

// ──────────────────────────────────────────────────────────────────────────
// 확정 머리 웹소켓 구독 (spec 06 P0-3, D114). settler(RpcChainSource)와 game-server(RpcChainClock)가 같이 쓴다.
//   구독     eth_subscribe ["monadNewHeads"] — Monad는 블록마다 Proposed → Voted → Finalized(→ Verified) 사건을 따로 보낸다.
//            commitState === "Finalized" 사건만 머리로 받는다(그 블록의 `hash`, `blockId`가 아니다). 나머지 상태는 버린다.
//            그래서 "확정 블록만 본다"(D10)는 그대로다 — 폴링이 eth_getBlockByNumber("finalized")로 읽는 것과 같은 블록이다.
//   끊김     소켓이 닫히거나 오류가 나거나, staleMs 동안 확정 사건이 없으면(조용히 멈춘 노드) 건강하지 않음으로 보고 다시 붙는다
//            (지수 백오프 backoffBaseMs × 2^n, 최대 backoffMaxMs, 지터). 건강하지 않은 동안에는 쓰는 쪽의 폴링이 정상 간격으로 돈다 —
//            이 폴링은 호환 경로가 아니라 장애 대비다(WS는 신호를 빨리 받는 길일 뿐, 진실은 폴링과 같은 RPC다).
//   순서     머리 번호는 쓰는 쪽이 커질 때만 올린다(사건이 겹치거나 순서가 바뀌어도 안전). 여기서는 걸러 주지 않는다.
//   시험     method "newHeads"는 anvil 같은 즉시 확정 개발 체인 시험 전용이다(모든 머리를 확정으로 본다). 설정 값으로 열지 않는다.
// Node 24 내장 WebSocket을 쓴다(의존성 없음).
// ──────────────────────────────────────────────────────────────────────────

export interface FinalizedHead {
  number: number;
  hash: Hex32;
  parentHash: Hex32;
  /** 그 블록의 baseFeePerGas (없으면 null). settler 수수료 추정 캐시에 쓴다. */
  baseFeePerGas: bigint | null;
  /** 사건을 받은 시각 (Date.now()). 지연 계측용. */
  atMs: number;
}

/** 시험·주입용 최소 WebSocket 모양 (Node 내장 WebSocket과 같다). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface FinalizedHeadStreamOptions {
  url: string;
  onHead: (h: FinalizedHead) => void;
  /** 건강 상태가 바뀔 때 (true = 구독 중이고 사건이 오고 있다). */
  onHealth?: (healthy: boolean, reason: string) => void;
  /** 시험 전용: anvil 등 즉시 확정 체인에서 "newHeads"를 확정 머리로 본다. 기본 "monadNewHeads". */
  method?: "monadNewHeads" | "newHeads";
  staleMs?: number;          // 이만큼 확정 사건이 없으면 다시 붙는다, 기본 5,000 (Monad 확정 ≈ 0.3초마다)
  backoffBaseMs?: number;    // 기본 500
  backoffMaxMs?: number;     // 기본 30,000
  socket?: (url: string) => SocketLike;   // 시험·주입용 (기본 Node 내장 WebSocket)
  logger?: { warn(msg: string): void };
}

const hexNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v)) return Number.parseInt(v, 16);
  return null;
};
const hash32 = (v: unknown): Hex32 | null => (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v.toLowerCase() as Hex32) : null);

/** 구독 사건 하나 → 확정 머리 (확정이 아니거나 모양이 틀리면 null). */
export function finalizedHeadOf(result: unknown, method: "monadNewHeads" | "newHeads", atMs: number): FinalizedHead | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (method === "monadNewHeads" && r["commitState"] !== "Finalized") return null;
  const number = hexNum(r["number"]);
  const hash = hash32(r["hash"]);
  const parentHash = hash32(r["parentHash"]);
  if (number === null || hash === null || parentHash === null) return null;
  const fee = r["baseFeePerGas"];
  const baseFeePerGas = typeof fee === "string" && /^0x[0-9a-f]+$/i.test(fee) ? BigInt(fee) : null;
  return { number, hash, parentHash, baseFeePerGas, atMs };
}

export class FinalizedHeadStream {
  private ws: SocketLike | null = null;
  private running = false;
  private isHealthy = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly method: "monadNewHeads" | "newHeads";

  constructor(private readonly o: FinalizedHeadStreamOptions) {
    this.method = o.method ?? "monadNewHeads";
  }

  /** 구독 중이고 staleMs 안에 확정 사건을 받았다. 아니면 쓰는 쪽이 폴링을 정상 간격으로 돌린다. */
  get healthy(): boolean {
    return this.isHealthy;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    this.dropSocket();
    this.setHealth(false, "stopped");
  }

  private connect(): void {
    if (!this.running) return;
    let ws: SocketLike;
    try {
      ws = this.o.socket ? this.o.socket(this.o.url) : (new WebSocket(this.o.url) as unknown as SocketLike);
    } catch (e) {
      this.fail(`connect failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: [this.method] }));
      this.armStale();   // 구독 응답·첫 사건이 staleMs 안에 오지 않으면 다시 붙는다
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m: { id?: unknown; error?: { message?: string }; method?: string; params?: { result?: unknown } };
      try {
        m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as typeof m;
      } catch {
        return;
      }
      if (m.id === 1 && m.error) {
        this.fail(`eth_subscribe ${this.method} refused: ${String(m.error.message ?? "error").slice(0, 200)}`);
        return;
      }
      if (m.method !== "eth_subscription") return;
      const head = finalizedHeadOf(m.params?.result, this.method, Date.now());
      if (!head) return;
      this.attempt = 0;
      this.armStale();
      this.setHealth(true, "finalized head received");
      this.o.onHead(head);
    };
    ws.onerror = () => {
      if (this.ws === ws) this.fail("socket error");
    };
    ws.onclose = () => {
      if (this.ws === ws) this.fail("socket closed");
    };
  }

  /** 끊김·오류·조용함 → 건강하지 않음 + 백오프 뒤 다시 붙기. */
  private fail(reason: string): void {
    this.dropSocket();
    this.clearTimers();
    this.setHealth(false, reason);
    if (!this.running) return;
    const base = this.o.backoffBaseMs ?? 500;
    const cap = this.o.backoffMaxMs ?? 30_000;
    const backoff = Math.min(cap, base * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    const wait = Math.round(backoff / 2 + Math.random() * (backoff / 2));
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
    this.reconnectTimer.unref?.();
  }

  private armStale(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.fail(`no finalized head for ${this.o.staleMs ?? 5000} ms`), this.o.staleMs ?? 5000);
    this.staleTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.reconnectTimer = null;
    this.staleTimer = null;
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch { /* 이미 닫힘 */ }
  }

  private setHealth(healthy: boolean, reason: string): void {
    if (this.isHealthy === healthy) return;
    this.isHealthy = healthy;
    if (!healthy && this.running) this.o.logger?.warn(`[head-stream] websocket unhealthy, polling covers: ${reason}`);
    this.o.onHealth?.(healthy, reason);
  }
}
