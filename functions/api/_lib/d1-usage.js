// D1 の使用量(今日。UTC。日本時間の朝9時に切り替わる)を Cloudflare の分析API(GraphQL。無料)で取る(2026-10-08追加)。
// 管理画面「D1の使用量(今日)」(functions/api/admin/d1-usage.js)と、使用量が増えたときの重い機能の自動一時停止
// (_lib/service-guard.js)で使う。D1 の読み取りには数えられない。数字は数分遅れる。
// 必要な設定: Pages の秘密情報 CF_ANALYTICS_TOKEN(API トークン。権限「Account Analytics: Read」と「D1: Read」)。
// 仕様は docs/design/ops.md「D1の使用量の確認」。

const ACCOUNT_ID = "c3dc56a1eaad703f636e2a990aaa7d1c";
const THIS_DB_ID = "82cd3353-2185-4c83-bcde-4cf8db2b905b"; // keiba-yosou-db(wrangler.toml の database_id)
export const D1_DAILY_LIMITS = { rowsRead: 5_000_000, rowsWritten: 100_000 };

async function cfFetch(token, url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

export async function loadD1Usage(token) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // UTC の日付
  // 合計(データベースごと)と、このアプリの重い問い合わせ(今日の読み取り行数の多い順に10件)
  const query = `query($acc:String!,$d:Date!,$since:Time!,$db:String!){viewer{accounts(filter:{accountTag:$acc}){
    d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:$d,date_leq:$d}){sum{rowsRead rowsWritten}dimensions{databaseId}}
    d1QueriesAdaptiveGroups(limit:10,orderBy:[sum_rowsRead_DESC],filter:{datetime_geq:$since,databaseId:$db}){sum{rowsRead rowsWritten}count dimensions{query}}}}}`;
  const [gql, list] = await Promise.all([
    cfFetch(token, "https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables: { acc: ACCOUNT_ID, d: date, since: `${date}T00:00:00Z`, db: THIS_DB_ID } }),
    }),
    // データベース名(権限が無ければ ID のまま表示する)
    cfFetch(token, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database?per_page=100`).catch(() => ({ ok: false })),
  ]);
  const account = gql.data?.data?.viewer?.accounts?.[0];
  const groups = account?.d1AnalyticsAdaptiveGroups;
  if (!gql.ok || !Array.isArray(groups)) {
    const message = gql.data?.errors?.[0]?.message || "分析APIの取得に失敗しました";
    return { configured: true, ok: false, error: message };
  }
  const names = new Map((list.ok && Array.isArray(list.data?.result) ? list.data.result : []).map((d) => [d.uuid, d.name]));
  const databases = groups
    .map((g) => ({
      id: g.dimensions.databaseId,
      name: names.get(g.dimensions.databaseId) || g.dimensions.databaseId,
      isThisApp: g.dimensions.databaseId === THIS_DB_ID,
      rowsRead: Number(g.sum.rowsRead) || 0,
      rowsWritten: Number(g.sum.rowsWritten) || 0,
    }))
    .sort((a, b) => b.rowsRead - a.rowsRead);
  const total = databases.reduce(
    (t, d) => ({ rowsRead: t.rowsRead + d.rowsRead, rowsWritten: t.rowsWritten + d.rowsWritten }),
    { rowsRead: 0, rowsWritten: 0 }
  );
  // 重い問い合わせ(このアプリのDB。同じ形の問い合わせごとの合計)。新しく入れた処理が想定外に重くないかの確認用
  const topQueries = (account?.d1QueriesAdaptiveGroups || []).map((g) => ({
    query: String(g.dimensions.query || "").replace(/\s+/g, " ").slice(0, 300),
    count: Number(g.count) || 0,
    rowsRead: Number(g.sum.rowsRead) || 0,
    rowsWritten: Number(g.sum.rowsWritten) || 0,
  }));
  const resetAt = new Date(`${date}T00:00:00Z`);
  resetAt.setUTCDate(resetAt.getUTCDate() + 1);
  return {
    configured: true,
    ok: true,
    date,
    resetAt: resetAt.toISOString(),
    fetchedAt: now.toISOString(),
    limits: D1_DAILY_LIMITS,
    total,
    databases,
    topQueries,
  };
}


// 同じ実行環境で使い回す(問い合わせすぎないように)。古くなっていても waitUntil があれば古い値をすぐ返し、
// 裏で取り直す(利用者の操作を待たせないため)。日付(UTC)が変わった古い値は使わない。
let usageCache = null; // { at, value }
let refreshing = false;

export async function getD1Usage(token, { maxAgeMs = 60 * 1000, fresh = false, waitUntil = null } = {}) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const usable = usageCache && usageCache.value && (usageCache.value.date === today || !usageCache.value.ok);
  if (!fresh && usable && now - usageCache.at < maxAgeMs) return usageCache.value;
  if (!fresh && usable && usageCache.value.ok && waitUntil) {
    if (!refreshing) {
      refreshing = true;
      waitUntil(
        loadD1Usage(token)
          .then((value) => { usageCache = { at: Date.now(), value }; })
          .catch(() => {})
          .finally(() => { refreshing = false; })
      );
    }
    return usageCache.value;
  }
  const value = await loadD1Usage(token);
  usageCache = { at: Date.now(), value };
  return value;
}

// 使用量の割合(読み取り・書き込みの大きい方。0〜1)。取れなければ null
export function d1UsageRatio(usage) {
  if (!usage || !usage.ok) return null;
  return Math.max(usage.total.rowsRead / usage.limits.rowsRead, usage.total.rowsWritten / usage.limits.rowsWritten);
}
