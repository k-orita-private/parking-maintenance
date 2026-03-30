# 🅿️ 駐車場保守管理システム（AIエージェント型 パイロット版）

## システム概要

駐車場巡回スタッフが撮影した複数枚の写真を1セッションとして管理し、
Gemini 2.0 Flash + Vectorize（RAG）が過去事例を参照しながら補修要否を自律判定するシステム。

## アーキテクチャ

```
[Next.js フロントエンド]
  │
  ├─ POST /upload ──► [Cloudflare Workers]
  │                      │
  │                      ├─ R2（画像保存）
  │                      ├─ D1（セッション/画像レコード作成）
  │                      └─ Queue（セッションIDを送信）
  │
  └─ GET /sessions        [Queue Consumer]
     GET /sessions/:id      │
     POST /approve    ◄─── ├─ Step A: 画像→Vectorize（類似検索）
                            ├─ Step B: 過去セッションのフィードバック取得
                            └─ Step C: Gemini 2.0 Flash（マルチモーダル解析）
```

## セットアップ手順

### 1. Cloudflare リソースの作成

```bash
# D1 データベース作成
wrangler d1 create parking-maintenance-db

# R2 バケット作成
wrangler r2 bucket create parking-maintenance-images

# Vectorize インデックス作成（768次元 = text-embedding-004の次元数）
wrangler vectorize create parking-damage-vectors --dimensions=768 --metric=cosine

# Queue 作成
wrangler queues create parking-analysis-queue
```

### 2. wrangler.toml の更新

`wrangler.toml` の `YOUR_D1_DATABASE_ID` を上記コマンドで取得したIDに置き換える。

### 3. シークレットの設定

```bash
# Google Gemini APIキー（https://aistudio.google.com/ で取得）
wrangler secret put GEMINI_API_KEY

# フロントエンドのCORSオリジン
wrangler secret put CORS_ORIGIN
# 入力例: https://your-app.vercel.app
```

### 4. D1 スキーマの適用

```bash
wrangler d1 execute parking-maintenance-db --file=./schema.sql
```

### 5. Workers のデプロイ

```bash
npm install
wrangler deploy
```

### 6. フロントエンドのセットアップ

```bash
cd frontend
npm install

# .env.local を作成
echo "NEXT_PUBLIC_WORKER_URL=https://parking-maintenance-worker.YOUR_SUBDOMAIN.workers.dev" > .env.local

npm run dev
```

## ファイル構成

```
parking-maintenance/
├── wrangler.toml           # Cloudflare Workers 設定
├── schema.sql              # D1 データベーススキーマ
├── src/
│   ├── index.ts            # Workers メインハンドラ（fetch + queue）
│   └── replicate_client.ts # Gemini VLM クライアント
└── frontend/
    ├── package.json
    ├── next.config.js
    └── src/
        ├── lib/api.ts      # APIクライアント & 型定義
        ├── App.tsx          # メインUIコンポーネント
        └── app/
            ├── layout.tsx
            ├── page.tsx
            └── globals.css
```

## 主要な設計判断

### ハイブリッドRAG方式
- **画像単位の検索**: 個別画像をGeminiで説明テキスト化 → Embedding → Vectorize保存
- **セッション単位の文脈**: ヒットした画像の「親セッション全体」を参照
- **フィードバックループ**: 管理者修正 → `feedback_corrections` テーブルに保存 → 次回RAGで正解データとして参照

### 非同期処理
- アップロードAPIは即座にレスポンス（UX向上）
- AI解析はCloudflare Queuesで非同期実行（タイムアウト回避）
- フロントエンドはポーリングで完了を検知

### 緊急度分類
- **A（即時）**: 安全に関わる問題（陥没・転倒リスク・浸水）
- **B（1週間以内）**: 進行性の劣化（ひび割れ拡大・排水不良）
- **C（経過観察）**: 軽微な劣化（小さな傷・塗装剥げ）

## 制限事項（パイロット版）
- 1セッション最大10枚
- Geminiの画像サイズ制限（1枚あたり最大20MB）
- Vectorize の無料枠: 30万ベクトルまで
