/** @type {import('next').NextConfig} */

/**
 * Hardened HTTP response headers applied to every route.
 *
 * - X-Frame-Options + frame-ancestors: defeats clickjacking.
 * - X-Content-Type-Options: stops IE/old browsers from MIME-sniffing.
 * - Referrer-Policy: leaks fewer URLs to third parties.
 * - Permissions-Policy: kills powerful APIs we don't use.
 * - HSTS: forces HTTPS for one year (production only).
 * - CSP: restricts script/style/font/image origins to our own + Google
 *   Fonts (still used by globals.css). The 'unsafe-inline' / 'unsafe-eval'
 *   in script-src is kept for now because Next.js inlines bootstrap script
 *   and dev mode uses eval. Tighten once we self-host fonts and audit
 *   inline scripts.
 */
const baseHeaders = [
  { key: "X-Frame-Options",        value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy",        value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy",     value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const productionOnlyHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
];

const securityHeaders = process.env.NODE_ENV === "production"
  ? [...baseHeaders, ...productionOnlyHeaders]
  : baseHeaders;

const nextConfig = {
  // pdf-parse loads canvas as an optional peer; we don't need it server-side.
  // better-sqlite3 is a native module — never bundle it for the Edge runtime.
  serverExternalPackages: ["pdf-parse", "better-sqlite3"],
  // Promoted out of `experimental` in Next 15.5+
  typedRoutes: true,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
    ];
  },
  // Preserve bookmarks after the Cockpit → Action Center rename.
  async redirects() {
    return [
      { source: "/cockpit",            destination: "/action-center",            permanent: true },
      { source: "/api/cockpit-drawer", destination: "/api/action-center-drawer", permanent: true },
    ];
  },
};

export default nextConfig;
