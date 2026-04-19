import request from 'supertest';
import fs from 'fs';
import { createApp } from "../index";

const app = createApp();
// Set up test environment
process.env.NODE_ENV = 'test';
process.env.DB_PATH = './data/test.db';
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';
process.env.LLM_API_KEY = 'test-key';

// ── Mock the LLM provider so tests don't hit real APIs ───────────────────────

const MOCK_EXTRACTION = {
  detection: {
    documentType: 'PEME',
    documentName: 'Pre-Employment Medical Examination',
    category: 'MEDICAL',
    applicableRole: 'ENGINE',
    isRequired: true,
    confidence: 'HIGH',
    detectionReason: 'Document header indicates PEME examination.',
  },
  holder: {
    fullName: 'Samuel P. Samoya',
    dateOfBirth: '12/03/1988',
    nationality: 'Filipino',
    passportNumber: null,
    sirbNumber: 'C0869326',
    rank: 'Chief Engineer',
    photo: 'PRESENT',
  },
  fields: [
    { key: 'certificate_number', label: 'Certificate Number', value: 'PEME-2025-001', importance: 'CRITICAL', status: 'OK' },
    { key: 'issuing_clinic', label: 'Issuing Clinic', value: 'Maritime Medical Center', importance: 'HIGH', status: 'OK' },
  ],
  validity: {
    dateOfIssue: '06/01/2025',
    dateOfExpiry: '06/01/2027',
    isExpired: false,
    daysUntilExpiry: 400,
    revalidationRequired: false,
  },
  compliance: {
    issuingAuthority: 'MARINA',
    regulationReference: 'STCW Reg I/9',
    imoModelCourse: null,
    recognizedAuthority: true,
    limitations: null,
  },
  medicalData: {
    fitnessResult: 'FIT',
    drugTestResult: 'NEGATIVE',
    restrictions: null,
    specialNotes: null,
    expiryDate: '06/01/2027',
  },
  flags: [],
  summary: 'This PEME confirms the holder is medically fit with no restrictions.',
};

jest.mock('../services/llmProvider', () => ({
  createLLMProvider: () => ({
    complete: async () => ({ text: JSON.stringify(MOCK_EXTRACTION), rawResponse: {} }),
  }),
  checkLLMHealth: async () => true,
  PROMPT_VERSION: 'v1',
}));


// ── Test helpers ──────────────────────────────────────────────────────────────

function makeFakeFile(content = 'fake document content', name = 'test.jpg'): Buffer {
  return Buffer.from(content);
}

// ── Health endpoint ───────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  test('returns 200 with OK status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.body.dependencies).toBeDefined();
    expect(res.body.dependencies.database).toBe('OK');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });
});

// ── Extract endpoint — sync mode ──────────────────────────────────────────────

describe('POST /api/extract (sync)', () => {
  test('returns 200 with extraction result for valid image', async () => {
    const res = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', makeFakeFile(), { filename: 'PEME_test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.sessionId).toBeDefined();
    expect(res.body.documentType).toBe('PEME');
    expect(res.body.holderName).toBe('Samuel P. Samoya');
    expect(res.body.confidence).toBe('HIGH');
  });

  test('creates a new session when sessionId is not provided', async () => {
    const res = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', makeFakeFile('unique content 1'), { filename: 'doc.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeDefined();
    expect(typeof res.body.sessionId).toBe('string');
  });

  test('uses provided sessionId if it exists', async () => {
    // First create a session via an extraction
    const first = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', makeFakeFile('doc for session'), { filename: 'first.jpg', contentType: 'image/jpeg' });

    const sessionId = first.body.sessionId;

    const second = await request(app)
      .post('/api/extract?mode=sync')
      .field('sessionId', sessionId)
      .attach('document', makeFakeFile('another doc'), { filename: 'second.jpg', contentType: 'image/jpeg' });

    expect(second.status).toBe(200);
    expect(second.body.sessionId).toBe(sessionId);
  });

  test('returns 404 when sessionId does not exist', async () => {
    const res = await request(app)
      .post('/api/extract?mode=sync')
      .field('sessionId', 'nonexistent-session-id-xyz')
      .attach('document', makeFakeFile(), { filename: 'doc.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SESSION_NOT_FOUND');
  });

  test('returns 400 for unsupported file type', async () => {
    const res = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', makeFakeFile(), { filename: 'doc.gif', contentType: 'image/gif' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_FORMAT');
  });

  test('returns 400 when no file uploaded', async () => {
    const res = await request(app).post('/api/extract?mode=sync');
    expect(res.status).toBe(400);
  });

  test('deduplicates same file in same session', async () => {
    const content = `dedup-test-${Date.now()}`;

    const first = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', Buffer.from(content), { filename: 'original.jpg', contentType: 'image/jpeg' });

    expect(first.status).toBe(200);
    const sessionId = first.body.sessionId;

    const second = await request(app)
      .post('/api/extract?mode=sync')
      .field('sessionId', sessionId)
      .attach('document', Buffer.from(content), { filename: 'original.jpg', contentType: 'image/jpeg' });

    expect(second.status).toBe(200);
    expect(second.headers['x-deduplicated']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
  });

  test('does NOT deduplicate same file in different sessions', async () => {
    const content = `cross-session-${Date.now()}`;

    const first = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', Buffer.from(content), { filename: 'doc.jpg', contentType: 'image/jpeg' });

    const second = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', Buffer.from(content), { filename: 'doc.jpg', contentType: 'image/jpeg' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Different sessions → different extraction IDs
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.headers['x-deduplicated']).toBeUndefined();
  });
});

// ── Extract endpoint — async mode ─────────────────────────────────────────────

describe('POST /api/extract (async)', () => {
  test('returns 202 with jobId and pollUrl', async () => {
    const res = await request(app)
      .post('/api/extract?mode=async')
      .attach('document', makeFakeFile('async doc'), { filename: 'async.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeDefined();
    expect(res.body.sessionId).toBeDefined();
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.pollUrl).toMatch(/^\/api\/jobs\//);
  });
});

// ── Jobs endpoint ─────────────────────────────────────────────────────────────

describe('GET /api/jobs/:jobId', () => {
  test('returns 404 for unknown job', async () => {
    const res = await request(app).get('/api/jobs/nonexistent-job-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('JOB_NOT_FOUND');
  });

  test('returns job status for known queued job', async () => {
    const create = await request(app)
      .post('/api/extract?mode=async')
      .attach('document', makeFakeFile(`job-poll-${Date.now()}`), { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(create.status).toBe(202);
    const { jobId } = create.body;

    const poll = await request(app).get(`/api/jobs/${jobId}`);
    expect(poll.status).toBe(200);
    // Job might be QUEUED, PROCESSING, or COMPLETE by the time we poll
    expect(['QUEUED', 'PROCESSING', 'COMPLETE', 'FAILED']).toContain(poll.body.status);
  });
});

// ── Sessions endpoint ─────────────────────────────────────────────────────────

describe('GET /api/sessions/:sessionId', () => {
  test('returns 404 for unknown session', async () => {
    const res = await request(app).get('/api/sessions/nonexistent-session');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SESSION_NOT_FOUND');
  });

  test('returns session summary with documents', async () => {
    const extract = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', makeFakeFile(`session-docs-${Date.now()}`), { filename: 'test.jpg', contentType: 'image/jpeg' });

    const { sessionId } = extract.body;
    const res = await request(app).get(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.documentCount).toBe(1);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.overallHealth).toBeDefined();
  });
});

// ── Validate endpoint ─────────────────────────────────────────────────────────

describe('POST /api/sessions/:sessionId/validate', () => {
  test('returns 400 when fewer than 2 documents', async () => {
    const extract = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', makeFakeFile(`validate-single-${Date.now()}`), { filename: 'test.jpg', contentType: 'image/jpeg' });

    const { sessionId } = extract.body;
    const res = await request(app).post(`/api/sessions/${sessionId}/validate`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INSUFFICIENT_DOCUMENTS');
  });

  test('returns 404 for unknown session', async () => {
    const res = await request(app).post('/api/sessions/nonexistent/validate');
    expect(res.status).toBe(404);
  });
});

// ── Report endpoint ───────────────────────────────────────────────────────────

describe('GET /api/sessions/:sessionId/report', () => {
  test('returns 404 for unknown session', async () => {
    const res = await request(app).get('/api/sessions/nonexistent/report');
    expect(res.status).toBe(404);
  });

  test('returns report for valid session', async () => {
    const extract = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', makeFakeFile(`report-test-${Date.now()}`), { filename: 'test.jpg', contentType: 'image/jpeg' });

    const { sessionId } = extract.body;
    const res = await request(app).get(`/api/sessions/${sessionId}/report`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.overallDecision).toBe('PENDING_VALIDATION');
    expect(res.body.documentSummary).toBeDefined();
    expect(res.body.documents).toBeDefined();
    expect(Array.isArray(res.body.documents)).toBe(true);
  });
});

// ── Expiring documents endpoint ───────────────────────────────────────────────

describe('GET /api/sessions/:sessionId/expiring', () => {
  test('returns 404 for unknown session', async () => {
    const res = await request(app).get('/api/sessions/nonexistent/expiring');
    expect(res.status).toBe(404);
  });

  test('returns expiring documents list', async () => {
    const extract = await request(app)
      .post('/api/extract?mode=sync')
      .attach('document', makeFakeFile(`expiry-${Date.now()}`), { filename: 'test.jpg', contentType: 'image/jpeg' });

    const { sessionId } = extract.body;
    const res = await request(app).get(`/api/sessions/${sessionId}/expiring?withinDays=90`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.withinDays).toBe(90);
    expect(Array.isArray(res.body.documents)).toBe(true);
  });
});

// ─── Error shape validation ───────────────────────────────────────────────────

describe('Error response shape', () => {
  test('all 404 errors have consistent shape', async () => {
    const routes = [
      '/api/sessions/fake-id',
      '/api/jobs/fake-id',
    ];

    for (const route of routes) {
      const res = await request(app).get(route);
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.message).toBeDefined();
    }
  });
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

afterAll(() => {
  // Clean up test DB
  const dbPath = process.env.DB_PATH || './data/test.db';
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  } catch {
    // ignore
  }
});
