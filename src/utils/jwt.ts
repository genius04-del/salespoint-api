import jwt from "jsonwebtoken";

export interface AccessTokenPayload {
  userId: string;
  businessId: string;
  role: string;
  permissions?: string[];
}

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET as string;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET as string;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  // Fail fast at boot rather than issuing insecure/undefined-signed tokens later.
  throw new Error(
    "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set in the environment"
  );
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: "15m" });
}

export function signRefreshToken(payload: { userId: string; tokenVersion?: number }): string {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: "30d" });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): { userId: string; tokenVersion?: number } {
  return jwt.verify(token, REFRESH_SECRET) as { userId: string; tokenVersion?: number };
}
