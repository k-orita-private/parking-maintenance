/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cloudflare Pages向けの静的エクスポート設定（必要な場合）
  // output: 'export',

  // 環境変数（Vercel/Cloudflare Pagesのダッシュボードで設定）
  // NEXT_PUBLIC_WORKER_URL: CloudflareワーカーのURL

  images: {
    // R2のパブリックドメインを許可
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.r2.cloudflarestorage.com",
      },
      {
        protocol: "https",
        hostname: "*.workers.dev",
      },
    ],
  },
};

module.exports = nextConfig;
