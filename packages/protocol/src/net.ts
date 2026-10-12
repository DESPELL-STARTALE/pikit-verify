// ──────────────────────────────────────────────────────────────────────────
// 클라이언트 IP → 세는 단위 (api D109 · game-server 좌석 상한, 리뷰 H1). api와 game-server가 같은 함수를 쓴다.
//  - rateLimitKey: 속도·연결 상한의 단위. IPv4 = 주소 하나, IPv6 = /64 하나(집·VPS 하나가 /64를 통째로 받아 주소를 마음대로 바꾼다).
//  - networkOf:    시빌 상한(새 지갑)의 단위. IPv4 = /24, IPv6 = /64.
// IPv4-mapped IPv6(::ffff:1.2.3.4)는 IPv4로 본다. 모르는 모양이면 null. 브라우저 묶음에도 들어가므로 node:net을 쓰지 않는다.
// ──────────────────────────────────────────────────────────────────────────

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const GROUP = /^[0-9a-f]{1,4}$/;

/** IPv6 글자 → 8묶음(16진 숫자). 틀린 모양이면 null. 영역(%en0)은 버린다. */
function v6Groups(v: string): number[] | null {
  const addr = v.split("%")[0]!;
  const parts = addr.split("::");
  if (parts.length > 2) return null;
  const side = (s: string): string[] | null => {
    if (s === "") return [];
    const g = s.split(":");
    const last = g.at(-1)!;
    if (last.includes(".")) {
      if (!V4.test(last)) return null;
      const o = last.split(".").map(Number);
      g.splice(-1, 1, ((o[0]! << 8) | o[1]!).toString(16), ((o[2]! << 8) | o[3]!).toString(16));
    }
    return g.every((x) => GROUP.test(x)) ? g : null;
  };
  const left = side(parts[0]!);
  const right = parts.length === 2 ? side(parts[1]!) : [];
  if (!left || !right) return null;
  const n = left.length + right.length;
  if (parts.length === 2 ? n > 7 : n !== 8) return null;
  return [...left, ...Array<string>(8 - n).fill("0"), ...right].map((g) => parseInt(g, 16));
}

type Parsed = { v4: string } | { v6: number[] };

function parse(ip: string | null): Parsed | null {
  if (!ip) return null;
  const v = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  const v4 = mapped ? mapped[1]! : v;
  if (V4.test(v4)) return { v4 };
  const g = v6Groups(v);
  return g ? { v6: g } : null;
}

const prefix64 = (g: number[]) => `v6:${g.slice(0, 4).map((x) => x.toString(16)).join(":")}`;

/** 시빌 상한 단위 (D109): IPv4 /24 → "v4:1.2.3", IPv6 /64 → "v6:2001:db8:1:2". 모르는 모양이면 null. */
export function networkOf(ip: string | null): string | null {
  const p = parse(ip);
  if (!p) return null;
  return "v4" in p ? `v4:${p.v4.split(".").slice(0, 3).join(".")}` : prefix64(p.v6);
}

/** 속도·연결 상한 단위 (리뷰 H1): IPv4 주소 → "v4:1.2.3.4", IPv6 /64 → "v6:2001:db8:1:2", 모르는 값 → "ip:<그대로>", 없으면 "unknown". */
export function rateLimitKey(ip: string | null): string {
  const p = parse(ip);
  if (p) return "v4" in p ? `v4:${p.v4}` : prefix64(p.v6);
  return ip ? `ip:${ip}` : "unknown";
}
