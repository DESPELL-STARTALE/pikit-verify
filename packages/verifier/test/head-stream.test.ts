// FinalizedHeadStream(확정 머리 웹소켓 구독, spec 06 P0-3)을 가짜 소켓과 anvil(eth_subscribe newHeads)로 시험한다.
// 가짜 소켓: monadNewHeads의 Proposed·Voted·Finalized 사건 중 Finalized만 머리로, 구독 거절·끊김·조용함이면 건강하지 않음 + 다시 붙기.
// anvil: 실제 웹소켓으로 붙어 머리를 받고, anvil을 죽이면 건강하지 않음, 같은 포트로 다시 띄우면 저절로 다시 붙는다(anvil이 PATH에 없으면 건너뜀).
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { FinalizedHeadStream, finalizedHeadOf, type FinalizedHead, type SocketLike } from "../src/index.js";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const ev = (n: number, commitState: string) => ({ number: `0x${n.toString(16)}`, hash: H(n), parentHash: H(n - 1), commitState, blockId: H(9999), baseFeePerGas: "0x64" });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(10);
  }
}

class FakeSocket implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onerror: SocketLike["onerror"] = null;
  onclose: SocketLike["onclose"] = null;
  sent: string[] = [];
  closed = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.({}); }
  push(result: unknown): void { this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0x1", result } }) }); }
  reply(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

function fakeStream(o: { staleMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const heads: FinalizedHead[] = [];
  const health: boolean[] = [];
  const s = new FinalizedHeadStream({
    url: "wss://fake", onHead: (h) => heads.push(h), onHealth: (ok) => health.push(ok), backoffBaseMs: 5, backoffMaxMs: 20, staleMs: o.staleMs ?? 5000,
    socket: () => { const x = new FakeSocket(); sockets.push(x); return x; },
  });
  return { s, sockets, heads, health };
}

describe("finalizedHeadOf", () => {
  it("monadNewHeads: Finalized only, hash (not blockId), hex numbers", () => {
    assert.equal(finalizedHeadOf(ev(10, "Proposed"), "monadNewHeads", 1), null);
    assert.equal(finalizedHeadOf(ev(10, "Voted"), "monadNewHeads", 1), null);
    assert.equal(finalizedHeadOf(ev(10, "Verified"), "monadNewHeads", 1), null);
    const h = finalizedHeadOf(ev(10, "Finalized"), "monadNewHeads", 7)!;
    assert.deepEqual(h, { number: 10, hash: H(10), parentHash: H(9), baseFeePerGas: 100n, atMs: 7 });
    assert.equal(finalizedHeadOf({ ...ev(10, "Finalized"), hash: "0x12" }, "monadNewHeads", 1), null);
  });
  it("newHeads (test only): every head counts", () => {
    assert.equal(finalizedHeadOf({ number: "0x5", hash: H(5), parentHash: H(4) }, "newHeads", 1)?.number, 5);
  });
});

describe("FinalizedHeadStream (fake socket)", () => {
  it("subscribes monadNewHeads and forwards only Finalized heads; healthy on the first one", () => {
    const { s, sockets, heads, health } = fakeStream();
    s.start();
    const ws = sockets[0]!;
    ws.open();
    assert.deepEqual(JSON.parse(ws.sent[0]!), { jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["monadNewHeads"] });
    ws.reply({ jsonrpc: "2.0", id: 1, result: "0x1" });
    ws.push(ev(11, "Proposed"));
    ws.push(ev(10, "Voted"));
    assert.equal(s.healthy, false);
    ws.push(ev(9, "Finalized"));
    ws.push(ev(10, "Finalized"));
    ws.push(ev(9, "Finalized"));   // 겹침 — 거르는 것은 쓰는 쪽(번호가 커질 때만)
    assert.deepEqual(heads.map((h) => h.number), [9, 10, 9]);
    assert.equal(s.healthy, true);
    assert.deepEqual(health, [true]);
    s.stop();
    assert.equal(ws.closed, true);
  });

  it("socket close → unhealthy, reconnects with backoff and resubscribes", async () => {
    const { s, sockets, heads } = fakeStream();
    s.start();
    sockets[0]!.open();
    sockets[0]!.push(ev(5, "Finalized"));
    assert.equal(s.healthy, true);
    sockets[0]!.onclose?.({});
    assert.equal(s.healthy, false);
    await until(() => sockets.length === 2);
    sockets[1]!.open();
    assert.equal(JSON.parse(sockets[1]!.sent[0]!).method, "eth_subscribe");
    sockets[1]!.push(ev(6, "Finalized"));
    assert.equal(s.healthy, true);
    assert.deepEqual(heads.map((h) => h.number), [5, 6]);
    s.stop();
  });

  it("subscription refused (e.g. method not found) → unhealthy and retried", async () => {
    const { s, sockets } = fakeStream();
    s.start();
    sockets[0]!.open();
    sockets[0]!.reply({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
    assert.equal(s.healthy, false);
    assert.equal(sockets[0]!.closed, true);
    await until(() => sockets.length >= 2);
    s.stop();
  });

  it("quiet socket (no Finalized for staleMs) → unhealthy and reconnect", async () => {
    const { s, sockets, health } = fakeStream({ staleMs: 40 });
    s.start();
    sockets[0]!.open();
    sockets[0]!.push(ev(1, "Finalized"));
    assert.equal(s.healthy, true);
    await until(() => sockets.length >= 2);
    assert.equal(s.healthy, false);
    assert.deepEqual(health, [true, false]);
    s.stop();
  });
});

// ── anvil (실제 웹소켓) ──
const hasAnvil = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startAnvil(port: number): Promise<ChildProcess> {
  const p = spawn("anvil", ["--port", String(port), "--block-time", "1", "--silent"], { stdio: "ignore" });
  const end = Date.now() + 10_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
      if (r.ok) return p;
    } catch { /* 아직 */ }
    if (Date.now() > end) throw new Error("anvil did not start");
    await wait(100);
  }
}

async function stopAnvil(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null) return;
  const done = new Promise((r) => p.once("exit", r));
  p.kill("SIGKILL");
  await done;
}

describe("FinalizedHeadStream (anvil eth_subscribe newHeads)", { skip: hasAnvil ? false : "anvil not on PATH" }, () => {
  it("receives heads, goes unhealthy when the node dies, resubscribes when it comes back", async () => {
    const port = await freePort();
    let anvil = await startAnvil(port);
    const heads: FinalizedHead[] = [];
    const s = new FinalizedHeadStream({ url: `ws://127.0.0.1:${port}`, method: "newHeads", onHead: (h) => heads.push(h), backoffBaseMs: 100, backoffMaxMs: 400, staleMs: 3000 });
    try {
      s.start();
      await until(() => heads.length >= 2, 8000);
      assert.equal(s.healthy, true);
      assert.ok(heads[1]!.number > heads[0]!.number);
      assert.equal(heads[1]!.parentHash, heads[0]!.hash);   // 1블록씩 오른다 → parentHash = 앞 머리
      await stopAnvil(anvil);
      await until(() => !s.healthy, 5000);
      const before = heads.length;
      anvil = await startAnvil(port);
      await until(() => heads.length > before && s.healthy, 10_000);
    } finally {
      s.stop();
      await stopAnvil(anvil);
    }
  });
});
