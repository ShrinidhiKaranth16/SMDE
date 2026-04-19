import {
  ExtractionRecord, ValidationResult, ComplianceReport, ReportDocument,
  DocumentFlag, MissingDocument
} from '../types';

function documentStatus(e: ExtractionRecord): 'OK' | 'WARN' | 'CRITICAL' | 'EXPIRED' {
  if (e.isExpired) return 'EXPIRED';
  const criticalFlag = e.flags.some(f => f.severity === 'CRITICAL');
  if (criticalFlag) return 'CRITICAL';
  const expiringSoon = e.validity?.daysUntilExpiry != null && e.validity.daysUntilExpiry <= 90;
  const highFlag = e.flags.some(f => f.severity === 'HIGH');
  if (expiringSoon || highFlag) return 'WARN';
  return 'OK';
}

export function buildReport(
  sessionId: string,
  extractions: ExtractionRecord[],
  validation: ValidationResult | null,
  validationCreatedAt: string | null
): ComplianceReport {
  const completed = extractions.filter(e => e.status === 'COMPLETE');

  const expired = completed.filter(e => e.isExpired).length;
  const expiringSoon = completed.filter(
    e => !e.isExpired && e.validity?.daysUntilExpiry != null && e.validity.daysUntilExpiry <= 90
  ).length;
  const withCriticalFlags = completed.filter(
    e => e.flags.some(f => f.severity === 'CRITICAL')
  ).length;

  const byCategory: Record<string, number> = {};
  for (const e of completed) {
    if (e.category) {
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    }
  }

  const documents: ReportDocument[] = completed.map(e => ({
    id: e.id,
    fileName: e.fileName,
    documentType: e.documentType,
    documentName: e.documentName,
    category: e.category,
    applicableRole: e.applicableRole,
    confidence: e.confidence,
    holderName: e.holderName,
    isExpired: e.isExpired,
    daysUntilExpiry: e.validity?.daysUntilExpiry ?? null,
    expiryDate: e.validity?.dateOfExpiry && e.validity.dateOfExpiry !== 'No Expiry' && e.validity.dateOfExpiry !== 'Lifetime'
      ? e.validity.dateOfExpiry
      : null,
    flags: e.flags,
    criticalFlagCount: e.flags.filter(f => f.severity === 'CRITICAL').length,
    status: documentStatus(e),
    createdAt: e.createdAt,
  }));

  // Collect critical issues
  const criticalIssues: Array<{ source: string; message: string }> = [];
  const warnings: Array<{ source: string; message: string }> = [];

  for (const doc of completed) {
    for (const flag of doc.flags) {
      const entry = { source: doc.documentName || doc.documentType || doc.fileName, message: flag.message };
      if (flag.severity === 'CRITICAL') criticalIssues.push(entry);
      else if (flag.severity === 'HIGH') warnings.push(entry);
    }
    if (doc.isExpired) {
      criticalIssues.push({
        source: doc.documentName || doc.fileName,
        message: `Document is expired`,
      });
    }
  }

  // Add validation-derived issues
  if (validation) {
    for (const check of validation.consistencyChecks) {
      if (check.status === 'FAIL') {
        criticalIssues.push({ source: 'Identity Check', message: check.message });
      } else if (check.status === 'WARN') {
        warnings.push({ source: 'Identity Check', message: check.message });
      }
    }
    for (const mf of validation.medicalFlags) {
      const entry = { source: mf.documentType, message: mf.message };
      if (mf.severity === 'CRITICAL') criticalIssues.push(entry);
      else warnings.push(entry);
    }
  }

  // Derive overall health
  let overallHealth: 'OK' | 'WARN' | 'CRITICAL' = 'OK';
  if (criticalIssues.length > 0 || expired > 0 || withCriticalFlags > 0) {
    overallHealth = 'CRITICAL';
  } else if (warnings.length > 0 || expiringSoon > 0) {
    overallHealth = 'WARN';
  }

  const overallDecision = validation
    ? validation.overallStatus
    : 'PENDING_VALIDATION';

  return {
    sessionId,
    generatedAt: new Date().toISOString(),
    holderProfile: validation?.holderProfile || null,
    overallDecision,
    overallScore: validation?.overallScore ?? null,
    overallHealth,
    documentSummary: {
      total: completed.length,
      expired,
      expiringSoon,
      withCriticalFlags,
      byCategory,
    },
    documents: documents.sort((a, b) => {
      // Sort by severity: CRITICAL → EXPIRED → WARN → OK
      const order = { CRITICAL: 0, EXPIRED: 1, WARN: 2, OK: 3 };
      return order[a.status] - order[b.status];
    }),
    criticalIssues,
    warnings,
    missingDocuments: validation?.missingDocuments || [],
    recommendations: validation?.recommendations || [],
    lastValidatedAt: validationCreatedAt,
  };
}
