import { extractJsonFromText, parseExtractionResult } from '../services/extraction';

describe('extractJsonFromText', () => {
  test('parses clean JSON directly', () => {
    const input = '{"detection":{"documentType":"COC"},"holder":{},"fields":[]}';
    expect(extractJsonFromText(input)).toBe(input);
  });

  test('strips markdown json code fence', () => {
    const json = '{"detection":{"documentType":"COC"},"holder":{},"fields":[]}';
    const input = '```json\n' + json + '\n```';
    const result = extractJsonFromText(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual(JSON.parse(json));
  });

  test('strips plain code fence', () => {
    const json = '{"detection":{"documentType":"COC"},"holder":{},"fields":[]}';
    const input = '```\n' + json + '\n```';
    const result = extractJsonFromText(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual(JSON.parse(json));
  });

  test('extracts JSON after preamble text', () => {
    const json = '{"detection":{"documentType":"PEME"},"holder":{},"fields":[]}';
    const input = 'Here is the extracted data:\n' + json;
    const result = extractJsonFromText(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).detection.documentType).toBe('PEME');
  });

  test('extracts JSON before trailing text', () => {
    const json = '{"detection":{"documentType":"SIRB"},"holder":{},"fields":[]}';
    const input = json + '\n\nHope that helps!';
    const result = extractJsonFromText(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).detection.documentType).toBe('SIRB');
  });

  test('handles nested braces correctly', () => {
    const json = '{"outer":{"inner":{"deep":"value"}},"arr":[{"a":1}]}';
    const input = 'Preamble ' + json + ' trailing';
    const result = extractJsonFromText(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).outer.inner.deep).toBe('value');
  });

  test('returns null for plain text with no JSON', () => {
    expect(extractJsonFromText('This is just plain text with no JSON')).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    expect(extractJsonFromText('{ broken json }')).toBeNull();
  });

  test('handles whitespace-only input', () => {
    expect(extractJsonFromText('   \n\t  ')).toBeNull();
  });

  test('handles LLM explanation before JSON fence', () => {
    const json = '{"detection":{"documentType":"COC","documentName":"Certificate of Competency","category":"CERTIFICATION","applicableRole":"DECK","isRequired":true,"confidence":"HIGH","detectionReason":"test"},"holder":{"fullName":null,"dateOfBirth":null,"nationality":null,"passportNumber":null,"sirbNumber":null,"rank":null,"photo":"ABSENT"},"fields":[],"validity":{"dateOfIssue":null,"dateOfExpiry":null,"isExpired":false,"daysUntilExpiry":null,"revalidationRequired":null},"compliance":{"issuingAuthority":"MARINA","regulationReference":null,"imoModelCourse":null,"recognizedAuthority":true,"limitations":null},"medicalData":{"fitnessResult":"N/A","drugTestResult":"N/A","restrictions":null,"specialNotes":null,"expiryDate":null},"flags":[],"summary":"test summary"}';
    const input = `I analyzed this maritime document and here are the results:\n\`\`\`json\n${json}\n\`\`\`\nLet me know if you need anything else.`;
    const result = extractJsonFromText(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).detection.documentType).toBe('COC');
  });
});

describe('parseExtractionResult', () => {
  const validResult = {
    detection: {
      documentType: 'COC',
      documentName: 'Certificate of Competency',
      category: 'CERTIFICATION',
      applicableRole: 'DECK',
      isRequired: true,
      confidence: 'HIGH',
      detectionReason: 'Has COC header',
    },
    holder: {
      fullName: 'John Doe',
      dateOfBirth: '01/01/1990',
      nationality: 'Filipino',
      passportNumber: null,
      sirbNumber: 'C1234567',
      rank: 'Chief Officer',
      photo: 'PRESENT',
    },
    fields: [
      { key: 'cert_number', label: 'Certificate Number', value: 'ABC123', importance: 'CRITICAL', status: 'OK' },
    ],
    validity: {
      dateOfIssue: '01/01/2022',
      dateOfExpiry: '01/01/2027',
      isExpired: false,
      daysUntilExpiry: 365,
      revalidationRequired: false,
    },
    compliance: {
      issuingAuthority: 'MARINA',
      regulationReference: 'STCW Reg II/2',
      imoModelCourse: null,
      recognizedAuthority: true,
      limitations: null,
    },
    medicalData: {
      fitnessResult: 'N/A',
      drugTestResult: 'N/A',
      restrictions: null,
      specialNotes: null,
      expiryDate: null,
    },
    flags: [],
    summary: 'This document confirms the holder is a licensed Deck officer.',
  };

  test('parses a valid result from clean JSON string', () => {
    const result = parseExtractionResult(JSON.stringify(validResult));
    expect(result).not.toBeNull();
    expect(result!.detection.documentType).toBe('COC');
    expect(result!.holder.fullName).toBe('John Doe');
  });

  test('parses result wrapped in markdown fence', () => {
    const input = '```json\n' + JSON.stringify(validResult) + '\n```';
    const result = parseExtractionResult(input);
    expect(result).not.toBeNull();
    expect(result!.detection.confidence).toBe('HIGH');
  });

  test('returns null when fields array is missing', () => {
    const bad = { ...validResult, fields: undefined };
    const result = parseExtractionResult(JSON.stringify(bad));
    expect(result).toBeNull();
  });

  test('returns null when detection is missing', () => {
    const bad = { ...validResult, detection: undefined };
    const result = parseExtractionResult(JSON.stringify(bad));
    expect(result).toBeNull();
  });

  test('returns null for totally invalid text', () => {
    expect(parseExtractionResult('not json at all')).toBeNull();
  });

  test('preserves all fields including medicalData', () => {
    const medicalResult = {
      ...validResult,
      detection: { ...validResult.detection, documentType: 'PEME', category: 'MEDICAL' },
      medicalData: {
        fitnessResult: 'FIT',
        drugTestResult: 'NEGATIVE',
        restrictions: null,
        specialNotes: 'Some notes',
        expiryDate: '01/01/2027',
      },
    };
    const result = parseExtractionResult(JSON.stringify(medicalResult));
    expect(result).not.toBeNull();
    expect(result!.medicalData.fitnessResult).toBe('FIT');
    expect(result!.medicalData.drugTestResult).toBe('NEGATIVE');
  });

  test('handles arrays of flags', () => {
    const withFlags = {
      ...validResult,
      flags: [
        { severity: 'HIGH', message: 'Certificate expiring soon' },
        { severity: 'MEDIUM', message: 'Minor anomaly detected' },
      ],
    };
    const result = parseExtractionResult(JSON.stringify(withFlags));
    expect(result).not.toBeNull();
    expect(result!.flags).toHaveLength(2);
    expect(result!.flags[0].severity).toBe('HIGH');
  });
});
