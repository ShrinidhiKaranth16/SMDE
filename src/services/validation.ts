import { ExtractionRecord, ValidationResult, LLMProvider, ApplicableRole, DocumentType } from '../types';
import { parseExtractionResult } from './extraction';

export function buildValidationPrompt(extractions: ExtractionRecord[]): string {
  // Serialize documents in a compact, structured way to stay within token budget
  const documentSummaries = extractions.map((e, i) => ({
    index: i + 1,
    documentType: e.documentType,
    documentName: e.documentName,
    applicableRole: e.applicableRole,
    holderName: e.holderName,
    dateOfBirth: e.dateOfBirth,
    sirbNumber: e.sirbNumber,
    passportNumber: e.passportNumber,
    confidence: e.confidence,
    isExpired: e.isExpired,
    validity: e.validity,
    medicalData: e.medicalData,
    flags: e.flags,
    compliance: e.compliance ? {
      issuingAuthority: e.compliance.issuingAuthority,
      regulationReference: e.compliance.regulationReference,
      recognizedAuthority: e.compliance.recognizedAuthority,
      limitations: e.compliance.limitations,
    } : null,
    criticalFields: e.fields
      .filter(f => f.importance === 'CRITICAL' || f.importance === 'HIGH')
      .slice(0, 10),
  }));

  return `You are a senior maritime compliance officer with deep expertise in STCW, MARINA, IMO regulations, and Manning Agent requirements for seafarer certification.

You have been given ${extractions.length} extracted seafarer document(s) for a single individual. Your task is to perform a comprehensive cross-document compliance assessment.

DOCUMENTS:
${JSON.stringify(documentSummaries, null, 2)}

PERFORM THE FOLLOWING CHECKS:

1. IDENTITY CONSISTENCY: Do all documents with holder names show the same person? Do dates of birth, passport numbers, and SIRB numbers match across documents?

2. ROLE DETERMINATION: Based on the document set, is this person a DECK officer, ENGINE officer, BOTH, or undetermined? Flag any role mismatches.

3. REQUIRED DOCUMENT COVERAGE: For the detected role, identify which standard required documents are MISSING:
   - DECK officers typically need: COC, SIRB, PASSPORT, PEME, DRUG_TEST, COP_BT, COP_PSCRB, ECDIS_GENERIC
   - ENGINE officers typically need: COC, SIRB, PASSPORT, PEME, DRUG_TEST, COP_BT, COP_MECA, COP_MEFA
   - Both roles need: COC, SIRB, PASSPORT, PEME, DRUG_TEST, COP_BT

4. EXPIRY STATUS: Flag any documents that are expired or expiring within 90 days. Prioritize by severity (expired COC or PEME is CRITICAL; training certs expiring in 60 days is HIGH).

5. MEDICAL FITNESS: Assess overall medical readiness. Any UNFIT result, POSITIVE drug test, or critical restrictions must be flagged as CRITICAL.

6. CROSS-DOCUMENT COHERENCE: Flag any inconsistencies — mismatched names, suspicious date patterns, certificates from unrecognized authorities, limitations that conflict with claimed rank.

7. OVERALL SCORING: Score 0-100 where:
   - 90-100: All critical docs present and valid, no flags
   - 70-89: Minor gaps or warnings
   - 50-69: Some critical docs missing or expiring soon
   - Below 50: Expired critical docs, medical failure, or critical flags

Return ONLY a valid JSON object. No markdown. No code fences. No explanation outside the JSON.

{
  "holderProfile": {
    "fullName": "string or null",
    "dateOfBirth": "string or null",
    "sirbNumber": "string or null",
    "passportNumber": "string or null",
    "detectedRole": "DECK | ENGINE | BOTH | N/A | null"
  },
  "consistencyChecks": [
    {
      "field": "holderName | dateOfBirth | sirbNumber | passportNumber | role",
      "status": "PASS | FAIL | WARN",
      "message": "Explanation"
    }
  ],
  "missingDocuments": [
    {
      "documentType": "COC",
      "documentName": "Certificate of Competency",
      "severity": "CRITICAL | HIGH | MEDIUM",
      "reason": "Required for all licensed officers"
    }
  ],
  "expiringDocuments": [
    {
      "extractionId": "id from the document list index as string",
      "documentType": "string",
      "documentName": "string",
      "expiryDate": "string",
      "daysUntilExpiry": 0
    }
  ],
  "medicalFlags": [
    {
      "severity": "CRITICAL | HIGH | MEDIUM | LOW",
      "message": "string",
      "documentType": "PEME | DRUG_TEST | YELLOW_FEVER"
    }
  ],
  "overallStatus": "APPROVED | CONDITIONAL | REJECTED",
  "overallScore": 74,
  "summary": "2-3 sentence plain English summary for a Manning Agent decision-maker.",
  "recommendations": [
    "Action item 1",
    "Action item 2"
  ]
}

DECISION RULES:
- REJECTED: Any expired critical document (COC, SIRB, PEME), UNFIT medical result, POSITIVE drug test, or identity inconsistency
- CONDITIONAL: Missing non-critical documents, documents expiring within 90 days, unresolved MEDIUM flags
- APPROVED: All critical documents present and valid, no CRITICAL or HIGH flags, medical clearance confirmed`;
}

export async function runValidation(
  provider: LLMProvider,
  sessionId: string,
  extractions: ExtractionRecord[]
): Promise<ValidationResult> {
  if (extractions.length < 2) {
    throw new Error('INSUFFICIENT_DOCUMENTS');
  }

  const prompt = buildValidationPrompt(extractions);

  const response = await provider.complete(
    [{ role: 'user', content: prompt }],
    45000
  );

  // Try to parse
  let parsed: Partial<ValidationResult> | null = null;
  try {
    const { extractJsonFromText } = await import('./extraction');
    const jsonStr = extractJsonFromText(response.text);
    if (jsonStr) parsed = JSON.parse(jsonStr);
  } catch {
    // fall through
  }

  if (!parsed) {
    throw new Error('Failed to parse validation response from LLM');
  }

  const now = new Date().toISOString();

  // Map expiringDocuments: replace index references with real extraction IDs
  const expiringDocuments = (parsed.expiringDocuments || []).map((ed: {
    extractionId: string;
    documentType: DocumentType;
    documentName: string;
    expiryDate: string;
    daysUntilExpiry: number;
  }) => {
    const idx = parseInt(ed.extractionId, 10);
    const real = !isNaN(idx) && extractions[idx - 1] ? extractions[idx - 1].id : ed.extractionId;
    return { ...ed, extractionId: real };
  });

  return {
    sessionId,
    holderProfile: parsed.holderProfile || {
      fullName: null,
      dateOfBirth: null,
      sirbNumber: null,
      passportNumber: null,
      detectedRole: null,
    },
    consistencyChecks: parsed.consistencyChecks || [],
    missingDocuments: parsed.missingDocuments || [],
    expiringDocuments,
    medicalFlags: parsed.medicalFlags || [],
    overallStatus: parsed.overallStatus || 'CONDITIONAL',
    overallScore: parsed.overallScore ?? 0,
    summary: parsed.summary || '',
    recommendations: parsed.recommendations || [],
    validatedAt: now,
  };
}

// ─── Derive session health without LLM ───────────────────────────────────────

export function deriveSessionHealth(
  extractions: ExtractionRecord[]
): 'OK' | 'WARN' | 'CRITICAL' {
  const completed = extractions.filter(e => e.status === 'COMPLETE');

  const hasCritical = completed.some(
    e => e.isExpired || e.flags.some(f => f.severity === 'CRITICAL')
  );
  if (hasCritical) return 'CRITICAL';

  const hasWarn = completed.some(e => {
    const expiringSoon = e.validity?.daysUntilExpiry != null && e.validity.daysUntilExpiry <= 90;
    const hasHighFlag = e.flags.some(f => f.severity === 'HIGH' || f.severity === 'MEDIUM');
    return expiringSoon || hasHighFlag;
  });

  return hasWarn ? 'WARN' : 'OK';
}
