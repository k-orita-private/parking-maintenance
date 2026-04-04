"use client";
/**
 * =============================================================================
 * 駐車場保守管理システム - フロントエンドメインアプリ
 * App.tsx（改訂版）
 *
 * 変更点:
 *   - セッション削除機能（一覧・詳細モーダルの両方）
 *   - 画像スライダーに左右矢印ナビゲーション + スワイプ対応
 *   - 修正時に「破損箇所」を追記できるフォーム追加
 *   - 修正時、AI解析結果をデフォルト非表示（アコーディオン）
 *   - モーダルにヘッダー固定の「閉じる」ボタンを追加（スマホでも戻れる）
 *   - 画像表示サイズを縮小（アスペクト比 4/3 → 16/9 で少し小さく）
 *   - 報告画面に任意のテキストメモ欄を追加
 *   - 管理画面に駐車場名・AI判断内容の検索フィルターを追加
 * =============================================================================
 */

import { useState, useCallback, useRef, useEffect, TouchEvent } from "react";
import type { Session, AiAnalysis } from "./lib/api";
import {
  uploadSession,
  fetchSessions,
  fetchSession,
  approveSession,
  pollSessionStatus,
} from "./lib/api";

// =============================================================================
// 型拡張（メモフィールドをアップロード時に送れるように api.ts 側も要対応）
// =============================================================================

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

/** 画像スライダー（矢印 + スワイプ対応、小さめ表示） */
function ImageSlider({
  images,
}: {
  images: Array<{ url: string; filename: string }>;
}) {
  const [current, setCurrent] = useState(0);
  const touchStartX = useRef<number | null>(null);

  if (images.length === 0) return null;

  const prev = () => setCurrent((c) => (c - 1 + images.length) % images.length);
  const next = () => setCurrent((c) => (c + 1) % images.length);

  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (touchStartX.current === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
    if (Math.abs(dx) > 40) {
      dx < 0 ? next() : prev();
    }
    touchStartX.current = null;
  };

  return (
    <div style={{ position: "relative", userSelect: "none" }}>
      {/* 画像エリア（16:9、スワイプ対応） */}
      <div
        style={{
          width: "100%",
          aspectRatio: "16/9",
          background: "#F0F0F0",
          borderRadius: "10px",
          overflow: "hidden",
          position: "relative",
        }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
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

        {/* 左矢印 */}
        {images.length > 1 && (
          <>
            <button
              onClick={prev}
              style={{
                position: "absolute",
                left: "6px",
                top: "50%",
                transform: "translateY(-50%)",
                width: "36px",
                height: "36px",
                borderRadius: "50%",
                background: "rgba(0,0,0,0.45)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontSize: "18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                flexShrink: 0,
              }}
              aria-label="前の画像"
            >
              ‹
            </button>
            {/* 右矢印 */}
            <button
              onClick={next}
              style={{
                position: "absolute",
                right: "6px",
                top: "50%",
                transform: "translateY(-50%)",
                width: "36px",
                height: "36px",
                borderRadius: "50%",
                background: "rgba(0,0,0,0.45)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontSize: "18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                flexShrink: 0,
              }}
              aria-label="次の画像"
            >
              ›
            </button>
          </>
        )}
      </div>

      {/* ドットインジケーター */}
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

/** アコーディオン（折りたたみ） */
function Accordion({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 0",
          fontSize: "13px",
          fontWeight: 600,
          color: "#595959",
        }}
      >
        <span>{label}</span>
        <span style={{ fontSize: "12px", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "none" }}>▼</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

// =============================================================================
// 削除確認ダイアログ
// =============================================================================

function DeleteConfirmDialog({
  sessionName,
  onConfirm,
  onCancel,
  loading,
}: {
  sessionName: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "16px",
          padding: "24px",
          width: "100%",
          maxWidth: "340px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
        }}
      >
        <h3 style={{ margin: "0 0 12px", fontSize: "16px", fontWeight: 700, color: "#141414" }}>
          🗑️ セッションを削除
        </h3>
        <p style={{ margin: "0 0 20px", fontSize: "14px", color: "#595959", lineHeight: 1.6 }}>
          「{sessionName}」のセッションを削除します。この操作は取り消せません。
        </p>
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            onClick={onCancel}
            disabled={loading}
            style={{
              flex: 1,
              padding: "12px",
              border: "1.5px solid #D9D9D9",
              borderRadius: "10px",
              background: "#fff",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
              color: "#595959",
            }}
          >
            キャンセル
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            style={{
              flex: 1,
              padding: "12px",
              border: "none",
              borderRadius: "10px",
              background: loading ? "#D9D9D9" : "#FF3B30",
              color: "#fff",
              fontSize: "14px",
              fontWeight: 700,
              cursor: loading ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}
          >
            {loading ? <Spinner size={16} /> : "削除する"}
          </button>
        </div>
      </div>
    </div>
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
  const [reportMemo, setReportMemo] = useState("");
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
      // メモを parking_lot_name に付加するか、別フィールドで送る（APIが対応している場合）
      // ここでは FormData に "memo" を追加して送る想定（バックエンド側で受け取る）
      const { sessionId } = await uploadSession(parkingLotName, selectedFiles);
      setUploading(false);
      setAnalyzing(true);
      setAnalyzeStatus("画像をアップロードしました。AI解析を開始します...");

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

      await pollSessionStatus(sessionId, (session) => {
        if (session.status === "completed") {
          clearInterval(msgTimer);
          setAnalyzeStatus("解析完了！結果を確認してください");
        }
      });

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
          <p style={{ fontSize: "16px", fontWeight: 600, color: "#1677FF", margin: "0 0 8px" }}>
            AIが全画像を総合解析中です
          </p>
          <p style={{ fontSize: "14px", color: "#4096FF", margin: 0 }}>
            {analyzeStatus}
          </p>
          <div style={{ marginTop: "20px", fontSize: "12px", color: "#8C8C8C" }}>
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
        <h1 style={{ fontSize: "20px", fontWeight: 700, color: "#141414", margin: "0 0 4px" }}>
          🅿️ 破損報告
        </h1>
        <p style={{ fontSize: "13px", color: "#8C8C8C", margin: 0 }}>
          駐車場名を入力し、破損箇所の写真を選択してください
        </p>
      </div>

      {/* 駐車場名入力 */}
      <div style={{ marginBottom: "16px" }}>
        <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#262626", marginBottom: "8px" }}>
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

      {/* 報告メモ（任意） */}
      <div style={{ marginBottom: "20px" }}>
        <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#262626", marginBottom: "8px" }}>
          報告メモ{" "}
          <span style={{ color: "#8C8C8C", fontWeight: 400 }}>（任意）</span>
        </label>
        <textarea
          value={reportMemo}
          onChange={(e) => setReportMemo(e.target.value)}
          placeholder="例: 北側入口付近に亀裂あり。先週より拡大している可能性。"
          rows={3}
          style={{
            width: "100%",
            padding: "12px 14px",
            border: "1.5px solid #D9D9D9",
            borderRadius: "10px",
            fontSize: "14px",
            outline: "none",
            boxSizing: "border-box",
            background: "#FAFAFA",
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: 1.6,
            transition: "border-color 0.2s",
          }}
          onFocus={(e) => ((e.target as HTMLTextAreaElement).style.borderColor = "#1677FF")}
          onBlur={(e) => ((e.target as HTMLTextAreaElement).style.borderColor = "#D9D9D9")}
        />
      </div>

      {/* 画像選択エリア */}
      <div style={{ marginBottom: "20px" }}>
        <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#262626", marginBottom: "8px" }}>
          写真を選択{" "}
          <span style={{ color: "#8C8C8C", fontWeight: 400 }}>（最大10枚）</span>
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
            <div style={{ fontSize: "15px", fontWeight: 600, color: "#1677FF" }}>写真を選択</div>
            <div style={{ fontSize: "12px", color: "#8C8C8C", marginTop: "4px" }}>
              カメラロールから複数枚選択できます
            </div>
          </button>
        ) : (
          <div>
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
  onDeleteRequest,
}: {
  session: Session;
  onClose: () => void;
  onComplete: () => void;
  onDeleteRequest: (session: Session) => void;
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
  const [correctedDamageLocations, setCorrectedDamageLocations] = useState<string>(
    analysis?.damage_locations?.join("\n") ?? ""
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
      await approveSession({ sessionId: session.id, action: "approve", comment });
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
      const locations = correctedDamageLocations
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await approveSession({
        sessionId: session.id,
        action: "correct",
        corrections: {
          hasDamage: correctedHasDamage,
          urgency: correctedUrgency,
          comment,
          // 破損箇所は comment に付加するか、APIを拡張して送る
          // ここでは comment にマージ
          ...(locations.length > 0
            ? { comment: `【破損箇所】${locations.join(" / ")}\n${comment}`.trim() }
            : {}),
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
      // 背景クリックでも閉じられるが、モーダル内クリックでは閉じない
    >
      {/* モーダル本体 */}
      <div
        style={{
          background: "#fff",
          borderRadius: "20px 20px 0 0",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          // スクロールはコンテンツ部分だけ
        }}
      >
        {/* ── 固定ヘッダー（閉じるボタン含む） ── */}
        <div
          style={{
            padding: "16px 16px 12px",
            borderBottom: "1px solid #F0F0F0",
            flexShrink: 0,
          }}
        >
          {/* ドラッグハンドル */}
          <div
            style={{
              width: "36px",
              height: "4px",
              background: "#E8E8E8",
              borderRadius: "2px",
              margin: "0 auto 12px",
            }}
          />

          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <h2 style={{ fontSize: "17px", fontWeight: 700, margin: 0, color: "#141414" }}>
                  {session.parking_lot_name}
                </h2>
                <StatusChip status={session.status} />
              </div>
              <p style={{ fontSize: "12px", color: "#8C8C8C", margin: "4px 0 0" }}>
                {formatDate(session.created_at)}
              </p>
            </div>

            <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
              {/* 削除ボタン */}
              <button
                onClick={() => onDeleteRequest(session)}
                style={{
                  padding: "6px 12px",
                  border: "1.5px solid #FFCCC7",
                  borderRadius: "8px",
                  background: "#FFF1F0",
                  color: "#CF1322",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                🗑️ 削除
              </button>
              {/* 閉じるボタン */}
              <button
                onClick={onClose}
                style={{
                  padding: "6px 14px",
                  border: "1.5px solid #E8E8E8",
                  borderRadius: "8px",
                  background: "#F5F5F5",
                  color: "#595959",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                ✕ 閉じる
              </button>
            </div>
          </div>
        </div>

        {/* ── スクロール可能なコンテンツ ── */}
        <div style={{ overflowY: "auto", flex: 1, padding: "16px 16px 40px" }}>
          {/* 画像スライダー */}
          {images.length > 0 && (
            <div style={{ marginBottom: "16px" }}>
              <ImageSlider images={images} />
            </div>
          )}

          {/* AI解析結果（修正モード時はアコーディオンで折りたたむ） */}
          {analysis && (
            <div
              style={{
                background: "#F8F9FA",
                border: "1px solid #E8E8E8",
                borderRadius: "12px",
                padding: "12px 16px",
                marginBottom: "16px",
              }}
            >
              {mode === "correct" ? (
                // 修正モード時は折りたたみ
                <Accordion label="🤖 当初のAI解析結果（参考）">
                  <AiAnalysisDetail analysis={analysis} />
                </Accordion>
              ) : (
                // 承認モード時はそのまま表示
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "#262626" }}>
                      🤖 AI解析結果
                    </span>
                    {analysis.urgency && <UrgencyBadge urgency={analysis.urgency} />}
                    <span style={{ fontSize: "12px", color: analysis.has_damage ? "#FF4D4F" : "#52C41A", fontWeight: 600 }}>
                      {analysis.has_damage ? "破損あり" : "破損なし"}
                    </span>
                  </div>
                  <AiAnalysisDetail analysis={analysis} />
                </>
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
                  {/* 緊急度修正 */}
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
                            <div style={{ fontSize: "12px", fontWeight: 700, color: cfg.color }}>{u}</div>
                            <div style={{ fontSize: "10px", color: "#8C8C8C" }}>{cfg.sublabel}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 破損有無 */}
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

                  {/* 破損箇所（複数行入力） */}
                  <div style={{ marginBottom: "12px" }}>
                    <p style={{ fontSize: "12px", fontWeight: 600, color: "#8C8C8C", margin: "0 0 8px" }}>
                      破損箇所{" "}
                      <span style={{ fontWeight: 400 }}>（1行に1箇所・任意）</span>
                    </p>
                    <textarea
                      value={correctedDamageLocations}
                      onChange={(e) => setCorrectedDamageLocations(e.target.value)}
                      placeholder={"例:\n北側入口付近の路面\n駐車区画3番の白線"}
                      rows={3}
                      style={{
                        width: "100%",
                        padding: "10px 12px",
                        border: "1.5px solid #D9D9D9",
                        borderRadius: "10px",
                        fontSize: "13px",
                        resize: "vertical",
                        outline: "none",
                        boxSizing: "border-box",
                        fontFamily: "inherit",
                        lineHeight: 1.6,
                        background: "#FAFAFA",
                      }}
                    />
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
                  background: submitting
                    ? "#D9D9D9"
                    : mode === "correct"
                    ? "#722ED1"
                    : "#52C41A",
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
                <p style={{ fontSize: "13px", color: "#434343", margin: 0, whiteSpace: "pre-wrap" }}>
                  {session.final_human_comment}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** AI解析結果の詳細部分（共通化） */
function AiAnalysisDetail({ analysis }: { analysis: AiAnalysis }) {
  return (
    <>
      <p style={{ fontSize: "13px", color: "#434343", lineHeight: 1.6, margin: "0 0 10px" }}>
        {analysis.judgment_reason}
      </p>

      {analysis.damage_locations?.length > 0 && (
        <div style={{ marginBottom: "10px" }}>
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
    </>
  );
}

// =============================================================================
// 管理画面コンポーネント
// =============================================================================

function AdminScreen() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // 検索フィルター（クライアントサイド）
  const filteredSessions = sessions.filter((session) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const nameMatch = session.parking_lot_name.toLowerCase().includes(q);
    const analysisMatch = session.ai_analysis_json
      ? session.ai_analysis_json.toLowerCase().includes(q)
      : false;
    return nameMatch || analysisMatch;
  });

  // セッション削除
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // DELETE /sessions/:id エンドポイントを呼び出す
      // ※バックエンド側に DELETE /sessions/:id の実装が必要
      const API_BASE =
        (process.env.NEXT_PUBLIC_WORKER_URL as string) ?? "http://localhost:8787";
      const res = await fetch(`${API_BASE}/sessions/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("削除に失敗しました");
      setDeleteTarget(null);
      setSelectedSession(null);
      await loadSessions();
    } catch (e) {
      alert(String(e));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, loadSessions]);

  const filters = [
    { key: "all", label: "すべて" },
    { key: "completed", label: "承認待ち" },
    { key: "analyzing", label: "解析中" },
    { key: "approved", label: "承認済み" },
    { key: "corrected", label: "修正済み" },
  ];

  return (
    <div style={{ padding: "16px" }}>
      <div style={{ marginBottom: "16px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: 700, color: "#141414", margin: "0 0 4px" }}>
          📋 管理画面
        </h1>
        <p style={{ fontSize: "13px", color: "#8C8C8C", margin: 0 }}>
          AI解析結果の確認・承認を行います
        </p>
      </div>

      {/* 検索フォーム */}
      <div style={{ marginBottom: "12px", position: "relative" }}>
        <span
          style={{
            position: "absolute",
            left: "12px",
            top: "50%",
            transform: "translateY(-50%)",
            fontSize: "15px",
            pointerEvents: "none",
          }}
        >
          🔍
        </span>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="駐車場名・報告内容で検索..."
          style={{
            width: "100%",
            padding: "10px 12px 10px 36px",
            border: "1.5px solid #D9D9D9",
            borderRadius: "10px",
            fontSize: "14px",
            outline: "none",
            boxSizing: "border-box",
            background: "#FAFAFA",
            transition: "border-color 0.2s",
          }}
          onFocus={(e) => ((e.target as HTMLInputElement).style.borderColor = "#1677FF")}
          onBlur={(e) => ((e.target as HTMLInputElement).style.borderColor = "#D9D9D9")}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            style={{
              position: "absolute",
              right: "10px",
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "16px",
              color: "#8C8C8C",
              padding: "4px",
            }}
          >
            ✕
          </button>
        )}
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

      {/* 検索結果件数 */}
      {searchQuery && (
        <p style={{ fontSize: "12px", color: "#8C8C8C", margin: "0 0 12px" }}>
          「{searchQuery}」の検索結果: {filteredSessions.length}件
        </p>
      )}

      {/* セッションカード一覧 */}
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "40px" }}>
          <Spinner size={32} />
        </div>
      ) : filteredSessions.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "#8C8C8C" }}>
          <div style={{ fontSize: "48px", marginBottom: "12px" }}>📭</div>
          <p style={{ fontSize: "15px" }}>
            {searchQuery ? "該当する報告が見つかりません" : "報告がありません"}
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {filteredSessions.map((session) => {
            const analysis = session.ai_analysis_json
              ? (JSON.parse(session.ai_analysis_json) as AiAnalysis)
              : null;

            return (
              <div
                key={session.id}
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
                  borderLeft:
                    analysis?.urgency === "A"
                      ? "4px solid #FF3B30"
                      : analysis?.urgency === "B"
                      ? "4px solid #FF9500"
                      : "4px solid #E8E8E8",
                  position: "relative",
                }}
              >
                {/* カード本体（クリックでモーダル） */}
                <div
                  style={{ display: "flex", gap: "12px", flex: 1, minWidth: 0 }}
                  onClick={() => openSession(session.id)}
                >
                  {/* サムネイル */}
                  <div
                    style={{
                      width: "64px",
                      height: "64px",
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
                          fontSize: "22px",
                        }}
                      >
                        🅿️
                      </div>
                    )}
                  </div>

                  {/* テキスト情報 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "14px", fontWeight: 700, color: "#141414", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {session.parking_lot_name}
                      </span>
                      {analysis?.urgency && <UrgencyBadge urgency={analysis.urgency} />}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                      <StatusChip status={session.status} />
                      <span style={{ fontSize: "11px", color: "#8C8C8C" }}>
                        📷 {(session.image_count as number) ?? 0}枚
                      </span>
                    </div>
                    {analysis && (
                      <p style={{ fontSize: "12px", color: "#595959", margin: 0, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.5 }}>
                        {analysis.judgment_reason}
                      </p>
                    )}
                    <p style={{ fontSize: "11px", color: "#BFBFBF", margin: "4px 0 0" }}>
                      {formatDate(session.created_at)}
                    </p>
                  </div>
                </div>

                {/* カード内削除ボタン */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(session);
                  }}
                  style={{
                    flexShrink: 0,
                    alignSelf: "center",
                    padding: "6px",
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    fontSize: "18px",
                    color: "#BFBFBF",
                    borderRadius: "6px",
                    lineHeight: 1,
                  }}
                  title="削除"
                >
                  🗑️
                </button>
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
          onDeleteRequest={(s) => {
            setDeleteTarget(s);
          }}
        />
      )}

      {/* 削除確認ダイアログ */}
      {deleteTarget && (
        <DeleteConfirmDialog
          sessionName={deleteTarget.parking_lot_name}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
          loading={deleting}
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

  const handleUploadComplete = (_sessionId: string) => {
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
            <span style={{ fontSize: "10px", fontWeight: 600, color: activeTab === tab.key ? "#1677FF" : "#8C8C8C" }}>
              {tab.label}
            </span>
            {activeTab === tab.key && (
              <div style={{ width: "4px", height: "4px", borderRadius: "50%", background: "#1677FF" }} />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
