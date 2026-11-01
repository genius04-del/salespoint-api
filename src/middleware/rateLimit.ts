import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// General limiter: generous, just to blunt scraping/abuse — not meant to
// bother a real cashier hammering the POS.
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});

// Strict limiter for login/register/refresh/password-reset — these are the
// endpoints a credential-stuffing or brute-force attack actually targets.
// Keyed by IP + the email in the body where present, so one attacker
// hammering many emails from one IP is still caught, and a shared office IP
// with many legitimate staff logging in isn't punished for someone else's
// wrong password.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${(req.body?.email || "").toLowerCase()}`,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});
