// 자동 생성 — packages/verifier/scripts/emit-ledger-info.mjs (손으로 고치지 않는다). 장부 규칙(src/ledger/rules/**)이나 덮는 protocol 파일이 바뀌면 build가 다시 쓴다.
// LEDGER_VERSION_HASH = PikitLedger 생성자 불변값 ledgerHash (D192·D199).
export const LEDGER_VERSION = "0.0.0";
export const LEDGER_SOURCE_HASH = "0x211cec66d381e4a795d3750442124a3fe7d01eede5afa8d384f8925566fb4cce";
export const LEDGER_VERSION_HASH = "0xe219e71372f79bd55a2e679283176c5bd7c2ed49c58f35b922b381102808a4aa";
/** 해시가 덮는 파일 (packages/ 기준, 경로 순). */
export const LEDGER_HASHED_FILES: readonly string[] = ["protocol/src/canonical.ts","protocol/src/crypto.ts","protocol/src/input-log.ts","protocol/src/ledger.ts","protocol/src/primitives.ts","verifier/src/ledger/rules/apply.ts","verifier/src/ledger/rules/auth.ts","verifier/src/ledger/rules/context.ts","verifier/src/ledger/rules/index.ts","verifier/src/ledger/rules/link.ts","verifier/src/ledger/rules/list.ts","verifier/src/ledger/rules/root.ts","verifier/src/ledger/rules/state.ts","verifier/src/ledger/rules/window.ts"];
