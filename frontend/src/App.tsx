"use client";
/**
 * =============================================================================
 * 駐車場保守管理システム - フロントエンドメインアプリ
 * App.tsx
 *
 * 画面構成:
 *   1. 報告画面    - 駐車場名入力、複数画像アップロード、進捗表示
 *   2. 管理画面    - セッション一覧、AI解析結果の確認・承認・修正
 * =============================================================================
 */

import { useState, useCallback, useRef } from "react";
import type { Session, AiAnalysis } from "./lib/api";
import {
  uploadSession,
  fetchSessions,
  fetchSession,
  approveSession,
  pollSessionStatus,
} from "./lib/api";

// =============================================================================
// ユーティリティ & 定数
// =============================================================================

const URGENCY_CONFIG = {
  A: {
    label: "緊急",
    sublabel: "即時対応",
    color: "#FF3B30",
    bg: "#FFF1F0",
    border: "#FFCCC7",
  },
  B: {
    label: "要対応",
    sublabel: "1週間以内",
    color: "#FF9500",
    bg: "#FFF7E6",
    border: "#FFD591",
  },
  C: {
    label: "経過観察",
    sublabel: "定期確認",
    color: "#34C759",
    bg: "#F6FFED",
    border: "#B7EB8F",
  },
} as const;

const STATUS_LABELS: Record<Session["status"], string> = {
  pending: "アップロード完了",
  analyzing: "AI解析中...",
  completed: "承認待ち",
  approved: "承認済み",
  corrected: "修正済み",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// =============================================================================
// サブコンポーネント
// =============================================================================

/** 緊急度バッジ */
function UrgencyBadge({ urgency }: { urgency: "A" | "B" | "C" }) {
  const cfg = URGENCY_CONFIG[urgency];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 10px",
        borderRadius: "20px",
        fontSize: "12px",
        fontWeight: 700,
        color: cfg.color,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        letterSpacing: "0.02em",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: cfg.color,
          flexShrink: 0,
        }}
      />
      {cfg.label}
    </span>
  );
}

/** ステータスチップ */
function StatusChip({ status }: { status: Session["status"] }) {
  const colors: Record<Session["status"], string> = {
    pending: "#8C8C8C",
    analyzing: "#1677FF",
    completed: "#FA8C16",
    approved: "#52C41A",
    corrected: "#722ED1",
  };
  return (
    <span
      style={{
        fontSize: "11px",
        fontWeight: 600,
        color: colors[status],
        padding: "2px 8px",
        borderRadius: "4px",
        background: `${colors[status]}15`,
        border: `1px solid ${colors[status]}30`,
      }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/** 画像スライダー */
function ImageSlider({ images }: { images: Array<{ url: string; filename: string }> }) {
  const [current, setCurrent] = useState(0);

  if (images.length === 0) return null;

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          width: "100%",
          aspectRatio: "4/3",
          background: "#F0F0F0",
          borderRadius: "10px",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <img
          src={images[current]?.url}
          alt={images[current]?.filename}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transition: "opacity 0.2s",
          }}
          onError={(e) => {
            (e.target as HTMLImageElement).src =
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23eee' width='100' height='100'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%23999' font-size='14'%3E画像%3C/text%3E%3C/svg%3E";
          }}
        />
        {/* 画像番号インジケーター */}
        <div
          style={{
            position: "absolute",
            bottom: "8px",
            right: "8px",
            background: "rgba(0,0,0,0.6)",
            color: "#fff",
            borderRadius: "12px",
            padding: "2px 8px",
            fontSize: "11px",
            fontWeight: 600,
          }}
        >
          {current + 1} / {images.length}
        </div>
      </div>

      {/* ナビゲーションボタン */}
      {images.length > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "6px",
            marginTop: "8px",
          }}
        >
          {images.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrent(i)}
              style={{
                width: i === current ? 20 : 8,
                height: 8,
                borderRadius: "4px",
                background: i === current ? "#1677FF" : "#D9D9D9",
                border: "none",
                cursor: "pointer",
                padding: 0,
                transition: "all 0.2s",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** ローディングスピナー */
function Spinner({ size = 20 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: `2px solid #E8E8E8`,
        borderTop: `2px solid #1677FF`,
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
      }}
    />
  );
}

// =============================================================================
// 報告画面コンポーネント
// =============================================================================

function UploadScreen({
  onComplete,
}: {
  onComplete: (sessionId: string) => void;
}) {
  const [parkingLotName, setParkingLotName] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeStatus, setAnalyzeStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 10) {
        setError("最大10枚まで選択できます");
        return;
      }
      setSelectedFiles(files);
      setError(null);

      // プレビューURL生成
      const urls = files.map((f) => URL.createObjectURL(f));
      setPreviews(urls);
    },
    []
  );

  const handleRemoveFile = useCallback((index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => {
      URL.revokeObjectURL(prev[index]!);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleUpload = useCallback(async () => {
    if (!parkingLotName.trim()) {
      setError("駐車場名を入力してください");
      return;
    }
    if (selectedFiles.length === 0) {
      setError("画像を1枚以上選択してください");
      return;
    }

    setError(null);
    setUploading(true);

    try {
      const { sessionId } = await uploadSession(parkingLotName, selectedFiles);
      setUploading(false);
      setAnalyzing(true);
      setAnalyzeStatus("画像をアップロードしました。AI解析を開始します...");

      // AI解析完了まで進捗をポーリング
      const analyzeMessages = [
        "全画像を総合解析中です...",
        "過去の類似事例を検索しています...",
        "破損パターンを評価しています...",
        "緊急度を判定しています...",
        "報告書を生成しています...",
      ];
      let msgIndex = 0;
      const msgTimer = setInterval(() => {
        msgIndex = (msgIndex + 1) % analyzeMessages.length;
        setAnalyzeStatus(analyzeMessages[msgIndex]!);
      }, 2500);

      await pollSessionStatus(
        sessionId,
        (session) => {
          if (session.status === "completed") {
            clearInterval(msgTimer);
            setAnalyzeStatus("解析完了！結果を確認してください");
          }
        }
      );

      clearInterval(msgTimer);
      setAnalyzing(false);
      onComplete(sessionId);
    } catch (err) {
      setError(String(err));
      setUploading(false);
      setAnalyzing(false);
    }
  }, [parkingLotName, selectedFiles, onComplete]);

  if (analyzing) {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center" }}>
        <div
          style={{
            background: "#F0F7FF",
            border: "1px solid #BAE0FF",
            borderRadius: "16px",
            padding: "40px 24px",
            marginTop: "40px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "20px" }}>
            <Spinner size={48} />
          </div>
          <p
            style={{
              fontSize: "16px",
              fontWeight: 600,
              color: "#1677FF",
              margin: "0 0 8px",
            }}
          >
            AIが全画像を総合解析中です
          </p>
          <p style={{ fontSize: "14px", color: "#4096FF", margin: 0 }}>
            {analyzeStatus}
          </p>
          <div
            style={{
              marginTop: "20px",
              fontSize: "12px",
              color: "#8C8C8C",
            }}
          >
            駐車場: {parkingLotName} ・ 画像: {selectedFiles.length}枚
          </div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px" }}>
      {/* ヘッダー */}
      <div style={{ marginBottom: "24px" }}>
        <h1
          style={{
            fontSize: "20px",
            fontWeight: 700,
            color: "#141414",
            margin: "0 0 4px",
          }}
        >
          🅿️ 破損報告
        </h1>
        <p style={{ fontSize: "13px", color: "#8C8C8C", margin: 0 }}>
          駐車場名を入力し、破損箇所の写真を選択してください
        </p>
      </div>

      {/* 駐車場名入力 */}
      <div style={{ marginBottom: "20px" }}>
        <label
          style={{
            display: "block",
            fontSize: "13px",
            fontWeight: 600,
            color: "#262626",
            marginBottom: "8px",
          }}
        >
          駐車場名 <span style={{ color: "#FF4D4F" }}>*</span>
        </label>
        <input
          type="text"
          value={parkingLotName}
          onChange={(e) => setParkingLotName(e.target.value)}
          placeholder="例: 新宿西口第3駐車場"
          style={{
            width: "100%",
            padding: "12px 14px",
            border: "1.5px solid #D9D9D9",
            borderRadius: "10px",
            fontSize: "16px",
            outline: "none",
            boxSizing: "border-box",
            background: "#FAFAFA",
            transition: "border-color 0.2s",
          }}
          onFocus={(e) => ((e.target as HTMLInputElement).style.borderColor = "#1677FF")}
          onBlur={(e) => ((e.target as HTMLInputElement).style.borderColor = "#D9D9D9")}
        />
      </div>

      {/* 画像選択エリア */}
      <div style={{ marginBottom: "20px" }}>
        <label
          style={{
            display: "block",
            fontSize: "13px",
            fontWeight: 600,
            color: "#262626",
            marginBottom: "8px",
          }}
        >
          写真を選択 <span style={{ color: "#8C8C8C", fontWeight: 400 }}>（最大10枚）</span>
        </label>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          onChange={handleFileSelect}
          style={{ display: "none" }}
          capture="environment"
        />

        {selectedFiles.length === 0 ? (
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              width: "100%",
              padding: "32px 16px",
              border: "2px dashed #D9D9D9",
              borderRadius: "12px",
              background: "#FAFAFA",
              cursor: "pointer",
              textAlign: "center",
              transition: "all 0.2s",
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "8px" }}>📷</div>
            <div style={{ fontSize: "15px", fontWeight: 600, color: "#1677FF" }}>
              写真を選択
            </div>
            <div style={{ fontSize: "12px", color: "#8C8C8C", marginTop: "4px" }}>
              カメラロールから複数枚選択できます
            </div>
          </button>
        ) : (
          <div>
            {/* プレビューグリッド */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "8px",
                marginBottom: "12px",
              }}
            >
              {previews.map((url, i) => (
                <div
                  key={i}
                  style={{ position: "relative", aspectRatio: "1", borderRadius: "8px", overflow: "hidden" }}
                >
                  <img
                    src={url}
                    alt={`preview-${i}`}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                  <button
                    onClick={() => handleRemoveFile(i)}
                    style={{
                      position: "absolute",
                      top: "4px",
                      right: "4px",
                      width: "22px",
                      height: "22px",
                      borderRadius: "50%",
                      background: "rgba(0,0,0,0.65)",
                      color: "#fff",
                      border: "none",
                      cursor: "pointer",
                      fontSize: "12px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {/* 追加ボタン */}
              {selectedFiles.length < 10 && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    aspectRatio: "1",
                    border: "2px dashed #D9D9D9",
                    borderRadius: "8px",
                    background: "#FAFAFA",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "4px",
                    color: "#8C8C8C",
                  }}
                >
                  <span style={{ fontSize: "20px" }}>+</span>
                  <span style={{ fontSize: "10px" }}>追加</span>
                </button>
              )}
            </div>
            <p style={{ fontSize: "12px", color: "#8C8C8C", margin: 0 }}>
              {selectedFiles.length}枚選択済み
            </p>
          </div>
        )}
      </div>

      {/* エラー表示 */}
      {error && (
        <div
          style={{
            background: "#FFF1F0",
            border: "1px solid #FFCCC7",
            borderRadius: "8px",
            padding: "10px 14px",
            fontSize: "13px",
            color: "#CF1322",
            marginBottom: "16px",
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* アップロードボタン */}
      <button
        onClick={handleUpload}
        disabled={uploading || selectedFiles.length === 0 || !parkingLotName.trim()}
        style={{
          width: "100%",
          padding: "16px",
          background:
            uploading || selectedFiles.length === 0 || !parkingLotName.trim()
              ? "#D9D9D9"
              : "#1677FF",
          color: "#fff",
          border: "none",
          borderRadius: "12px",
          fontSize: "16px",
          fontWeight: 700,
          cursor:
            uploading || selectedFiles.length === 0 || !parkingLotName.trim()
              ? "not-allowed"
              : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          transition: "background 0.2s",
        }}
      >
        {uploading ? (
          <>
            <Spinner size={18} />
            アップロード中...
          </>
        ) : (
          "AI解析を開始する →"
        )}
      </button>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// =============================================================================
// 承認モーダルコンポーネント
// =============================================================================

function ApprovalModal({
  session,
  onClose,
  onComplete,
}: {
  session: Session;
  onClose: () => void;
  onComplete: () => void;
}) {
  const analysis = session.ai_analysis as AiAnalysis | null;
  const [mode, setMode] = useState<"view" | "correct">("view");
  const [comment, setComment] = useState("");
  const [correctedUrgency, setCorrectedUrgency] = useState<"A" | "B" | "C">(
    analysis?.urgency ?? "C"
  );
  const [correctedHasDamage, setCorrectedHasDamage] = useState(
    analysis?.has_damage ?? false
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const images = (session.images ?? []).map((img) => ({
    url: img.r2_url,
    filename: img.original_filename,
  }));

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await approveSession({
        sessionId: session.id,
        action: "approve",
        comment,
      });
      onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCorrect = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await approveSession({
        sessionId: session.id,
        action: "correct",
        corrections: {
          hasDamage: correctedHasDamage,
          urgency: correctedUrgency,
          comment,
        },
      });
      onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: "20px 20px 0 0",
          maxHeight: "90vh",
          overflow: "auto",
          padding: "20px 16px 40px",
        }}
      >
        {/* ドラッグハンドル */}
        <div
          style={{
            width: "36px",
            height: "4px",
            background: "#E8E8E8",
            borderRadius: "2px",
            margin: "0 auto 20px",
          }}
        />

        {/* ヘッダー */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h2 style={{ fontSize: "17px", fontWeight: 700, margin: 0, color: "#141414" }}>
              {session.parking_lot_name}
            </h2>
            <StatusChip status={session.status} />
          </div>
          <p style={{ fontSize: "12px", color: "#8C8C8C", margin: "4px 0 0" }}>
            {formatDate(session.created_at)}
          </p>
        </div>

        {/* 画像スライダー */}
        {images.length > 0 && (
          <div style={{ marginBottom: "20px" }}>
            <ImageSlider images={images} />
          </div>
        )}

        {/* AI解析結果 */}
        {analysis && (
          <div
            style={{
              background: "#F8F9FA",
              border: "1px solid #E8E8E8",
              borderRadius: "12px",
              padding: "16px",
              marginBottom: "20px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                marginBottom: "12px",
              }}
            >
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#262626" }}>
                🤖 AI解析結果
              </span>
              {analysis.urgency && <UrgencyBadge urgency={analysis.urgency} />}
              <span
                style={{
                  fontSize: "12px",
                  color: analysis.has_damage ? "#FF4D4F" : "#52C41A",
                  fontWeight: 600,
                }}
              >
                {analysis.has_damage ? "破損あり" : "破損なし"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#434343", lineHeight: 1.6, margin: "0 0 12px" }}>
              {analysis.judgment_reason}
            </p>

            {analysis.damage_locations?.length > 0 && (
              <div>
                <p style={{ fontSize: "12px", fontWeight: 600, color: "#8C8C8C", margin: "0 0 6px" }}>
                  破損箇所:
                </p>
                {analysis.damage_locations.map((loc, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: "12px",
                      color: "#434343",
                      padding: "4px 8px",
                      background: "#fff",
                      borderRadius: "6px",
                      marginBottom: "4px",
                      border: "1px solid #E8E8E8",
                    }}
                  >
                    📍 {loc}
                  </div>
                ))}
              </div>
            )}

            {analysis.action_required && (
              <div
                style={{
                  marginTop: "12px",
                  padding: "8px 12px",
                  background: "#FFF7E6",
                  border: "1px solid #FFD591",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "#D46B08",
                  fontWeight: 600,
                }}
              >
                🔧 見積依頼が必要です
              </div>
            )}
          </div>
        )}

        {/* 承認/修正エリア（未確定のセッションのみ） */}
        {session.status === "completed" && (
          <>
            {/* モード切替タブ */}
            <div
              style={{
                display: "flex",
                background: "#F5F5F5",
                borderRadius: "10px",
                padding: "4px",
                marginBottom: "16px",
              }}
            >
              {(["view", "correct"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    flex: 1,
                    padding: "8px",
                    border: "none",
                    borderRadius: "8px",
                    background: mode === m ? "#fff" : "transparent",
                    fontWeight: mode === m ? 700 : 400,
                    fontSize: "13px",
                    color: mode === m ? "#1677FF" : "#8C8C8C",
                    cursor: "pointer",
                    boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,0.1)" : "none",
                    transition: "all 0.2s",
                  }}
                >
                  {m === "view" ? "✅ そのまま承認" : "✏️ 判断を修正"}
                </button>
              ))}
            </div>

            {/* 修正フォーム */}
            {mode === "correct" && (
              <div style={{ marginBottom: "16px" }}>
                <div style={{ marginBottom: "12px" }}>
                  <p style={{ fontSize: "12px", fontWeight: 600, color: "#8C8C8C", margin: "0 0 8px" }}>
                    修正後の緊急度:
                  </p>
                  <div style={{ display: "flex", gap: "8px" }}>
                    {(["A", "B", "C"] as const).map((u) => {
                      const cfg = URGENCY_CONFIG[u];
                      return (
                        <button
                          key={u}
                          onClick={() => setCorrectedUrgency(u)}
                          style={{
                            flex: 1,
                            padding: "8px",
                            border: `2px solid ${correctedUrgency === u ? cfg.color : "#E8E8E8"}`,
                            borderRadius: "8px",
                            background: correctedUrgency === u ? cfg.bg : "#fff",
                            cursor: "pointer",
                            textAlign: "center",
                          }}
                        >
                          <div style={{ fontSize: "12px", fontWeight: 700, color: cfg.color }}>
                            {u}
                          </div>
                          <div style={{ fontSize: "10px", color: "#8C8C8C" }}>{cfg.sublabel}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ marginBottom: "12px" }}>
                  <p style={{ fontSize: "12px", fontWeight: 600, color: "#8C8C8C", margin: "0 0 8px" }}>
                    破損の有無:
                  </p>
                  <div style={{ display: "flex", gap: "8px" }}>
                    {[true, false].map((v) => (
                      <button
                        key={String(v)}
                        onClick={() => setCorrectedHasDamage(v)}
                        style={{
                          flex: 1,
                          padding: "8px",
                          border: `2px solid ${correctedHasDamage === v ? "#1677FF" : "#E8E8E8"}`,
                          borderRadius: "8px",
                          background: correctedHasDamage === v ? "#F0F7FF" : "#fff",
                          cursor: "pointer",
                          fontSize: "13px",
                          fontWeight: correctedHasDamage === v ? 700 : 400,
                          color: correctedHasDamage === v ? "#1677FF" : "#8C8C8C",
                        }}
                      >
                        {v ? "破損あり" : "破損なし"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* コメント入力 */}
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={mode === "correct" ? "修正理由を入力（任意）" : "コメントを入力（任意）"}
              rows={3}
              style={{
                width: "100%",
                padding: "12px",
                border: "1.5px solid #D9D9D9",
                borderRadius: "10px",
                fontSize: "14px",
                resize: "none",
                outline: "none",
                boxSizing: "border-box",
                marginBottom: "16px",
                fontFamily: "inherit",
              }}
            />

            {error && (
              <div
                style={{
                  background: "#FFF1F0",
                  border: "1px solid #FFCCC7",
                  borderRadius: "8px",
                  padding: "10px",
                  fontSize: "13px",
                  color: "#CF1322",
                  marginBottom: "12px",
                }}
              >
                {error}
              </div>
            )}

            {/* 実行ボタン */}
            <button
              onClick={mode === "view" ? handleApprove : handleCorrect}
              disabled={submitting}
              style={{
                width: "100%",
                padding: "16px",
                background: submitting ? "#D9D9D9" : mode === "correct" ? "#722ED1" : "#52C41A",
                color: "#fff",
                border: "none",
                borderRadius: "12px",
                fontSize: "16px",
                fontWeight: 700,
                cursor: submitting ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
              }}
            >
              {submitting ? (
                <><Spinner size={18} /> 処理中...</>
              ) : mode === "view" ? (
                "✅ 承認する"
              ) : (
                "✏️ 修正して確定する"
              )}
            </button>
          </>
        )}

        {/* 承認済み・修正済みの場合のサマリー */}
        {(session.status === "approved" || session.status === "corrected") && (
          <div
            style={{
              background: session.status === "approved" ? "#F6FFED" : "#F9F0FF",
              border: `1px solid ${session.status === "approved" ? "#B7EB8F" : "#D3ADF7"}`,
              borderRadius: "10px",
              padding: "12px 16px",
            }}
          >
            <p style={{ fontSize: "13px", fontWeight: 700, margin: "0 0 4px", color: session.status === "approved" ? "#389E0D" : "#531DAB" }}>
              {session.status === "approved" ? "✅ 承認済み" : "✏️ 修正済み"}
            </p>
            {session.final_human_comment && (
              <p style={{ fontSize: "13px", color: "#434343", margin: 0 }}>
                {session.final_human_comment}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// 管理画面コンポーネント
// =============================================================================

function AdminScreen() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const { sessions: data } = await fetchSessions(
        filter === "all" ? undefined : filter
      );
      setSessions(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  const openSession = useCallback(async (id: string) => {
    try {
      const detail = await fetchSession(id);
      setSelectedSession(detail);
    } catch (e) {
      console.error(e);
    }
  }, []);

  // 初回ロード
  useState(() => { loadSessions(); });

  const filters = [
    { key: "all", label: "すべて" },
    { key: "completed", label: "承認待ち" },
    { key: "analyzing", label: "解析中" },
    { key: "approved", label: "承認済み" },
    { key: "corrected", label: "修正済み" },
  ];

  return (
    <div style={{ padding: "16px" }}>
      <div style={{ marginBottom: "20px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: 700, color: "#141414", margin: "0 0 4px" }}>
          📋 管理画面
        </h1>
        <p style={{ fontSize: "13px", color: "#8C8C8C", margin: 0 }}>
          AI解析結果の確認・承認を行います
        </p>
      </div>

      {/* フィルタータブ */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          overflowX: "auto",
          paddingBottom: "4px",
          marginBottom: "16px",
        }}
      >
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={{
              padding: "6px 14px",
              border: "1.5px solid",
              borderColor: filter === f.key ? "#1677FF" : "#E8E8E8",
              borderRadius: "20px",
              background: filter === f.key ? "#E6F4FF" : "#fff",
              color: filter === f.key ? "#1677FF" : "#8C8C8C",
              fontSize: "13px",
              fontWeight: filter === f.key ? 700 : 400,
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={loadSessions}
          style={{
            padding: "6px 14px",
            border: "1.5px solid #E8E8E8",
            borderRadius: "20px",
            background: "#fff",
            color: "#8C8C8C",
            fontSize: "13px",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          🔄 更新
        </button>
      </div>

      {/* セッションカード一覧 */}
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "40px" }}>
          <Spinner size={32} />
        </div>
      ) : sessions.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "60px 20px",
            color: "#8C8C8C",
          }}
        >
          <div style={{ fontSize: "48px", marginBottom: "12px" }}>📭</div>
          <p style={{ fontSize: "15px" }}>報告がありません</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {sessions.map((session) => {
            const analysis = session.ai_analysis_json
              ? (JSON.parse(session.ai_analysis_json) as AiAnalysis)
              : null;

            return (
              <div
                key={session.id}
                onClick={() => openSession(session.id)}
                style={{
                  background: "#fff",
                  border: "1px solid #E8E8E8",
                  borderRadius: "14px",
                  padding: "14px",
                  cursor: "pointer",
                  display: "flex",
                  gap: "12px",
                  alignItems: "flex-start",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                  transition: "box-shadow 0.2s",
                  borderLeft:
                    analysis?.urgency === "A"
                      ? "4px solid #FF3B30"
                      : analysis?.urgency === "B"
                      ? "4px solid #FF9500"
                      : "4px solid #E8E8E8",
                }}
              >
                {/* サムネイル */}
                <div
                  style={{
                    width: "72px",
                    height: "72px",
                    borderRadius: "8px",
                    background: "#F5F5F5",
                    flexShrink: 0,
                    overflow: "hidden",
                  }}
                >
                  {session.thumbnail_url ? (
                    <img
                      src={session.thumbnail_url}
                      alt="thumbnail"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "24px",
                      }}
                    >
                      🅿️
                    </div>
                  )}
                </div>

                {/* テキスト情報 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px", flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontSize: "15px",
                        fontWeight: 700,
                        color: "#141414",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {session.parking_lot_name}
                    </span>
                    {analysis?.urgency && <UrgencyBadge urgency={analysis.urgency} />}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                    <StatusChip status={session.status} />
                    <span style={{ fontSize: "11px", color: "#8C8C8C" }}>
                      📷 {(session.image_count as number) ?? 0}枚
                    </span>
                  </div>

                  {analysis && (
                    <p
                      style={{
                        fontSize: "12px",
                        color: "#595959",
                        margin: 0,
                        overflow: "hidden",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        lineHeight: 1.5,
                      }}
                    >
                      {analysis.judgment_reason}
                    </p>
                  )}

                  <p style={{ fontSize: "11px", color: "#BFBFBF", margin: "6px 0 0" }}>
                    {formatDate(session.created_at)}
                  </p>
                </div>

                <span style={{ fontSize: "16px", color: "#8C8C8C", flexShrink: 0 }}>›</span>
              </div>
            );
          })}
        </div>
      )}

      {/* 承認モーダル */}
      {selectedSession && (
        <ApprovalModal
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
          onComplete={() => {
            setSelectedSession(null);
            loadSessions();
          }}
        />
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// =============================================================================
// メインアプリ
// =============================================================================

export default function App() {
  const [activeTab, setActiveTab] = useState<"upload" | "admin">("upload");
  const [completedSessionId, setCompletedSessionId] = useState<string | null>(null);

  const handleUploadComplete = (sessionId: string) => {
    setCompletedSessionId(sessionId);
    setActiveTab("admin");
  };

  return (
    <div
      style={{
        maxWidth: "430px",
        margin: "0 auto",
        minHeight: "100vh",
        background: "#F7F8FA",
        display: "flex",
        flexDirection: "column",
        fontFamily:
          "'Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Noto Sans JP', sans-serif",
      }}
    >
      {/* トップバー */}
      <div
        style={{
          background: "#fff",
          borderBottom: "1px solid #E8E8E8",
          padding: "14px 16px 10px",
          position: "sticky",
          top: 0,
          zIndex: 100,
        }}
      >
        <div style={{ fontSize: "11px", color: "#8C8C8C", fontWeight: 600, letterSpacing: "0.08em" }}>
          PARKING MAINTENANCE AI
        </div>
      </div>

      {/* コンテンツエリア */}
      <div style={{ flex: 1, paddingBottom: "80px" }}>
        {activeTab === "upload" ? (
          <UploadScreen onComplete={handleUploadComplete} />
        ) : (
          <AdminScreen />
        )}
      </div>

      {/* ボトムナビゲーション */}
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: "50%",
          transform: "translateX(-50%)",
          width: "100%",
          maxWidth: "430px",
          background: "#fff",
          borderTop: "1px solid #E8E8E8",
          display: "flex",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {[
          { key: "upload", icon: "📷", label: "報告" },
          { key: "admin", icon: "📋", label: "管理" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as "upload" | "admin")}
            style={{
              flex: 1,
              padding: "10px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "2px",
            }}
          >
            <span style={{ fontSize: "22px" }}>{tab.icon}</span>
            <span
              style={{
                fontSize: "10px",
                fontWeight: 600,
                color: activeTab === tab.key ? "#1677FF" : "#8C8C8C",
              }}
            >
              {tab.label}
            </span>
            {activeTab === tab.key && (
              <div
                style={{
                  width: "4px",
                  height: "4px",
                  borderRadius: "50%",
                  background: "#1677FF",
                }}
              />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
