// ─── Document taxonomy ───────────────────────────────────────────────────────

export type DocumentType =
  | 'COC' | 'COP_BT' | 'COP_PSCRB' | 'COP_AFF' | 'COP_MEFA' | 'COP_MECA'
  | 'COP_SSO' | 'COP_SDSD' | 'ECDIS_GENERIC' | 'ECDIS_TYPE' | 'SIRB'
  | 'PASSPORT' | 'PEME' | 'DRUG_TEST' | 'YELLOW_FEVER' | 'ERM' | 'MARPOL'
  | 'SULPHUR_CAP' | 'BALLAST_WATER' | 'HATCH_COVER' | 'BRM_SSBT'
  | 'TRAIN_TRAINER' | 'HAZMAT' | 'FLAG_STATE' | 'OTHER';

export type DocumentCategory =
  | 'IDENTITY' | 'CERTIFICATION' | 'STCW_ENDORSEMENT'
  | 'MEDICAL' | 'TRAINING' | 'FLAG_STATE' | 'OTHER';

export type ApplicableRole = 'DECK' | 'ENGINE' | 'BOTH' | 'N/A';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type FieldStatus = 'OK' | 'EXPIRED' | 'WARNING' | 'MISSING' | 'N/A';
export type FieldImportance = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type FlagSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type FitnessResult = 'FIT' | 'UNFIT' | 'N/A';
export type DrugTestResult = 'NEGATIVE' | 'POSITIVE' | 'N/A';
export type PhotoStatus = 'PRESENT' | 'ABSENT';

// ─── LLM extraction response shape ──────────────────────────────────────────

export interface ExtractedField {
  key: string;
  label: string;
  value: string;
  importance: FieldImportance;
  status: FieldStatus;
}

export interface ValidityInfo {
  dateOfIssue: string | null;
  dateOfExpiry: string | 'No Expiry' | 'Lifetime' | null;
  isExpired: boolean;
  daysUntilExpiry: number | null;
  revalidationRequired: boolean | null;
}

export interface ComplianceInfo {
  issuingAuthority: string;
  regulationReference: string | null;
  imoModelCourse: string | null;
  recognizedAuthority: boolean;
  limitations: string | null;
}

export interface MedicalData {
  fitnessResult: FitnessResult;
  drugTestResult: DrugTestResult;
  restrictions: string | null;
  specialNotes: string | null;
  expiryDate: string | null;
}

export interface DocumentFlag {
  severity: FlagSeverity;
  message: string;
}

export interface HolderInfo {
  fullName: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  passportNumber: string | null;
  sirbNumber: string | null;
  rank: string | null;
  photo: PhotoStatus;
}

export interface DetectionInfo {
  documentType: DocumentType;
  documentName: string;
  category: DocumentCategory;
  applicableRole: ApplicableRole;
  isRequired: boolean;
  confidence: Confidence;
  detectionReason: string;
}

export interface LLMExtractionResult {
  detection: DetectionInfo;
  holder: HolderInfo;
  fields: ExtractedField[];
  validity: ValidityInfo;
  compliance: ComplianceInfo;
  medicalData: MedicalData;
  flags: DocumentFlag[];
  summary: string;
}

// ─── API response shapes ─────────────────────────────────────────────────────

export interface ExtractionRecord {
  id: string;
  sessionId: string;
  fileName: string;
  fileHash: string;
  documentType: DocumentType | null;
  documentName: string | null;
  applicableRole: ApplicableRole | null;
  category: DocumentCategory | null;
  confidence: Confidence | null;
  holderName: string | null;
  dateOfBirth: string | null;
  sirbNumber: string | null;
  passportNumber: string | null;
  fields: ExtractedField[];
  validity: ValidityInfo | null;
  medicalData: MedicalData | null;
  compliance: ComplianceInfo | null;
  flags: DocumentFlag[];
  isExpired: boolean;
  summary: string | null;
  rawLlmResponse: string | null;
  processingTimeMs: number | null;
  status: 'COMPLETE' | 'FAILED' | 'PROCESSING';
  promptVersion: string;
  createdAt: string;
}

export type JobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETE' | 'FAILED';

export interface Job {
  id: string;
  sessionId: string;
  extractionId: string | null;
  status: JobStatus;
  errorCode: string | null;
  errorMessage: string | null;
  webhookUrl: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Session {
  id: string;
  createdAt: string;
}

// ─── API error shape ──────────────────────────────────────────────────────────

export type ErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'INSUFFICIENT_DOCUMENTS'
  | 'FILE_TOO_LARGE'
  | 'SESSION_NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'LLM_JSON_PARSE_FAIL'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'INVALID_JOB_STATE';

export interface ApiError {
  error: ErrorCode;
  message: string;
  extractionId?: string;
  retryAfterMs?: number | null;
}

// ─── LLM provider abstraction ─────────────────────────────────────────────────

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | LLMContentPart[];
}

export interface LLMContentPart {
  type: 'text' | 'image';
  text?: string;
  imageBase64?: string;
  mimeType?: string;
}

export interface LLMResponse {
  text: string;
  rawResponse: unknown;
}

export interface LLMProvider {
  complete(messages: LLMMessage[], timeoutMs?: number): Promise<LLMResponse>;
}

// ─── Validation result ────────────────────────────────────────────────────────

export interface ConsistencyCheck {
  field: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  message: string;
}

export interface MissingDocument {
  documentType: DocumentType;
  documentName: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  reason: string;
}

export interface ExpiringDocument {
  extractionId: string;
  documentType: DocumentType;
  documentName: string;
  expiryDate: string;
  daysUntilExpiry: number;
}

export interface MedicalFlag {
  severity: FlagSeverity;
  message: string;
  documentType: DocumentType;
}

export interface ValidationResult {
  sessionId: string;
  holderProfile: {
    fullName: string | null;
    dateOfBirth: string | null;
    sirbNumber: string | null;
    passportNumber: string | null;
    detectedRole: ApplicableRole | null;
  };
  consistencyChecks: ConsistencyCheck[];
  missingDocuments: MissingDocument[];
  expiringDocuments: ExpiringDocument[];
  medicalFlags: MedicalFlag[];
  overallStatus: 'APPROVED' | 'CONDITIONAL' | 'REJECTED';
  overallScore: number;
  summary: string;
  recommendations: string[];
  validatedAt: string;
}

// ─── Report shape ─────────────────────────────────────────────────────────────

export interface ReportDocument {
  id: string;
  fileName: string;
  documentType: DocumentType | null;
  documentName: string | null;
  category: DocumentCategory | null;
  applicableRole: ApplicableRole | null;
  confidence: Confidence | null;
  holderName: string | null;
  isExpired: boolean;
  daysUntilExpiry: number | null;
  expiryDate: string | null;
  flags: DocumentFlag[];
  criticalFlagCount: number;
  status: 'OK' | 'WARN' | 'CRITICAL' | 'EXPIRED';
  createdAt: string;
}

export interface ComplianceReport {
  sessionId: string;
  generatedAt: string;
  holderProfile: ValidationResult['holderProfile'] | null;
  overallDecision: 'APPROVED' | 'CONDITIONAL' | 'REJECTED' | 'PENDING_VALIDATION';
  overallScore: number | null;
  overallHealth: 'OK' | 'WARN' | 'CRITICAL';
  documentSummary: {
    total: number;
    expired: number;
    expiringSoon: number;
    withCriticalFlags: number;
    byCategory: Record<string, number>;
  };
  documents: ReportDocument[];
  criticalIssues: Array<{ source: string; message: string }>;
  warnings: Array<{ source: string; message: string }>;
  missingDocuments: MissingDocument[];
  recommendations: string[];
  lastValidatedAt: string | null;
}
