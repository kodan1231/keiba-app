-- 2026-08-02: races にコース種別・距離を追加する単発マイグレーション
-- 対象: latest1.sql(v13相当)まで適用済みの既存DB。1回だけ実行してください。
-- 新規DBを構築する場合はこのファイルは不要です(schema.sqlに反映済み)。

ALTER TABLE races ADD COLUMN course_type TEXT; -- 芝/ダート/障害。任意入力。既存行はNULLのまま
ALTER TABLE races ADD COLUMN distance INTEGER; -- メートル。任意入力。既存行はNULLのまま
