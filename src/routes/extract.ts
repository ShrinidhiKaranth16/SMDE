import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import {
  createSession, getSessionById, getExtractionByHash,
  insertExtraction, insertJob, getExtractionById, updateExtraction
} from "../db/index";
import { computeSHA256, runExtractionPipeline } from "../services/extraction";
import { queue } from "../services/queue";
import { createLLMProvider, PROMPT_VERSION } from '../services/llmProvider';
import { ExtractionRecord } from "../types/index";
import { rateLimiter } from "../middlewear/rateLimiter";
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('UNSUPPORTED_FORMAT'));
    }
  },
});

router.post(
  '/extract',
  rateLimiter,
  (req: Request, res: Response, next) => {
    upload.single('document')(req, res, (err) => {
      if (err) {
        if (err.message === 'UNSUPPORTED_FORMAT') {
          res.status(400).json({ error: 'UNSUPPORTED_FORMAT', message: 'File type not accepted. Use image/jpeg, image/png, or application/pdf.' });
        } else if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'FILE_TOO_LARGE', message: 'File exceeds 10MB limit.' });
        } else {
          next(err);
        }
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'UNSUPPORTED_FORMAT', message: 'No file uploaded.' });
      return;
    }

    const mode = (req.query.mode as string) || 'sync';
    const webhookUrl = req.body.webhookUrl as string | undefined;

    // ── Resolve or create session ──
    let sessionId = req.body.sessionId as string | undefined;
    if (sessionId) {
      const session = getSessionById(sessionId);
      if (!session) {
        res.status(404).json({ error: 'SESSION_NOT_FOUND', message: `Session ${sessionId} does not exist.` });
        return;
      }
    } else {
      sessionId = uuidv4();
      createSession(sessionId);
    }

    // ── Deduplication ──
    const fileHash = computeSHA256(file.buffer);
    const existing = getExtractionByHash(fileHash, sessionId);
    if (existing) {
      res.setHeader('X-Deduplicated', 'true');
      res.status(200).json(formatExtractionResponse(existing));
      return;
    }

    const extractionId = uuidv4();
    const now = new Date().toISOString();

    const stub: ExtractionRecord = {
      id: extractionId,
      sessionId,
      fileName: file.originalname,
      fileHash,
      documentType: null,
      documentName: null,
      applicableRole: null,
      category: null,
      confidence: null,
      holderName: null,
      dateOfBirth: null,
      sirbNumber: null,
      passportNumber: null,
      fields: [],
      validity: null,
      medicalData: null,
      compliance: null,
      flags: [],
      isExpired: false,
      summary: null,
      rawLlmResponse: null,
      processingTimeMs: null,
      status: 'PROCESSING',
      promptVersion: PROMPT_VERSION,
      createdAt: now,
    };
    insertExtraction(stub);

    // ── Async mode ──
    if (mode === 'async') {
      const jobId = uuidv4();
      insertJob({
        id: jobId,
        sessionId,
        extractionId,
        status: 'QUEUED',
        errorCode: null,
        errorMessage: null,
        webhookUrl: webhookUrl || null,
        queuedAt: now,
        startedAt: null,
        completedAt: null,
      });

      queue.enqueue({
        jobId,
        sessionId,
        extractionId,
        fileBuffer: file.buffer,
        mimeType: file.mimetype,
        fileName: file.originalname,
      });

      res.status(202).json({
        jobId,
        sessionId,
        status: 'QUEUED',
        pollUrl: `/api/jobs/${jobId}`,
        estimatedWaitMs: 6000,
      });
      return;
    }

    // ── Sync mode ──
    const startTime = Date.now();
    const provider = createLLMProvider();

    try {
      const pipelineResult = await runExtractionPipeline(
        provider,
        file.buffer,
        file.mimetype,
        file.originalname
      );
      const processingTimeMs = Date.now() - startTime;

      if (pipelineResult.failed || !pipelineResult.result) {
        updateExtraction(extractionId, {
          status: 'FAILED',
          rawLlmResponse: pipelineResult.rawLlmResponse,
          processingTimeMs,
        });
        res.status(422).json({
          error: 'LLM_JSON_PARSE_FAIL',
          message: 'Document extraction failed after retry. The raw response has been stored for review.',
          extractionId,
          retryAfterMs: null,
        });
        return;
      }

      const llm = pipelineResult.result;

      updateExtraction(extractionId, {
        status: 'COMPLETE',
        documentType: llm.detection.documentType,
        documentName: llm.detection.documentName,
        applicableRole: llm.detection.applicableRole,
        category: llm.detection.category,
        confidence: llm.detection.confidence,
        holderName: llm.holder.fullName,
        dateOfBirth: llm.holder.dateOfBirth,
        sirbNumber: llm.holder.sirbNumber,
        passportNumber: llm.holder.passportNumber,
        fields: llm.fields,
        validity: llm.validity,
        medicalData: llm.medicalData,
        compliance: llm.compliance,
        flags: llm.flags,
        isExpired: llm.validity?.isExpired ?? false,
        summary: llm.summary,
        rawLlmResponse: pipelineResult.rawLlmResponse,
        processingTimeMs,
      });

      const final = getExtractionById(extractionId)!;
      res.status(200).json(formatExtractionResponse(final));
    } catch (err) {
      const processingTimeMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      updateExtraction(extractionId, {
        status: 'FAILED',
        rawLlmResponse: message,
        processingTimeMs,
      });
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Unexpected server error during extraction.',
        extractionId,
        retryAfterMs: null,
      });
    }
  }
);

function formatExtractionResponse(e: ExtractionRecord): Record<string, unknown> {
  return {
    id: e.id,
    sessionId: e.sessionId,
    fileName: e.fileName,
    documentType: e.documentType,
    documentName: e.documentName,
    applicableRole: e.applicableRole,
    category: e.category,
    confidence: e.confidence,
    holderName: e.holderName,
    dateOfBirth: e.dateOfBirth,
    sirbNumber: e.sirbNumber,
    passportNumber: e.passportNumber,
    fields: e.fields,
    validity: e.validity,
    compliance: e.compliance,
    medicalData: e.medicalData,
    flags: e.flags,
    isExpired: e.isExpired,
    processingTimeMs: e.processingTimeMs,
    summary: e.summary,
    promptVersion: e.promptVersion,
    createdAt: e.createdAt,
  };
}

export default router;