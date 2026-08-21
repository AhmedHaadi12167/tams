require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const routes = require("./routes");
const errorHandler = require("./middlewares/errorHandler");

const app = express();
const PORT = process.env.PORT || 5000;

// Trust proxy (fixes rate-limit X-Forwarded-For warning)
app.set("trust proxy", 1);

// ── Security headers ────────────────────────────────────────────────────
//
// Worth being clear about the division of labour: in production Nginx
// serves index.html and the static bundle, so the headers that protect the
// *page* — Content-Security-Policy above all — must be set there. Express
// only ever returns JSON and uploaded files, so what matters here is that
// those can't be coaxed into executing as something else.
app.use(
  helmet({
    // Uploaded ticket PDFs and cargo photos are fetched by the app itself.
    crossOriginResourcePolicy: { policy: "cross-origin" },

    // Tell browsers to refuse plain HTTP for this host for a year. Set only
    // in production: emitting it from a local dev server would poison the
    // browser's cache for localhost across every other project.
    hsts:
      process.env.NODE_ENV === "production"
        ? { maxAge: 31536000, includeSubDomains: true, preload: false }
        : false,

    // No API response is ever a document, so nothing served from here
    // should be treated as one.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },

    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);

// ── Rate limiting ───────────────────────────────────────────────────────
//
// Password guessing is now stopped by the per-account lockout in
// loginSecurity.js, which is the defence that actually works — an attacker
// can change IP address far more easily than they can guess a password.
//
// These limits exist for the other half of the problem: one address making
// an unreasonable number of requests. `skipSuccessfulRequests` matters more
// than it looks. A travel agency's staff all share one office IP, so
// counting *every* login would have five people locking each other out by
// mid-morning. Only failures count against the limit.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many failed attempts from this address. Try again shortly.",
  },
});

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/forgot-password", loginLimiter);
app.use("/api/auth/verify-otp", loginLimiter);
app.use("/api/auth/reset-password", loginLimiter);

// A backstop against scraping and runaway loops. Set high enough that
// ordinary use — an office of staff working steadily all day — never
// approaches it.
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1500,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { success: false, message: "Too many requests. Please slow down." },
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Static uploads — served from the directory multer actually writes to,
// which is UPLOAD_PATH when set. Hard-coding ./uploads here silently broke
// every photo and PDF in production, where UPLOAD_PATH lives outside the repo.
app.use("/uploads", express.static(require("./middlewares/upload").uploadDir));

// API routes
app.use("/api", routes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// Error handler
app.use(errorHandler);

// Bind to loopback by default. In production Nginx is the only thing that
// should reach the API, so there is nothing to gain from listening on a
// public interface — and plenty to lose, since it would let anyone bypass
// HTTPS by hitting the port directly. Set HOST=0.0.0.0 to override.
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => {
  console.log(`🚀 TAMS Server running on ${HOST}:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
});

module.exports = app;
