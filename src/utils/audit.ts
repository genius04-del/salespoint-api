import { prisma } from "../config/prisma";

interface AuditParams {
  businessId: string;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

// Never let an audit-log failure block the real business operation;
// log it but swallow the error so a sale/login etc. still succeeds.
export async function recordAudit(params: AuditParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        businessId: params.businessId,
        userId: params.userId ?? null,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId ?? null,
        metadata: params.metadata as any,
      },
    });
  } catch (err) {
    console.error("Failed to write audit log:", err);
  }
}
