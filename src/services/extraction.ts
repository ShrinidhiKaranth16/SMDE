import { createHash } from 'crypto';

import { LLMExtractionResult, LLMProvider, LLMMessage } from '../types';

async function extractPdfText(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const PDFParser = require('pdf2json');
    const pdfParser = new PDFParser();

    pdfParser.on('pdfParser_dataError', (err: any) => {
      reject(new Error(err.parserError));
    });

    pdfParser.on('pdfParser_dataReady', (pdfData: any) => {
      try {
        const safeDecode = (str: string) => {
          try {
            return decodeURIComponent(str);
          } catch {
            return str; // return raw string if decode fails
          }
        };

        const text = pdfData.Pages
          .map((page: any) =>
            page.Texts
              .map((t: any) => t.R.map((r: any) => safeDecode(r.T)).join(''))
              .join(' ')
          )
          .join('\n');
        resolve(text.trim());
      } catch (e) {
        reject(e);
      }
    });

    pdfParser.parseBuffer(buffer);
  });
}

export const EXTRACTION_PROMPT = `You are an expert maritime document analyst with deep knowledge of STCW, MARINA, IMO, and international seafarer certification standards.

A document has been provided. Perform the following in a single pass:
1. IDENTIFY the document type from the taxonomy below
2. DETERMINE if this belongs to a DECK officer, ENGINE officer, BOTH, or is role-agnostic (N/A)
3. EXTRACT all fields that are meaningful for this specific document type
4. FLAG any compliance issues, anomalies, or concerns

Document type taxonomy (use these exact codes):
COC | COP_BT | COP_PSCRB | COP_AFF | COP_MEFA | COP_MECA | COP_SSO | COP_SDSD |
ECDIS_GENERIC | ECDIS_TYPE | SIRB | PASSPORT | PEME | DRUG_TEST | YELLOW_FEVER |
ERM | MARPOL | SULPHUR_CAP | BALLAST_WATER | HATCH_COVER | BRM_SSBT |
TRAIN_TRAINER | HAZMAT | FLAG_STATE | OTHER

Return ONLY a valid JSON object. No markdown. No code fences. No preamble.

{
  "detection": {
    "documentType": "SHORT_CODE",
    "documentName": "Full human-readable document name",
    "category": "IDENTITY | CERTIFICATION | STCW_ENDORSEMENT | MEDICAL | TRAINING | FLAG_STATE | OTHER",
    "applicableRole": "DECK | ENGINE | BOTH | N/A",
    "isRequired": true,
    "confidence": "HIGH | MEDIUM | LOW",
    "detectionReason": "One sentence explaining how you identified this document"
  },
  "holder": {
    "fullName": "string or null",
    "dateOfBirth": "DD/MM/YYYY or null",
    "nationality": "string or null",
    "passportNumber": "string or null",
    "sirbNumber": "string or null",
    "rank": "string or null",
    "photo": "PRESENT | ABSENT"
  },
  "fields": [
    {
      "key": "snake_case_key",
      "label": "Human-readable label",
      "value": "extracted value as string",
      "importance": "CRITICAL | HIGH | MEDIUM | LOW",
      "status": "OK | EXPIRED | WARNING | MISSING | N/A"
    }
  ],
  "validity": {
    "dateOfIssue": "string or null",
    "dateOfExpiry": "string | 'No Expiry' | 'Lifetime' | null",
    "isExpired": false,
    "daysUntilExpiry": null,
    "revalidationRequired": null
  },
  "compliance": {
    "issuingAuthority": "string",
    "regulationReference": "e.g. STCW Reg VI/1 or null",
    "imoModelCourse": "e.g. IMO 1.22 or null",
    "recognizedAuthority": true,
    "limitations": "string or null"
  },
  "medicalData": {
    "fitnessResult": "FIT | UNFIT | N/A",
    "drugTestResult": "NEGATIVE | POSITIVE | N/A",
    "restrictions": "string or null",
    "specialNotes": "string or null",
    "expiryDate": "string or null"
  },
  "flags": [
    {
      "severity": "CRITICAL | HIGH | MEDIUM | LOW",
      "message": "Description of issue or concern"
    }
  ],
  "summary": "Two-sentence plain English summary of what this document confirms about the holder."
}`;

// ─── JSON extraction helpers ──────────────────────────────────────────────────

export function extractJsonFromText(text: string): string | null {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through
  }

  // Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      JSON.parse(fenceMatch[1].trim());
      return fenceMatch[1].trim();
    } catch {
      // fall through
    }
  }

  // Find outermost { ... }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // fall through
    }
  }

  return null;
}

export function parseExtractionResult(text: string): LLMExtractionResult | null {
  const jsonStr = extractJsonFromText(text);
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr) as LLMExtractionResult;
    if (!parsed.detection || !parsed.holder || !Array.isArray(parsed.fields)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Repair prompt ────────────────────────────────────────────────────────────

export async function repairJsonWithLLM(
  provider: LLMProvider,
  rawResponse: string
): Promise<LLMExtractionResult | null> {
  const repairPrompt = `The following text was supposed to be a valid JSON object conforming to a maritime document extraction schema, but it could not be parsed.

Please return ONLY the corrected JSON object — no markdown, no fences, no explanation.

Raw text:
${rawResponse.slice(0, 3000)}`;

  try {
    const response = await provider.complete(
      [{ role: 'user', content: repairPrompt }],
      20000
    );
    return parseExtractionResult(response.text);
  } catch {
    return null;
  }
}

// ─── Low-confidence retry prompt ─────────────────────────────────────────────

export function buildFocusedPrompt(fileName: string, mimeType: string): string {
  return `${EXTRACTION_PROMPT}

HINT: The file being analyzed is named "${fileName}" with MIME type "${mimeType}". Use these as additional signals to improve document type detection confidence.`;
}

// ─── File utilities ───────────────────────────────────────────────────────────

export function computeSHA256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function toBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

// ─── Build messages based on file type ───────────────────────────────────────

async function buildMessages(
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string,
  prompt: string
): Promise<LLMMessage[]> {
  if (mimeType === 'application/pdf') {
    console.log('[debug] Extracting text from PDF...');
    try {
      const pdfText = await extractPdfText(fileBuffer);
      console.log('[debug] PDF text length:', pdfText.length);
      console.log('[debug] PDF text preview:', pdfText.slice(0, 200));

      if (!pdfText) {
        throw new Error('PDF_TEXT_EMPTY: Could not extract text from PDF. File may be scanned/image-based.');
      }

      return [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${prompt}\n\nDocument text content extracted from PDF:\n\n${pdfText}`,
            },
          ],
        },
      ];
    } catch (err) {
      console.log('[debug] PDF parse error:', err);
      throw err;
    }
  }

  // Image: send as base64
  const base64 = toBase64(fileBuffer);
  return [
    {
      role: 'user',
      content: [
        { type: 'image', imageBase64: base64, mimeType },
        { type: 'text', text: prompt },
      ],
    },
  ];
}

// ─── Full extraction pipeline ─────────────────────────────────────────────────

export interface ExtractionPipelineResult {
  result: LLMExtractionResult | null;
  rawLlmResponse: string;
  failed: boolean;
  failReason?: string;
}

export async function runExtractionPipeline(
  provider: LLMProvider,
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<ExtractionPipelineResult> {

  let messages: LLMMessage[];

  try {
    messages = await buildMessages(fileBuffer, mimeType, fileName, EXTRACTION_PROMPT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: null, rawLlmResponse: msg, failed: true, failReason: msg };
  }

  let rawText = '';

  // ── First attempt ──
  try {
    const response = await provider.complete(messages, 30000);
    rawText = response.text;
    console.log('[debug] Raw LLM response:', rawText.slice(0, 500));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[debug] LLM call failed:', msg);
    return { result: null, rawLlmResponse: msg, failed: true, failReason: msg };
  }

  let parsed = parseExtractionResult(rawText);

  // ── Low-confidence retry ──
  if (parsed && parsed.detection.confidence === 'LOW') {
    try {
      const focusedMessages = await buildMessages(
        fileBuffer,
        mimeType,
        fileName,
        buildFocusedPrompt(fileName, mimeType)
      );
      const retryResponse = await provider.complete(focusedMessages, 30000);
      const retryParsed = parseExtractionResult(retryResponse.text);
      if (retryParsed && retryParsed.detection.confidence !== 'LOW') {
        parsed = retryParsed;
        rawText = retryResponse.text;
      }
    } catch {
      // Keep original result on retry failure
    }
  }

  // ── JSON repair ──
  if (!parsed) {
    const repaired = await repairJsonWithLLM(provider, rawText);
    if (repaired) {
      parsed = repaired;
    } else {
      return {
        result: null,
        rawLlmResponse: rawText,
        failed: true,
        failReason: 'LLM_JSON_PARSE_FAIL',
      };
    }
  }

  return { result: parsed, rawLlmResponse: rawText, failed: false };
}