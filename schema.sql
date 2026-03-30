-- =============================================================================
-- D1 データベース スキーマ定義
-- 駐車場保守管理システム
-- =============================================================================

-- -------------------------------------------------------------------
-- report_sessions テーブル（親）
-- 巡回スタッフの1回の報告を1セッションとして管理する
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_sessions (
  -- UUID形式のID（Cloudflare Workers で crypto.randomUUID() で生成）
  id TEXT PRIMARY KEY,

  -- 対象の駐車場名
  parking_lot_name TEXT NOT NULL,

  -- AI解析結果をJSONとして格納
  -- 構造: { has_damage, urgency, judgment_reason, action_required, similar_cases }
  ai_analysis_json TEXT,

  -- セッションのステータス管理
  -- pending   : アップロード完了、AI解析待ち
  -- analyzing : AI解析中（Queue Consumerが処理中）
  -- completed : AI解析完了、承認待ち
  -- approved  : 管理者が承認済み
  -- corrected : 管理者がAI判断を修正済み
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'analyzing', 'completed', 'approved', 'corrected')),

  -- 管理者による最終コメント（承認時または修正時に入力）
  final_human_comment TEXT,

  -- 緊急度（AI判断または管理者修正後の最終値）
  -- A: 緊急（即時対応必要）, B: 要対応（1週間以内）, C: 経過観察
  final_urgency TEXT CHECK (final_urgency IN ('A', 'B', 'C')),

  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------------
-- images テーブル（子）
-- セッションに紐づく個別の画像を管理する
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,

  -- 親セッションへの外部キー
  session_id TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,

  -- R2バケット内のオブジェクトキー（例: sessions/abc123/image_001.jpg）
  r2_key TEXT NOT NULL,

  -- R2の公開URL（フロントエンド表示用）
  r2_url TEXT NOT NULL,

  -- Vectorize インデックスに登録されたベクトルID
  -- NULL の場合はまだベクトル化されていない
  vector_id TEXT,

  -- 画像の順序（スライダー表示用）
  image_order INTEGER NOT NULL DEFAULT 0,

  -- 元のファイル名（参考情報）
  original_filename TEXT,

  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------------
-- feedback_corrections テーブル
-- 管理者がAI判断を修正した履歴を保存する
-- この履歴が「正解データ」となり、次回のRAGに活用される
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback_corrections (
  id TEXT PRIMARY KEY,

  -- 修正対象のセッション
  session_id TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,

  -- AI が出した元の判断（JSON）
  original_ai_analysis TEXT NOT NULL,

  -- 管理者が修正した判断
  corrected_has_damage INTEGER, -- 0 or 1 (SQLiteのBOOLEAN)
  corrected_urgency TEXT CHECK (corrected_urgency IN ('A', 'B', 'C')),
  corrected_comment TEXT,

  -- 修正理由（任意）
  correction_reason TEXT,

  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------------
-- インデックス定義
-- -------------------------------------------------------------------

-- セッション一覧の取得を高速化
CREATE INDEX IF NOT EXISTS idx_sessions_status ON report_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON report_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_parking_lot ON report_sessions(parking_lot_name);

-- セッションに紐づく画像の取得を高速化
CREATE INDEX IF NOT EXISTS idx_images_session_id ON images(session_id);

-- フィードバック履歴の取得を高速化
CREATE INDEX IF NOT EXISTS idx_feedback_session_id ON feedback_corrections(session_id);

-- -------------------------------------------------------------------
-- 更新日時の自動更新トリガー
-- -------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS update_sessions_timestamp
  AFTER UPDATE ON report_sessions
BEGIN
  UPDATE report_sessions SET updated_at = datetime('now') WHERE id = NEW.id;
END;
