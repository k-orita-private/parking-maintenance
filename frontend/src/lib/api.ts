// =============================================================================
// 型定義 & APIクライアント
// src/lib/api.ts
// =============================================================================

export interface Session {
  id: string;
  parking_lot_name: string;
  status: "pending" | "analyzing" | "completed" | "approved" | "corrected";
  ai_analysis_json: string | null;
  ai_analysis?: AiAnalysis | null;
  final_human_comment: string | null;
  final_urgency: "A" | "B" | "C" | null;
  image_count?: number;
  thumbnail_url?: string | null;
  created_at: string;
  updated_at: string;
  images?: SessionImage[];
}

export interface SessionImage {
  id: string;
  r2_url: string;
  image_order: number;
  original_filename: string;
}

export interface AiAnalysis {
  has_damage: boolean;
  urgency: "A" | "B" | "C";
  judgment_reason: string;
  action_required: boolean;
  damage_locations: string[];
  similar_cases_count: number;
  analyzed_at: string;
}

const API_BASE = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8787";

/** 画像アップロードとセッション作成 */
export async function uploadSession(
  parkingLotName: string,
  images: File[]
): Promise<{ sessionId: string; uploadedImages: number }> {
  const formData = new FormData();
  formData.append("parking_lot_name", parkingLotName);
  images.forEach((img) => formData.append("images", img));

  const res = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error((err as { error: string }).error ?? "アップロード失敗");
  }

  return res.json();
}

/** セッション一覧取得 */
export async function fetchSessions(
  status?: string,
  page = 1
): Promise<{ sessions: Session[] }> {
  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (status) params.append("status", status);

  const res = await fetch(`${API_BASE}/sessions?${params}`);
  return res.json();
}

/** セッション詳細取得 */
export async function fetchSession(id: string): Promise<Session> {
  const res = await fetch(`${API_BASE}/sessions/${id}`);
  if (!res.ok) throw new Error("セッションの取得に失敗しました");
  return res.json();
}

/** AIの判断を承認または修正 */
export async function approveSession(params: {
  sessionId: string;
  action: "approve" | "correct";
  comment?: string;
  corrections?: {
    hasDamage?: boolean;
    urgency?: "A" | "B" | "C";
    comment?: string;
  };
}): Promise<void> {
  const res = await fetch(`${API_BASE}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error("承認処理に失敗しました");
}

/** セッションステータスのポーリング（AI解析完了まで待機） */
export async function pollSessionStatus(
  sessionId: string,
  onUpdate: (session: Session) => void,
  maxAttempts = 30
): Promise<Session> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000)); // 3秒待機
    const session = await fetchSession(sessionId);
    onUpdate(session);

    if (session.status === "completed" || session.status === "approved") {
      return session;
    }
  }
  throw new Error("AI解析がタイムアウトしました");
}
