/**
 * =============================================================================
 * Gemini 3 Flash クライアント（Replicate API経由）
 *
 * Replicate上のモデル: google/gemini-3-flash
 * モデルページ: https://replicate.com/google/gemini-3-flash
 *
 * 役割:
 *   - 複数の画像（Base64 Data URI）と過去の類似事例テキストをGeminiに送信
 *   - AIによる破損判定・緊急度評価・判断根拠のJSON応答を取得・パース
 *   - ベクトル生成用の画像説明テキスト生成（Vectorize埋め込み用）
 *
 * Replicate API の非同期フロー:
 *   1. POST /v1/models/{owner}/{name}/predictions  → prediction作成
 *   2. Polling: GET /v1/predictions/{id}           → succeeded まで待機
 *   3. output フィールドから結果テキストを取得
 * =============================================================================
 */

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

/** 過去の類似事例（RAGで取得したコンテキスト） */
export interface SimilarCase {
  sessionId: string;
  parkingLotName: string;
  imageUrl: string;
  similarity: number;
  humanFeedback: {
    hasDamage: boolean;
    urgency: "A" | "B" | "C" | null;
    comment: string | null;
  };
}

/** Geminiへの入力データ */
export interface AnalysisInput {
  currentImages: Array<{
    base64Data: string; // Pure base64（プレフィックスなし）
    mimeType: string;
    filename: string;
  }>;
  parkingLotName: string;
  similarCases: SimilarCase[];
}

/** Geminiからの解析結果 */
export interface AnalysisResult {
  has_damage: boolean;
  urgency: "A" | "B" | "C";
  judgment_reason: string;
  action_required: boolean;
  damage_locations: string[];
  similar_cases_referenced: string[];
}

/** Replicate Prediction オブジェクト */
type PredictionStatus =
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

interface ReplicatePrediction {
  id: string;
  status: PredictionStatus;
  output?: string | string[] | null;
  error?: string | null;
}

// -------------------------------------------------------------------
// Replicate API コア
// -------------------------------------------------------------------

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

/**
 * Replicate API への共通fetchラッパー
 */
async function replicateFetch(
  path: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`${REPLICATE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Prefer": "wait", // Replicateの同期待機ヒント（対応モデルのみ有効）
      ...(options.headers ?? {}),
    },
  });
}

/**
 * Prediction を作成し、succeeded/failed まで
 * ポーリングして結果テキストを返す
 *
 * Replicate のレスポンスは原則非同期なため、
 * /v1/predictions/{id} を 2.5秒おきにポーリングする。
 * Cloudflare Workers の CPU タイムに注意し、I/O待ち中心の処理にしている。
 */
async function runPrediction(
  modelPath: string,       // 例: "google/gemini-3-flash"
  input: Record<string, unknown>,
  apiKey: string,
  maxWaitMs = 120_000      // 最大2分待機
): Promise<string> {
  // --- Step 1: Prediction 作成 ---
  const createRes = await replicateFetch(
    `/models/${modelPath}/predictions`,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({ input }),
    }
  );

  if (!createRes.ok) {
    const errBody = await createRes.text();
    throw new Error(
      `[Replicate] Prediction作成失敗: HTTP ${createRes.status} - ${errBody}`
    );
  }

  const prediction = (await createRes.json()) as ReplicatePrediction;

  // "Prefer: wait" が効いた場合は即座に succeeded が返ることもある
  if (prediction.status === "succeeded") {
    return extractOutput(prediction);
  }

  const predId = prediction.id;

  // --- Step 2: ポーリングで完了を待機 ---
  const pollInterval = 2_500; // 2.5秒
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const pollRes = await replicateFetch(`/predictions/${predId}`, apiKey);

    if (!pollRes.ok) {
      throw new Error(`[Replicate] ポーリングエラー: HTTP ${pollRes.status}`);
    }

    const current = (await pollRes.json()) as ReplicatePrediction;

    if (current.status === "succeeded") {
      return extractOutput(current);
    }

    if (current.status === "failed" || current.status === "canceled") {
      throw new Error(
        `[Replicate] Prediction が ${current.status}: ${current.error ?? "詳細不明"}`
      );
    }
    // "starting" | "processing" → 継続ポーリング
  }

  throw new Error(
    `[Replicate] タイムアウト: ${maxWaitMs / 1000}秒以内に完了しませんでした`
  );
}

/** Prediction の output フィールドから文字列を抽出する */
function extractOutput(pred: ReplicatePrediction): string {
  const { output } = pred;
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0) return output.join("");
  throw new Error("[Replicate] outputが空または不正な形式です");
}

/** Promise ベースのsleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------------
// プロンプト構築
// -------------------------------------------------------------------

/**
 * 解析プロンプトを構築する
 *
 * google/gemini-3-flash の Replicate 入力スキーマ:
 *   - prompt : string    テキストプロンプト（system + user を一体化）
 *   - media  : string[]  Base64 Data URI の配列（"data:{mimeType};base64,..."）
 *   - max_tokens : number
 *   - temperature : number
 */
function buildAnalysisPrompt(
  parkingLotName: string,
  imageCount: number,
  similarCases: SimilarCase[]
): string {
  const contextSection =
    similarCases.length > 0
      ? `
## 過去の類似事例（参考情報）
以下は過去に記録された類似破損事例です。人間の担当者が確認した結果を参考にしてください。

${similarCases
  .map(
    (c, i) => `### 事例 ${i + 1}（類似度 ${(c.similarity * 100).toFixed(1)}%）
- 駐車場: ${c.parkingLotName}
- 破損あり: ${c.humanFeedback.hasDamage ? "はい" : "いいえ"}
- 緊急度: ${c.humanFeedback.urgency ?? "未評価"}
- 担当者コメント: ${c.humanFeedback.comment ?? "なし"}`
  )
  .join("\n\n")}`
      : "\n## 参考事例\n（過去事例なし。添付画像のみから判断してください）";

  return `あなたは駐車場設備保守の専門家です。
駐車場「${parkingLotName}」で撮影された${imageCount}枚の写真を総合的に分析し、補修・修繕の必要性を判断してください。

## 緊急度の基準
- A（即時対応）: 安全に関わる問題（大きな陥没・段差・転倒リスク・浸水等）
- B（1週間以内）: 進行性の劣化（ひび割れ拡大傾向・排水不良・剥離等）
- C（経過観察）: 軽微な劣化（小さな傷・塗装剥げ・軽微なひび割れ等）
${contextSection}

## 回答形式（JSONのみ、説明不要）
\`\`\`json
{
  "has_damage": true,
  "urgency": "B",
  "judgment_reason": "路面北側に幅約3mmのひび割れを確認。過去事例1と類似しているが今回は延長が長く進行の可能性があるため緊急度Bと判断。",
  "action_required": true,
  "damage_locations": ["北側入口付近の路面", "駐車区画3番の白線"],
  "similar_cases_referenced": []
}
\`\`\``;
}

/** 画像説明生成用プロンプト（ベクトル化用の短いテキストを得る） */
function buildDescriptionPrompt(): string {
  return "この駐車場の画像に写っている破損・劣化・問題箇所を50文字以内の日本語で説明してください。破損がない場合は「破損なし」とだけ返してください。余計な説明は不要です。";
}

// -------------------------------------------------------------------
// 公開API
// -------------------------------------------------------------------

/**
 * Replicate経由でGemini 3 Flashを呼び出し、
 * 複数の駐車場画像を総合解析する
 */
export async function analyzeWithGemini(
  input: AnalysisInput,
  apiKey: string
): Promise<AnalysisResult> {
  const prompt = buildAnalysisPrompt(
    input.parkingLotName,
    input.currentImages.length,
    input.similarCases
  );

  // Replicate は "data:{mimeType};base64,{data}" 形式を要求
  const media = input.currentImages.map(
    (img) => `data:${img.mimeType};base64,${img.base64Data}`
  );

  const rawOutput = await runPrediction(
    "google/gemini-3-flash",
    {
      prompt,
      media,
      max_tokens: 1024,
      temperature: 0.2,
    },
    apiKey
  );

  // --- JSON抽出 ---
  // Geminiはマークダウンコードブロック（```json ... ```）で返すことが多い
  const jsonMatch =
    rawOutput.match(/```json\s*([\s\S]*?)\s*```/) ??
    rawOutput.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error(
      `JSONを抽出できませんでした。生テキスト（先頭300文字）: ${rawOutput.slice(0, 300)}`
    );
  }

  const jsonStr = jsonMatch[1] ?? jsonMatch[0];

  try {
    const parsed = JSON.parse(jsonStr) as AnalysisResult;

    // バリデーション・デフォルト補完
    if (typeof parsed.has_damage !== "boolean") parsed.has_damage = false;
    if (!["A", "B", "C"].includes(parsed.urgency)) parsed.urgency = "C";
    parsed.damage_locations ??= [];
    parsed.similar_cases_referenced ??= [];

    return parsed;
  } catch (e) {
    throw new Error(`JSONパースエラー: ${String(e)} / 抽出文字列: ${jsonStr}`);
  }
}

/**
 * Replicate経由でGemini 3 Flashに画像説明を生成させる
 *
 * 生成した説明テキストは Cloudflare Workers AI でベクトル化し
 * Vectorize インデックスに保存する（RAGの検索キーとして使用）。
 *
 * ※ Replicate にはEmbedding APIがないため、
 *    説明テキスト生成のみ Replicate を使用し、
 *    ベクトル化は Workers AI（@cf/baai/bge-base-en-v1.5）で行う。
 *    Workers AI は Cloudflare Workers に標準搭載されており追加費用不要。
 */
export async function generateImageDescription(
  imageBase64: string, // pure base64
  mimeType: string,
  apiKey: string
): Promise<string> {
  const media = [`data:${mimeType};base64,${imageBase64}`];

  const description = await runPrediction(
    "google/gemini-3-flash",
    {
      prompt: buildDescriptionPrompt(),
      media,
      max_tokens: 100,
      temperature: 0,
    },
    apiKey
  );

  return description.trim().replace(/\n+/g, " ").slice(0, 200);
}
