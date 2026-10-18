// Cloudflare D1 を HTTP の API で読むための小さな部品(2026-10-18。夜間の比率の計算 scripts/pace-nightly.mjs 用)。
// Pages Functions の env.DB と同じ形(prepare(sql).bind(...).all() / first() / run()、batch([...]))で使えるので、
// サーバーの採点のコード(functions/api/_lib/pace-score.js の backtestChunk)を Node でそのまま動かせる。
// 採点を Cloudflare で行うと、1回の処理の CPU 時間の上限(無料枠)を続けて超えて呼び出しがまとめて断られたため
// (2026-10-19 の手動実行で30件中11件が 503 exceededResources)、採点は Node で行う。
// トークンは D1 の読み取りの権限があればよい。書き込み(キャッシュの差し替えの保存等)は失敗し、呼び出し側のコードが握りつぶす。
// batch は順に1文ずつ送る(読み取りだけなのでトランザクションは要らない)。
// 混雑(429)・一時的な失敗(5xx・通信エラー)は待ってやり直す。

const API = "https://api.cloudflare.com/client/v4";

export function createD1Rest({ accountId, databaseId, token, onQuery = null }) {
  if (!accountId || !databaseId || !token) throw new Error("D1 の accountId / databaseId / token が要ります");
  const url = `${API}/accounts/${accountId}/d1/database/${databaseId}/query`;
  let rowsRead = 0, queries = 0;

  async function query(sql, params) {
    let last = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * 2 ** (attempt - 1))));
      let res, data;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ sql, params: params || [] }),
        });
        data = await res.json().catch(() => null);
      } catch (e) {
        last = e;
        continue;
      }
      if (res.ok && data?.success) {
        const r = data.result?.[0] || { results: [], meta: {} };
        queries++;
        rowsRead += Number(r.meta?.rows_read) || 0;
        if (onQuery) onQuery(sql, r.meta);
        return r;
      }
      const msg = data?.errors?.map((e) => `${e.code}: ${e.message}`).join(" / ") || `HTTP ${res.status}`;
      last = new Error(`D1 ${msg}`);
      if (res.status !== 429 && res.status < 500) throw last; // 書き込みの権限が無い・SQL の誤り等はやり直さない
    }
    throw last;
  }

  function prepare(sql) {
    let params = [];
    const st = {
      bind(...a) { params = a; return st; },
      async all() { const r = await query(sql, params); return { results: r.results || [], meta: r.meta || {} }; },
      async first(col) { const r = await query(sql, params); const row = (r.results || [])[0] ?? null; return col && row ? row[col] : row; },
      async run() { const r = await query(sql, params); return { success: true, meta: r.meta || {} }; },
      _exec: () => query(sql, params).then((r) => ({ results: r.results || [], meta: r.meta || {}, success: true })),
    };
    return st;
  }

  return {
    prepare,
    async batch(list) {
      const out = [];
      for (const st of list) out.push(await st._exec());
      return out;
    },
    stats: () => ({ queries, rowsRead }),
  };
}
