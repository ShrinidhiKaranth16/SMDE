import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { ExtractionRecord, Job, Session, JobStatus, ValidationResult } from "../types";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DB_PATH || './data/smde.db';
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS extractions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      document_type TEXT,
      document_name TEXT,
      applicable_role TEXT,
      category TEXT,
      confidence TEXT,
      holder_name TEXT,
      date_of_birth TEXT,
      sirb_number TEXT,
      passport_number TEXT,
      fields_json TEXT NOT NULL DEFAULT '[]',
      validity_json TEXT,
      medical_data_json TEXT,
      compliance_json TEXT,
      flags_json TEXT NOT NULL DEFAULT '[]',
      is_expired INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      raw_llm_response TEXT,
      processing_time_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'COMPLETE',
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      extraction_id TEXT REFERENCES extractions(id),
      status TEXT NOT NULL DEFAULT 'QUEUED',
      error_code TEXT,
      error_message TEXT,
      webhook_url TEXT,
      queued_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS validations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_extractions_session ON extractions(session_id);
    CREATE INDEX IF NOT EXISTS idx_extractions_hash ON extractions(file_hash, session_id);
    CREATE INDEX IF NOT EXISTS idx_extractions_doc_type ON extractions(document_type);
    CREATE INDEX IF NOT EXISTS idx_extractions_is_expired ON extractions(is_expired);
    CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_validations_session ON validations(session_id);
  `);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export function createSession(id: string): Session {
  const db = getDb();
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id);
  return getSessionById(id)!;
}

export function getSessionById(id: string): Session | null {
  const db = getDb();
  const row = db.prepare('SELECT id, created_at FROM sessions WHERE id = ?').get(id) as
    | { id: string; created_at: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, createdAt: row.created_at };
}

// ─── Extractions ──────────────────────────────────────────────────────────────

interface ExtractionRow {
  id: string;
  session_id: string;
  file_name: string;
  file_hash: string;
  document_type: string | null;
  document_name: string | null;
  applicable_role: string | null;
  category: string | null;
  confidence: string | null;
  holder_name: string | null;
  date_of_birth: string | null;
  sirb_number: string | null;
  passport_number: string | null;
  fields_json: string;
  validity_json: string | null;
  medical_data_json: string | null;
  compliance_json: string | null;
  flags_json: string;
  is_expired: number;
  summary: string | null;
  raw_llm_response: string | null;
  processing_time_ms: number | null;
  status: string;
  prompt_version: string;
  created_at: string;
}

function rowToExtraction(row: ExtractionRow): ExtractionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    fileName: row.file_name,
    fileHash: row.file_hash,
    documentType: row.document_type as ExtractionRecord['documentType'],
    documentName: row.document_name,
    applicableRole: row.applicable_role as ExtractionRecord['applicableRole'],
    category: row.category as ExtractionRecord['category'],
    confidence: row.confidence as ExtractionRecord['confidence'],
    holderName: row.holder_name,
    dateOfBirth: row.date_of_birth,
    sirbNumber: row.sirb_number,
    passportNumber: row.passport_number,
    fields: JSON.parse(row.fields_json),
    validity: row.validity_json ? JSON.parse(row.validity_json) : null,
    medicalData: row.medical_data_json ? JSON.parse(row.medical_data_json) : null,
    compliance: row.compliance_json ? JSON.parse(row.compliance_json) : null,
    flags: JSON.parse(row.flags_json),
    isExpired: row.is_expired === 1,
    summary: row.summary,
    rawLlmResponse: row.raw_llm_response,
    processingTimeMs: row.processing_time_ms,
    status: row.status as ExtractionRecord['status'],
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

export function insertExtraction(record: ExtractionRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO extractions (
      id, session_id, file_name, file_hash, document_type, document_name,
      applicable_role, category, confidence, holder_name, date_of_birth,
      sirb_number, passport_number, fields_json, validity_json,
      medical_data_json, compliance_json, flags_json, is_expired, summary,
      raw_llm_response, processing_time_ms, status, prompt_version, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    record.id,
    record.sessionId,
    record.fileName,
    record.fileHash,
    record.documentType,
    record.documentName,
    record.applicableRole,
    record.category,
    record.confidence,
    record.holderName,
    record.dateOfBirth,
    record.sirbNumber,
    record.passportNumber,
    JSON.stringify(record.fields),
    record.validity ? JSON.stringify(record.validity) : null,
    record.medicalData ? JSON.stringify(record.medicalData) : null,
    record.compliance ? JSON.stringify(record.compliance) : null,
    JSON.stringify(record.flags),
    record.isExpired ? 1 : 0,
    record.summary,
    record.rawLlmResponse,
    record.processingTimeMs,
    record.status,
    record.promptVersion,
    record.createdAt,
  );
}

export function updateExtraction(id: string, updates: Partial<ExtractionRecord>): void {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.documentType !== undefined) { sets.push('document_type = ?'); vals.push(updates.documentType); }
  if (updates.documentName !== undefined) { sets.push('document_name = ?'); vals.push(updates.documentName); }
  if (updates.applicableRole !== undefined) { sets.push('applicable_role = ?'); vals.push(updates.applicableRole); }
  if (updates.category !== undefined) { sets.push('category = ?'); vals.push(updates.category); }
  if (updates.confidence !== undefined) { sets.push('confidence = ?'); vals.push(updates.confidence); }
  if (updates.holderName !== undefined) { sets.push('holder_name = ?'); vals.push(updates.holderName); }
  if (updates.dateOfBirth !== undefined) { sets.push('date_of_birth = ?'); vals.push(updates.dateOfBirth); }
  if (updates.sirbNumber !== undefined) { sets.push('sirb_number = ?'); vals.push(updates.sirbNumber); }
  if (updates.passportNumber !== undefined) { sets.push('passport_number = ?'); vals.push(updates.passportNumber); }
  if (updates.fields !== undefined) { sets.push('fields_json = ?'); vals.push(JSON.stringify(updates.fields)); }
  if (updates.validity !== undefined) { sets.push('validity_json = ?'); vals.push(JSON.stringify(updates.validity)); }
  if (updates.medicalData !== undefined) { sets.push('medical_data_json = ?'); vals.push(JSON.stringify(updates.medicalData)); }
  if (updates.compliance !== undefined) { sets.push('compliance_json = ?'); vals.push(JSON.stringify(updates.compliance)); }
  if (updates.flags !== undefined) { sets.push('flags_json = ?'); vals.push(JSON.stringify(updates.flags)); }
  if (updates.isExpired !== undefined) { sets.push('is_expired = ?'); vals.push(updates.isExpired ? 1 : 0); }
  if (updates.summary !== undefined) { sets.push('summary = ?'); vals.push(updates.summary); }
  if (updates.rawLlmResponse !== undefined) { sets.push('raw_llm_response = ?'); vals.push(updates.rawLlmResponse); }
  if (updates.processingTimeMs !== undefined) { sets.push('processing_time_ms = ?'); vals.push(updates.processingTimeMs); }

  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE extractions SET ${sets.join(', ')} WHERE id = ?`).run(vals as string[]);
}

export function getExtractionById(id: string): ExtractionRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM extractions WHERE id = ?').get(id) as ExtractionRow | undefined;
  return row ? rowToExtraction(row) : null;
}

export function getExtractionByHash(fileHash: string, sessionId: string): ExtractionRecord | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM extractions WHERE file_hash = ? AND session_id = ? AND status = ? LIMIT 1'
  ).get(fileHash, sessionId, 'COMPLETE') as ExtractionRow | undefined;
  return row ? rowToExtraction(row) : null;
}

export function getExtractionsBySession(sessionId: string): ExtractionRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM extractions WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as ExtractionRow[];
  return rows.map(rowToExtraction);
}

export function getExpiringDocuments(sessionId: string, withinDays: number): ExtractionRecord[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM extractions WHERE session_id = ? AND status = ? AND is_expired = 0 ORDER BY created_at ASC'
  ).all(sessionId, 'COMPLETE') as ExtractionRow[];

  return rows
    .map(rowToExtraction)
    .filter(r => {
      if (!r.validity) return false;
      const days = r.validity.daysUntilExpiry;
      return days !== null && days >= 0 && days <= withinDays;
    })
    .sort((a, b) => (a.validity?.daysUntilExpiry ?? 9999) - (b.validity?.daysUntilExpiry ?? 9999));
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  session_id: string;
  extraction_id: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  webhook_url: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    sessionId: row.session_id,
    extractionId: row.extraction_id,
    status: row.status as JobStatus,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    webhookUrl: row.webhook_url,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function insertJob(job: Job): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO jobs (id, session_id, extraction_id, status, webhook_url, queued_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(job.id, job.sessionId, job.extractionId, job.status, job.webhookUrl, job.queuedAt);
}

export function updateJob(id: string, updates: Partial<Job>): void {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.extractionId !== undefined) { sets.push('extraction_id = ?'); vals.push(updates.extractionId); }
  if (updates.errorCode !== undefined) { sets.push('error_code = ?'); vals.push(updates.errorCode); }
  if (updates.errorMessage !== undefined) { sets.push('error_message = ?'); vals.push(updates.errorMessage); }
  if (updates.startedAt !== undefined) { sets.push('started_at = ?'); vals.push(updates.startedAt); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); vals.push(updates.completedAt); }

  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(vals as string[]);
}

export function getJobById(id: string): Job | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function getPendingJobs(sessionId: string): Job[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM jobs WHERE session_id = ? AND status IN ('QUEUED', 'PROCESSING') ORDER BY queued_at ASC"
  ).all(sessionId) as JobRow[];
  return rows.map(rowToJob);
}

export function getQueuePosition(jobId: string): number {
  const db = getDb();
  const result = db.prepare(
    "SELECT COUNT(*) as cnt FROM jobs WHERE status = 'QUEUED' AND queued_at <= (SELECT queued_at FROM jobs WHERE id = ?)"
  ).get(jobId) as { cnt: number };
  return result.cnt;
}

// ─── Validations ──────────────────────────────────────────────────────────────

export function insertValidation(id: string, sessionId: string, result: ValidationResult): void {
  const db = getDb();
  db.prepare('INSERT INTO validations (id, session_id, result_json) VALUES (?, ?, ?)').run(
    id, sessionId, JSON.stringify(result)
  );
}

export function getLatestValidation(sessionId: string): ValidationResult | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT result_json FROM validations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(sessionId) as { result_json: string } | undefined;
  return row ? JSON.parse(row.result_json) : null;
}

export function getLatestValidationWithDate(sessionId: string): { result: ValidationResult; createdAt: string } | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT result_json, created_at FROM validations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(sessionId) as { result_json: string; created_at: string } | undefined;
  return row ? { result: JSON.parse(row.result_json), createdAt: row.created_at } : null;
}

export function checkDbHealth(): boolean {
  try {
    getDb().prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}