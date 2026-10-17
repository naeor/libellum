/**
 * **The application version, in one place, because two copies drift.**
 *
 * The scheme is the owner's (2026-10-17): *"一点几几版本代表的是那个版本我们是在处理 S 几的事物"* —
 * `1.13.x` is the series built during S13. The patch part moves on every user-visible change.
 *
 * ⚠️ **It lives in `shared` rather than in the web app** so the API can report the same number
 * from `/health`. Before this, health answered `0.1.0` — the API package's own version — and
 * *"which version is deployed"* could only be answered by reading a file on the server.
 */
export const APP_VERSION = "1.13.01";
