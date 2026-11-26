// 払戻の計算(画面 public/payout.js の computeTicketPayout と、サーバー _lib/ticket-payout.js の computeSettledPayout)。
// 2つは同じ規則で書かれている(どちらかだけ直すとずれる)ので、同じ例で両方の答えが合うことも確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";
import { computeSettledPayout, addResultRefunds } from "../functions/api/_lib/ticket-payout.js";

const { computeTicketPayout } = loadClassic(["public/bettypes.js", "public/payout.js"], ["computeTicketPayout"]);

const sel = (...nums) => nums.map((horse_number) => ({ horse_number }));
const selWaku = (...nums) => nums.map((waku_number) => ({ waku_number }));

// 1着 9番、2着 2番・4番の同着(10/26 大井11R のような形)
const PAYOUTS = {
  tan: [{ combo: [9], rate: 350 }],
  fuku: [{ combo: [9], rate: 150 }, { combo: [2], rate: 200 }, { combo: [4], rate: 300 }],
  umaren: [{ combo: [2, 9], rate: 1200 }, { combo: [4, 9], rate: 1500 }],
  wide: [{ combo: [2, 4], rate: 800 }, { combo: [2, 9], rate: 400 }, { combo: [4, 9], rate: 500 }],
  umatan: [{ combo: [9, 2], rate: 2500 }, { combo: [9, 4], rate: 3000 }],
  sanrenpuku: [{ combo: [2, 4, 9], rate: 4000 }],
  sanrentan: [{ combo: [9, 2, 4], rate: 20000 }, { combo: [9, 4, 2], rate: 22000 }],
  wakuren: [{ combo: [2, 5], rate: 900 }],
};
const FINISH = [9, 2, 4];

// [名前, 券種, 買い目, 金額, 払戻の表, 期待する払戻(null = 未確定)]
const CASES = [
  ["単勝の的中", "tan", sel(9), 100, PAYOUTS, 350],
  ["単勝の外れ", "tan", sel(3), 100, PAYOUTS, 0],
  ["複勝の的中は金額に比例(200円)", "fuku", sel(4), 200, PAYOUTS, 600],
  ["馬連は買った順によらない", "umaren", sel(9, 2), 100, PAYOUTS, 1200],
  ["同着でもう一方の馬連も当たる", "umaren", sel(4, 9), 100, PAYOUTS, 1500],
  ["ワイドの同着の組", "wide", sel(4, 2), 100, PAYOUTS, 800],
  ["馬単は順が逆なら外れ", "umatan", sel(2, 9), 100, PAYOUTS, 0],
  ["馬単の的中", "umatan", sel(9, 4), 100, PAYOUTS, 3000],
  ["3連複は順によらない", "sanrenpuku", sel(9, 4, 2), 100, PAYOUTS, 4000],
  ["3連単の同着の組(9-4-2)", "sanrentan", sel(9, 4, 2), 100, PAYOUTS, 22000],
  ["3連単の外れ", "sanrentan", sel(2, 9, 4), 100, PAYOUTS, 0],
  ["枠連は枠番で探す", "wakuren", selWaku(5, 2), 100, PAYOUTS, 900],
  ["枠番が未確定なら未確定", "wakuren", [{ waku_number: null }, { waku_number: 2 }], 100, PAYOUTS, null],
  ["その券種の払戻が無ければ未確定", "tan", sel(9), 100, { umaren: PAYOUTS.umaren }, null],
  ["払戻が無ければ未確定", "tan", sel(9), 100, null, null],
  ["端数は四捨五入(50円×350)", "tan", sel(9), 50, PAYOUTS, 175],
];

for (const [name, betType, selections, amount, payouts, expected] of CASES) {
  test(`払戻: ${name}`, () => {
    const server = computeSettledPayout(betType, selections, amount, FINISH, payouts, []);
    assert.equal(server.payout, expected, "サーバー");
    assert.equal(server.refunded, 0);
    const client = computeTicketPayout({ bet_type: betType, selections, amount }, { payouts, finish_order: FINISH });
    assert.equal(client, expected, "画面");
  });
}

test("返還: 取消の馬を含む買い目は購入額を返す(当たりの組でも返還)", () => {
  const payouts = { ...PAYOUTS, refunds: [{ horse_numbers: [9], waku_numbers: [] }] };
  assert.deepEqual(computeSettledPayout("umaren", sel(2, 9), 300, FINISH, payouts, []), { payout: 300, refunded: 1 });
  // 含まない買い目は普通に判定
  assert.deepEqual(computeSettledPayout("wide", sel(2, 4), 100, FINISH, payouts, []), { payout: 800, refunded: 0 });
});

test("返還: 枠連は返還の枠だけを見る(馬番の返還では返さない)", () => {
  const byHorse = { ...PAYOUTS, refunds: [{ horse_numbers: [3], waku_numbers: [] }] };
  assert.equal(computeSettledPayout("wakuren", selWaku(2, 5), 100, FINISH, byHorse, []).refunded, 0);
  const byWaku = { ...PAYOUTS, refunds: [{ horse_numbers: [3], waku_numbers: [2] }] };
  assert.deepEqual(computeSettledPayout("wakuren", selWaku(2, 5), 100, FINISH, byWaku, []), { payout: 100, refunded: 1 });
});

test("返還: レースの取りやめは券種によらず全部返す", () => {
  const payouts = { race_cancelled: true };
  assert.deepEqual(computeSettledPayout("sanrentan", sel(1, 2, 3), 500, [], payouts, []), { payout: 500, refunded: 1 });
});

test("返還: 画面は確定済みの返還の印(refunded)を信じて購入額を返す", () => {
  assert.equal(computeTicketPayout({ bet_type: "tan", selections: sel(3), amount: 700, refunded: 1 }, { payouts: PAYOUTS }), 700);
});

test("addResultRefunds: 取消・除外の馬を返還の記録に足す。中止は足さない", () => {
  const results = [
    { horse_number: 1, waku_number: 1, status: "scratched" },
    { horse_number: 2, waku_number: 1, status: "finished" },
    { horse_number: 3, waku_number: 2, status: "excluded" },
    { horse_number: 4, waku_number: 3, status: "cancelled" },
  ];
  const out = addResultRefunds({ tan: [{ combo: [2], rate: 200 }] }, results);
  // 1枠は2番が残っているので返還の枠にしない、2枠は3番だけなので返還の枠
  assert.deepEqual(out.refunds, [{ horse_numbers: [1, 3], waku_numbers: [2] }]);
});

test("addResultRefunds: 払戻がまだ無い・足す馬がいないなら、渡したものをそのまま返す", () => {
  const empty = {};
  assert.equal(addResultRefunds(empty, [{ horse_number: 1, waku_number: 1, status: "scratched" }]), empty);
  const p = { tan: [{ combo: [2], rate: 200 }], refunds: [{ horse_numbers: [1], waku_numbers: [] }] };
  assert.equal(addResultRefunds(p, [{ horse_number: 1, waku_number: 1, status: "scratched" }]), p);
});
