// 클라이언트 IP → 세는 단위 (src/net.ts). api(D109 속도·시빌 상한)와 game-server(좌석 상한, 리뷰 H1)가 같은 값을 써야 한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { networkOf, rateLimitKey } from "../src/index.js";

test("networkOf: IPv4 /24, IPv6 /64, mapped IPv4 as IPv4, unknown → null", () => {
  assert.equal(networkOf("203.0.113.7"), "v4:203.0.113");
  assert.equal(networkOf("::ffff:203.0.113.200"), "v4:203.0.113");
  assert.equal(networkOf("2001:db8:1:2::1"), "v6:2001:db8:1:2");
  assert.equal(networkOf("2001:0DB8:0001:0002:ffff:0:0:9"), "v6:2001:db8:1:2");
  assert.equal(networkOf("2001:db8::1"), "v6:2001:db8:0:0");
  assert.equal(networkOf("::1"), "v6:0:0:0:0");
  assert.equal(networkOf("fe80::1%en0"), "v6:fe80:0:0:0");
  assert.equal(networkOf("64:ff9b::192.0.2.33"), "v6:64:ff9b:0:0");
  for (const bad of ["::ffff:1.2.3.4:5", "not-an-ip", "1.2.3.256", "1:2:3:4:5:6:7:8:9", "1::2::3", ":1::", "12345::", ""]) assert.equal(networkOf(bad), null, bad);
  assert.equal(networkOf(null), null);
});

test("rateLimitKey: IPv4 = one address, IPv6 = one /64 (every address of a /64 is the same key)", () => {
  assert.equal(rateLimitKey("203.0.113.7"), "v4:203.0.113.7");
  assert.equal(rateLimitKey("::ffff:203.0.113.7"), "v4:203.0.113.7");
  assert.notEqual(rateLimitKey("203.0.113.7"), rateLimitKey("203.0.113.8"));
  const keys = new Set(Array.from({ length: 2000 }, (_, i) => rateLimitKey(`2001:db8:1:2::${i.toString(16)}`)));
  assert.deepEqual([...keys], ["v6:2001:db8:1:2"]);
  assert.equal(rateLimitKey("2001:db8:1:3::1"), "v6:2001:db8:1:3");
  assert.equal(rateLimitKey("weird"), "ip:weird");
  assert.equal(rateLimitKey(null), "unknown");
});
