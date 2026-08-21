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

// Security middleware
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);

// Rate limiting
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many requests, please try again later.",
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
