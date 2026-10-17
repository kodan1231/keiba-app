// 小さな設定表(騎手名エイリアス・重賞一覧)の全件の写し(2026-10-18追加。@STEP: table_snapshots)。
// 仕様は docs/design/data-model.md「設定表の写し」。
//
// 背景: 画面表示の読み取りAPIは、これらの表を同じ実行環境で2分だけ使い回して(_lib/memo-cache.js)全件を読んでいたが、
// 実行環境が入れ替わるたびに読み直すため、2026-10-17 は jockey_aliases(約360行)を450回・16万行、graded_races(約140行)を
// 514回・7万行読んでいた。全件を JSON にした写しを表 table_snapshots に持ち、1回1〜2行の読み取りで済ませる。
//
// 古い写しを使わない仕組み: 元の表のトリガーが data_versions の 'snap:<表名>' 行の版数を上げる(管理画面・取込など、
// どこから変えても必ず上がる)。写しの行は作ったときの版数を持ち、読むときに今の版数と同じ行だけを使う。
// 作り直しは「版数と全件を1つの batch(トランザクション)で読む → その版数で保存」なので、作っている間に表が変わっても
// 古い内容が新しい版数で残ることはない。
//
// 1行固定にしない(CLAUDE.md の不変条件): 要素を CHUNK_ITEMS 件ずつの行(part)に分け、各行に全体の行数(total)を持つ。
// 保存の失敗は握りつぶす(best-effort。読み取り結果はそのまま返す)。
// D1: 写しがあれば data_versions 1行+写しの行数(今は各1行)。無ければ元の表の全件+data_versions 1行と、保存で数行の書き込み。

const CHUNK_ITEMS = 2000;

// name: 元の表名(data_versions の 'snap:<name>' と table_snapshots.name)。selectSql: 全件を読む SELECT。
// 戻り値: 元の表の行の配列(selectSql の結果と同じ形)
export async function loadTableSnapshot(db, name, selectSql) {
  const vname = `snap:${name}`;
  try {
    const { results } = await db.prepare(
      `SELECT part, total, payload FROM table_snapshots
        WHERE name = ?1 AND version = (SELECT version FROM data_versions WHERE name = ?2)`
    ).bind(name, vname).all();
    const parts = (results || []).sort((a, b) => a.part - b.part);
    if (parts.length && parts.length === Number(parts[0].total) && parts.every((p, i) => p.part === i)) {
      return parts.flatMap((p) => JSON.parse(p.payload));
    }
  } catch (e) {
    // 表が無い(マイグレーション前)・壊れている: 下で元の表を読む
  }

  // 作り直し: 版数と全件を同じトランザクションで読む
  let version = null;
  let rows;
  try {
    const [v, all] = await db.batch([
      db.prepare("SELECT version FROM data_versions WHERE name = ?").bind(vname),
      db.prepare(selectSql),
    ]);
    version = v?.results?.[0]?.version ?? null;
    rows = all?.results || [];
  } catch (e) {
    rows = (await db.prepare(selectSql).all()).results || [];
  }
  if (version !== null && version !== undefined) {
    try {
      const total = Math.max(1, Math.ceil(rows.length / CHUNK_ITEMS));
      const stmts = [db.prepare("DELETE FROM table_snapshots WHERE name = ?").bind(name)];
      for (let part = 0; part < total; part++) {
        stmts.push(db.prepare(
          "INSERT INTO table_snapshots (name, part, total, version, payload) VALUES (?, ?, ?, ?, ?)"
        ).bind(name, part, total, version, JSON.stringify(rows.slice(part * CHUNK_ITEMS, (part + 1) * CHUNK_ITEMS))));
      }
      await db.batch(stmts); // 行数は total+1(2,000件ごとに1行。設定表は数百件)
    } catch (e) {
      console.error(`table snapshot save failed (ignored): ${name}`, e);
    }
  }
  return rows;
}
