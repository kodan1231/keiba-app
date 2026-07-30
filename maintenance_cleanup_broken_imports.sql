-- CSVインポートで発生した「壊れたデータ」の調査・削除用スクリプト。
-- 通常のセットアップ・更新では使用しない。問題調査時にのみ手動実行する。

-- 1) 調査: bet_typeが不正、または組み合わせが空(selections='[]')のグループを一覧表示
SELECT g.id, g.bet_type, g.race_date, g.track, g.race_number, g.total_amount,
  (SELECT COUNT(*) FROM imported_ticket_items i WHERE i.group_id = g.id) AS item_count,
  (SELECT COUNT(*) FROM imported_ticket_items i WHERE i.group_id = g.id AND i.selections <> '[]') AS non_empty_item_count
FROM imported_ticket_groups g
WHERE g.bet_type NOT IN ('tan','fuku','wakuren','umaren','wide','umatan','sanrenpuku','sanrentan')
   OR NOT EXISTS (
     SELECT 1 FROM imported_ticket_items i WHERE i.group_id = g.id AND i.selections <> '[]'
   );

-- 2) 削除: 上記に該当するグループと、対応する取込元データ(imported_tickets)を削除する。
--    imported_tickets側も削除することで、次回同じCSVを再取込した際に「重複」扱いされず
--    最新ロジックで再取込できるようになる。
-- 実行する場合は、以下のコメントアウトを外して実行してください。

 DELETE FROM imported_tickets WHERE id IN (
   SELECT source_row_id FROM imported_ticket_groups g
   WHERE g.bet_type NOT IN ('tan','fuku','wakuren','umaren','wide','umatan','sanrenpuku','sanrentan')
      OR NOT EXISTS (SELECT 1 FROM imported_ticket_items i WHERE i.group_id = g.id AND i.selections <> '[]')
 );
 DELETE FROM imported_ticket_groups
 WHERE bet_type NOT IN ('tan','fuku','wakuren','umaren','wide','umatan','sanrenpuku','sanrentan')
    OR NOT EXISTS (SELECT 1 FROM imported_ticket_items i WHERE i.group_id = imported_ticket_groups.id AND i.selections <> '[]');

-- 3) 調査: 孤立した imported_tickets(CSV原本)を一覧表示。
--    レース削除時にCSV原本が削除されないバグが過去にあったため、
--    どの imported_ticket_groups からも参照されていない(正規化データが失われた)行が残っていることがある。
--    これが「レースは消えたのに購入履歴には残る」「invalid dateの購入履歴が消せない」の原因。
SELECT id, race_date, venue, race_number, bet_type, combination, purchase_amount, receipt_number, sequence_number
FROM imported_tickets it
WHERE NOT EXISTS (
  SELECT 1 FROM imported_ticket_groups g WHERE g.source_row_id = it.id
);

-- 4) 削除: 上記の孤立データを削除する。
--    削除後は receipt_number/sequence_number の重複チェックにも引っかからなくなるため、
--    必要であれば該当CSVを再取込できる。
-- 実行する場合は、以下のコメントアウトを外して実行してください。

 DELETE FROM imported_tickets
 WHERE NOT EXISTS (
   SELECT 1 FROM imported_ticket_groups g WHERE g.source_row_id = imported_tickets.id
 );

