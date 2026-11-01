import { Request, Response, NextFunction } from "express";
import { verifyAccessToken, AccessTokenPayload } from "../utils/jwt";
import { effectivePermissions, Permission } from "../services/permissions";

export type AuthContext = AccessTokenPayload & { permissions: string[] };

// Augment Express's Request so downstream handlers get typed access
// to the authenticated user without re-decoding the token.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

// Verifies the JWT and attaches { userId, businessId, role, permissions } to
// req.auth. This businessId is the ONLY source of tenant scoping downstream
// handlers should trust — never a businessId taken from the request body/params.
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(header.slice("Bearer ".length));
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // Tokens issued before granular permissions existed carry no permission
  // list — fall back to the role's defaults so those sessions keep working.
  req.auth = {
    ...payload,
    permissions: payload.permissions ?? effectivePermissions(payload.role, [], []),
  };
  next();
}

// Restricts a route to specific roles. Must run after authenticate().
// Kept for the few things that are inherently role-bound (e.g. Owner-only).
export function authorize(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (!allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }
    next();
  };
}

// Restricts a route to users holding at least one of the given permissions.
// Must run after authenticate().
export function requirePermission(...required: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (!required.some((p) => req.auth!.permissions.includes(p))) {
      return res.status(403).json({ error: "You don't have permission to do this", required });
    }
    next();
  };
}
