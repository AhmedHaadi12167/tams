/**
 * setupProxy.js
 *
 * Development-only. Create React App reads this automatically and applies it
 * to `npm start`; it has no effect on a production build, where Nginx does
 * the same job.
 *
 * The `"proxy"` field in package.json isn't enough on its own. CRA only
 * forwards requests whose Accept header doesn't ask for HTML — so an image
 * fetched by <img src> proxies fine, but *clicking* a link to that same
 * image is a top-level navigation asking for HTML, which CRA answers with
 * index.html instead. React Router then sees an unknown path and redirects
 * to the dashboard.
 *
 * That is why opening a cargo photo full size bounced back to the dashboard
 * in development while working perfectly in production.
 *
 * Declaring the paths here proxies them unconditionally, navigation or not.
 */

const { createProxyMiddleware } = require("http-proxy-middleware");

const API = process.env.REACT_APP_API_TARGET || "http://localhost:5000";

module.exports = function (app) {
  app.use(
    ["/api", "/uploads", "/health"],
    createProxyMiddleware({
      target: API,
      changeOrigin: true,
      // Uploads can be several megabytes; don't cut them short.
      proxyTimeout: 60000,
      timeout: 60000,
    }),
  );
};
