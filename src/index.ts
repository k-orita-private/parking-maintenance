/**
 * =============================================================================
 * 駐車場保守管理システム - Cloudflare Workers メインハンドラ
 *
 * エンドポイント:
 *   POST /upload   - 画像アップロード & セッション作成
 *   GET  /sessions - セッション一覧取得
 *   GET  /sessions/:id - セッション詳細取得
 *   POST /approve  - AI判断の承認または修正
 *
 * 非同期処理:
 *   queue() - Queueからメッセージを受け取り、AI解析を実行
 * =============================================================================
 */

import {
  analyzeWithGemini,
  generateImageDescription,
  type SimilarCase,
} from "./replicate_client";

// -------------------------------------------------------------------
// 環境変数の型定義
// -------------------------------------------------------------------
export interface Env {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
  VECTORIZE_INDEX: VectorizeIndex;
  ANALYSIS_QUEUE: Queue;
  AI: Ai;                  // Cloudflare Workers AI（ベクトル化に使用）
  REPLICATE_API_KEY: string; // Replicate API キー（Gemini 3 Flash呼び出し用）
  WORKER_URL: string;
  CORS_ORIGIN: string;
}

// -------------------------------------------------------------------
// CORSヘッダー（フロントエンドからのアクセスを許可）
// -------------------------------------------------------------------
function corsHeaders(env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.CORS_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(
  data: unknown,
  status = 200,
  env?: Env
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(env ? corsHeaders(env) : {}),
    },
  });
}

// -------------------------------------------------------------------
// メインフェッチハンドラ
// -------------------------------------------------------------------
export default {
  /**
   * HTTPリクエストのルーティング
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // プリフライトリクエスト（CORS）の処理
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      // ルーティング
      if (url.pathname === "/upload" && request.method === "POST") {
        return handleUpload(request, env);
      }
      if (url.pathname === "/sessions" && request.method === "GET") {
        return handleGetSessions(request, env);
      }
      if (
        url.pathname.startsWith("/sessions/") &&
        request.method === "GET"
      ) {
        const sessionId = url.pathname.split("/")[2];
        return handleGetSession(sessionId, env);
      }
      if (url.pathname === "/approve" && request.method === "POST") {
        return handleApprove(request, env);
      }

      return jsonResponse({ error: "Not Found" }, 404, env);
    } catch (error) {
      console.error("予期しないエラー:", error);
      return jsonResponse(
        { error: "Internal Server Error", detail: String(error) },
        500,
        env
      );
    }
  },

  /**
   * Queueコンシューマー: 非同期AI解析処理
   * アップロードAPIからセッションIDを受け取り、ハイブリッドRAG解析を実行する
   */
  async queue(
    batch: MessageBatch<{ sessionId: string }>,
    env: Env
  ): Promise<void> {
    for (const message of batch.messages) {
      const { sessionId } = message.body;
      console.log(`[Queue] セッション解析開始: ${sessionId}`);

      try {
        await runHybridRagAnalysis(sessionId, env);
        message.ack(); // 処理成功を通知
        console.log(`[Queue] セッション解析完了: ${sessionId}`);
      } catch (error) {
        console.error(`[Queue] セッション解析失敗: ${sessionId}`, error);
        message.retry(); // 失敗時は再キュー（最大3回）
      }
    }
  },
};

// =============================================================================
// Part 1: アップロード処理
// =============================================================================

/**
 * POST /upload
 * マルチパートフォームデータから駐車場名と複数画像を受け取り、
 * R2に保存してD1にセッションを登録後、Queueにセッションを送信する
 */
async function handleUpload(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const parkingLotName = formData.get("parking_lot_name") as string;

  if (!parkingLotName) {
    return jsonResponse({ error: "parking_lot_name は必須です" }, 400, env);
  }

  // アップロードされた画像ファイルを抽出
  const imageFiles: File[] = [];
  for (const [key, value] of formData.entries()) {
    if (key === "images" && value instanceof File) {
      imageFiles.push(value);
    }
  }

  if (imageFiles.length === 0) {
    return jsonResponse({ error: "画像が1枚もアップロードされていません" }, 400, env);
  }

  if (imageFiles.length > 10) {
    return jsonResponse({ error: "1セッションに登録できる画像は最大10枚です" }, 400, env);
  }

  // セッションIDを生成
  const sessionId = crypto.randomUUID();

  // D1にセッションレコードを作成
  await env.DB.prepare(
    `INSERT INTO report_sessions (id, parking_lot_name, status) VALUES (?, ?, 'pending')`
  )
    .bind(sessionId, parkingLotName)
    .run();

  // 各画像をR2に保存し、D1のimagesテーブルに登録
  const uploadedImages = await Promise.all(
    imageFiles.map(async (file, index) => {
      const imageId = crypto.randomUUID();
      const r2Key = `sessions/${sessionId}/image_${String(index + 1).padStart(3, "0")}_${imageId}.${getFileExtension(file.name)}`;

      // R2に画像を保存
      await env.IMAGES_BUCKET.put(r2Key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
        customMetadata: {
          sessionId,
          originalFilename: file.name,
          imageOrder: String(index),
        },
      });

      // R2の公開URL（Workers経由でアクセス）
      const r2Url = `${env.WORKER_URL}/images/${r2Key}`;

      // D1に画像レコードを登録
      await env.DB.prepare(
        `INSERT INTO images (id, session_id, r2_key, r2_url, image_order, original_filename)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(imageId, sessionId, r2Key, r2Url, index, file.name)
        .run();

      return { imageId, r2Key, r2Url, filename: file.name };
    })
  );

  // 全画像のアップロード完了後、QueueにセッションIDを送信
  // これにより非同期でAI解析がトリガーされる
  await env.ANALYSIS_QUEUE.send({ sessionId });

  console.log(
    `[Upload] セッション作成完了: ${sessionId}, 画像数: ${imageFiles.length}`
  );

  return jsonResponse(
    {
      success: true,
      sessionId,
      parkingLotName,
      uploadedImages: uploadedImages.length,
      message: "アップロード完了。AI解析を開始します。",
    },
    201,
    env
  );
}

// =============================================================================
// Part 2: ハイブリッドRAG解析（Queueコンシューマーから呼び出される）
// =============================================================================

/**
 * セッションのハイブリッドRAG解析を実行する
 *
 * Step A: 各画像をベクトル化してVectorizeで類似画像を検索
 * Step B: 類似画像が属するセッションから過去の人間判断を取得
 * Step C: Gemini 2.0 Flashに今回の画像+過去事例を送信して解析
 */
async function runHybridRagAnalysis(
  sessionId: string,
  env: Env
): Promise<void> {
  // セッションのステータスを「解析中」に更新
  await env.DB.prepare(
    `UPDATE report_sessions SET status = 'analyzing' WHERE id = ?`
  )
    .bind(sessionId)
    .run();

  // セッションに紐づく画像一覧を取得
  const imagesResult = await env.DB.prepare(
    `SELECT id, r2_key, r2_url, image_order FROM images WHERE session_id = ? ORDER BY image_order`
  )
    .bind(sessionId)
    .all<{ id: string; r2_key: string; r2_url: string; image_order: number }>();

  const images = imagesResult.results;
  if (images.length === 0) {
    throw new Error(`セッション ${sessionId} に画像が見つかりません`);
  }

  // セッション情報を取得
  const session = await env.DB.prepare(
    `SELECT parking_lot_name FROM report_sessions WHERE id = ?`
  )
    .bind(sessionId)
    .first<{ parking_lot_name: string }>();

  if (!session) {
    throw new Error(`セッション ${sessionId} が見つかりません`);
  }

  // --- Step A: 各画像をベクトル化し、類似画像を検索 ---
  console.log(`[RAG] Step A: ${images.length}枚の画像をベクトル化`);

  const allSimilarVectorIds = new Set<string>();

  const imageBase64List: Array<{
    base64Data: string;
    mimeType: string;
    filename: string;
  }> = [];

  for (const image of images) {
    // R2から画像を取得
    const r2Object = await env.IMAGES_BUCKET.get(image.r2_key);
    if (!r2Object) continue;

    const imageBuffer = await r2Object.arrayBuffer();
    const base64Data = arrayBufferToBase64(imageBuffer);
    const mimeType = r2Object.httpMetadata?.contentType ?? "image/jpeg";

    imageBase64List.push({ base64Data, mimeType, filename: image.r2_key });

    // --- ベクトル生成（2ステップ）---
    // Step 1: Replicate/Gemini 3 Flash で画像の説明テキストを生成
    const description = await generateImageDescription(
      base64Data,
      mimeType,
      env.REPLICATE_API_KEY
    );
    // Step 2: Workers AI (bge-base-en-v1.5) で説明テキストをベクトル化
    // Workers AI は Cloudflare Workers 組み込みのため追加費用なし
    const embResult = await (env.AI as any).run(
      "@cf/baai/bge-base-en-v1.5",
      { text: [description] }
    ) as { data: number[][] };
    const vector = embResult.data[0];
    if (!vector || vector.length === 0) throw new Error("ベクトル生成失敗: " + image.id);

    // Vectorizeにアップサート（IDは画像IDを使用）
    await env.VECTORIZE_INDEX.upsert([
      {
        id: image.id,
        values: vector,
        metadata: {
          sessionId,
          imageId: image.id,
          parkingLotName: session.parking_lot_name,
        },
      },
    ]);

    // D1の画像レコードにvector_idを記録
    await env.DB.prepare(`UPDATE images SET vector_id = ? WHERE id = ?`)
      .bind(image.id, image.id)
      .run();

    // 類似ベクトルを検索（同一セッションの画像は除外）
    const searchResults = await env.VECTORIZE_INDEX.query(vector, {
      topK: 5,
      filter: { sessionId: { $ne: sessionId } }, // 自分自身のセッションを除外
      returnMetadata: "all",
    });

    for (const match of searchResults.matches) {
      if (match.score > 0.75) {
        // 類似度75%以上を参照
        allSimilarVectorIds.add(String(match.metadata?.["imageId"] ?? match.id));
      }
    }
  }

  // --- Step B: 類似画像が属する過去セッションの人間判断を取得 ---
  console.log(
    `[RAG] Step B: ${allSimilarVectorIds.size}件の類似画像から過去事例を取得`
  );

  const similarCases: SimilarCase[] = [];

  for (const vectorId of Array.from(allSimilarVectorIds).slice(0, 5)) {
    // 最大5件
    // 類似画像が属するセッションを取得
    const similarImage = await env.DB.prepare(
      `SELECT i.session_id, i.r2_url, s.parking_lot_name, s.final_human_comment, s.final_urgency, s.ai_analysis_json
       FROM images i
       JOIN report_sessions s ON i.session_id = s.id
       WHERE i.id = ? AND s.status IN ('approved', 'corrected')`
    )
      .bind(vectorId)
      .first<{
        session_id: string;
        r2_url: string;
        parking_lot_name: string;
        final_human_comment: string | null;
        final_urgency: string | null;
        ai_analysis_json: string | null;
      }>();

    if (!similarImage) continue;

    // 過去のフィードバック（修正履歴）を確認
    const correction = await env.DB.prepare(
      `SELECT corrected_has_damage, corrected_urgency, corrected_comment
       FROM feedback_corrections WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`
    )
      .bind(similarImage.session_id)
      .first<{
        corrected_has_damage: number | null;
        corrected_urgency: string | null;
        corrected_comment: string | null;
      }>();

    // AI分析JSONから破損情報を取得
    const aiAnalysis = similarImage.ai_analysis_json
      ? (JSON.parse(similarImage.ai_analysis_json) as { has_damage?: boolean })
      : null;

    similarCases.push({
      sessionId: similarImage.session_id,
      parkingLotName: similarImage.parking_lot_name,
      imageUrl: similarImage.r2_url,
      similarity: 0.8, // 実際のスコアはVectorize検索時に取得済み
      humanFeedback: {
        // 修正履歴があればそちらを優先（正解データとして活用）
        hasDamage:
          correction?.corrected_has_damage != null
            ? correction.corrected_has_damage === 1
            : (aiAnalysis?.has_damage ?? false),
        urgency:
          (correction?.corrected_urgency ??
            similarImage.final_urgency) as "A" | "B" | "C" | null,
        comment:
          correction?.corrected_comment ?? similarImage.final_human_comment,
      },
    });
  }

  // --- Step C: Gemini 2.0 Flashで総合解析 ---
  console.log(
    `[RAG] Step C: Geminiで解析 (画像${imageBase64List.length}枚, 参考事例${similarCases.length}件)`
  );

  const analysisResult = await analyzeWithGemini(
    {
      currentImages: imageBase64List,
      parkingLotName: session.parking_lot_name,
      similarCases,
    },
    env.REPLICATE_API_KEY
  );

  // 解析結果をD1に保存し、ステータスを「完了」に更新
  const analysisJson = JSON.stringify({
    ...analysisResult,
    similar_cases_count: similarCases.length,
    analyzed_at: new Date().toISOString(),
  });

  await env.DB.prepare(
    `UPDATE report_sessions
     SET ai_analysis_json = ?, status = 'completed', final_urgency = ?
     WHERE id = ?`
  )
    .bind(analysisJson, analysisResult.urgency, sessionId)
    .run();

  console.log(
    `[RAG] 解析完了: ${sessionId} - 破損=${analysisResult.has_damage}, 緊急度=${analysisResult.urgency}`
  );
}

// =============================================================================
// Part 3: セッション管理APIハンドラ
// =============================================================================

/**
 * GET /sessions
 * セッション一覧を取得する（ページネーション対応）
 */
async function handleGetSessions(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") ?? "1");
  const limit = parseInt(url.searchParams.get("limit") ?? "20");
  const status = url.searchParams.get("status"); // フィルタ用
  const offset = (page - 1) * limit;

  let query = `SELECT s.*, COUNT(i.id) as image_count
               FROM report_sessions s
               LEFT JOIN images i ON s.id = i.session_id`;
  const params: (string | number)[] = [];

  if (status) {
    query += ` WHERE s.status = ?`;
    params.push(status);
  }

  query += ` GROUP BY s.id ORDER BY s.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const result = await env.DB.prepare(query)
    .bind(...params)
    .all();

  // 各セッションのサムネイル画像URLを取得
  const sessionsWithThumbs = await Promise.all(
    (result.results as Array<Record<string, unknown>>).map(async (session) => {
      const thumb = await env.DB.prepare(
        `SELECT r2_url FROM images WHERE session_id = ? ORDER BY image_order LIMIT 1`
      )
        .bind(session["id"])
        .first<{ r2_url: string }>();

      return {
        ...session,
        thumbnail_url: thumb?.r2_url ?? null,
      };
    })
  );

  return jsonResponse(
    { sessions: sessionsWithThumbs, page, limit },
    200,
    env
  );
}

/**
 * GET /sessions/:id
 * セッション詳細（全画像URL、AI解析結果を含む）を取得する
 */
async function handleGetSession(
  sessionId: string,
  env: Env
): Promise<Response> {
  const session = await env.DB.prepare(
    `SELECT * FROM report_sessions WHERE id = ?`
  )
    .bind(sessionId)
    .first<Record<string, unknown>>();

  if (!session) {
    return jsonResponse({ error: "セッションが見つかりません" }, 404, env);
  }

  const images = await env.DB.prepare(
    `SELECT id, r2_url, image_order, original_filename FROM images
     WHERE session_id = ? ORDER BY image_order`
  )
    .bind(sessionId)
    .all();

  return jsonResponse(
    {
      ...session,
      ai_analysis: session["ai_analysis_json"]
        ? JSON.parse(session["ai_analysis_json"] as string)
        : null,
      images: images.results,
    },
    200,
    env
  );
}

/**
 * POST /approve
 * 管理者がAIの判断を承認または修正する
 *
 * 修正された内容はfeedback_correctionsに保存され、
 * 次回のRAG解析時に「正解データ」として参照される（学習効果）
 */
async function handleApprove(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    sessionId: string;
    action: "approve" | "correct";
    comment?: string;
    corrections?: {
      hasDamage?: boolean;
      urgency?: "A" | "B" | "C";
      comment?: string;
    };
  };

  const { sessionId, action, comment, corrections } = body;

  if (!sessionId || !action) {
    return jsonResponse(
      { error: "sessionId と action は必須です" },
      400,
      env
    );
  }

  // 対象セッションを取得
  const session = await env.DB.prepare(
    `SELECT * FROM report_sessions WHERE id = ?`
  )
    .bind(sessionId)
    .first<{ ai_analysis_json: string; status: string }>();

  if (!session) {
    return jsonResponse({ error: "セッションが見つかりません" }, 404, env);
  }

  if (action === "approve") {
    // --- 承認: AIの判断をそのまま確定 ---
    await env.DB.prepare(
      `UPDATE report_sessions
       SET status = 'approved', final_human_comment = ?
       WHERE id = ?`
    )
      .bind(comment ?? null, sessionId)
      .run();
  } else if (action === "correct" && corrections) {
    // --- 修正: 人間の判断でAI結果を上書き ---
    const correctionId = crypto.randomUUID();

    // フィードバック履歴に記録（次回のRAGの「正解データ」となる）
    await env.DB.prepare(
      `INSERT INTO feedback_corrections
       (id, session_id, original_ai_analysis, corrected_has_damage, corrected_urgency, corrected_comment)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        correctionId,
        sessionId,
        session.ai_analysis_json,
        corrections.hasDamage != null ? (corrections.hasDamage ? 1 : 0) : null,
        corrections.urgency ?? null,
        corrections.comment ?? null
      )
      .run();

    // セッションのステータスと最終値を更新
    await env.DB.prepare(
      `UPDATE report_sessions
       SET status = 'corrected',
           final_human_comment = ?,
           final_urgency = ?
       WHERE id = ?`
    )
      .bind(
        corrections.comment ?? comment ?? null,
        corrections.urgency ?? null,
        sessionId
      )
      .run();
  }

  return jsonResponse({ success: true, sessionId, action }, 200, env);
}

// =============================================================================
// ユーティリティ関数
// =============================================================================

/** ファイル名から拡張子を取得する */
function getFileExtension(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? (parts[parts.length - 1] ?? "jpg") : "jpg";
}

/** ArrayBufferをBase64文字列に変換する */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
