import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { getDb, getJobById, updateJob, insertExtraction, updateExtraction, getExtractionById } from '../db/index';
import { createLLMProvider } from './llmProvider';
import { runExtractionPipeline, computeSHA256, EXTRACTION_PROMPT } from './extraction';
import { Job, ExtractionRecord } from "../types/index"
import { deliverWebhook } from "../webhook"

export interface QueueTask {
  jobId: string;
  sessionId: string;
  extractionId: string;
  fileBuffer: Buffer;
  mimeType: string;
  fileName: string;
}

class ExtractionQueue extends EventEmitter {
  private queue: QueueTask[] = [];
  private processing = false;
  private concurrency = 3;
  private activeCount = 0;

  enqueue(task: QueueTask): void {
    this.queue.push(task);
    this.drain();
  }

  private drain(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.activeCount++;
      this.processTask(task).finally(() => {
        this.activeCount--;
        this.drain();
      });
    }
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isHealthy(): boolean {
    return true; // In-process queue is always alive if the process is alive
  }

  private async processTask(task: QueueTask): Promise<void> {
    const { jobId, extractionId, fileBuffer, mimeType, fileName } = task;

    updateJob(jobId, { status: 'PROCESSING', startedAt: new Date().toISOString() });
    updateExtraction(extractionId, { status: 'PROCESSING' });

    const startTime = Date.now();
    const provider = createLLMProvider();

    try {
      const pipelineResult = await runExtractionPipeline(provider, fileBuffer, mimeType, fileName);
      const processingTimeMs = Date.now() - startTime;

      if (pipelineResult.failed || !pipelineResult.result) {
        updateExtraction(extractionId, {
          status: 'FAILED',
          rawLlmResponse: pipelineResult.rawLlmResponse,
          processingTimeMs,
        });
        updateJob(jobId, {
          status: 'FAILED',
          errorCode: 'LLM_JSON_PARSE_FAIL',
          errorMessage: pipelineResult.failReason || 'LLM returned unparseable response',
          completedAt: new Date().toISOString(),
        });
        return;
      }

      const llm = pipelineResult.result;
      const now = new Date().toISOString();

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

      updateJob(jobId, {
        status: 'COMPLETE',
        extractionId,
        completedAt: now,
      });

      // Fire webhook if configured
      const job = getJobById(jobId);
      if (job?.webhookUrl) {
        const extraction = getExtractionById(extractionId);
        if (extraction) {
          deliverWebhook(job.webhookUrl, { jobId, status: 'COMPLETE', extraction }).catch(() => {
            // Webhook failure is non-fatal
          });
        }
      }
    } catch (err) {
      const processingTimeMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      updateExtraction(extractionId, {
        status: 'FAILED',
        rawLlmResponse: message,
        processingTimeMs,
      });

      updateJob(jobId, {
        status: 'FAILED',
        errorCode: 'INTERNAL_ERROR',
        errorMessage: message,
        completedAt: new Date().toISOString(),
      });
    }
  }
}

export const queue = new ExtractionQueue();

// On startup, recover any jobs that were stuck in PROCESSING state
// (process restart while jobs were active). Mark them retryable/FAILED.
export function recoverStalledJobs(): void {
  const db = getDb();
  const stalled = db.prepare(
    "SELECT id FROM jobs WHERE status = 'PROCESSING'"
  ).all() as { id: string }[];

  for (const { id } of stalled) {
    updateJob(id, {
      status: 'FAILED',
      errorCode: 'INTERNAL_ERROR',
      errorMessage: 'Service restarted while job was processing',
      completedAt: new Date().toISOString(),
    });
  }

  if (stalled.length > 0) {
    console.log(`[queue] Recovered ${stalled.length} stalled job(s) on startup`);
  }
}
