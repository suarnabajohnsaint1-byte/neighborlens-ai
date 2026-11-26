// Standalone helper: js/auth/idIdentityService.js

(function () {
  'use strict';

  const policy = typeof module === 'object' && module.exports
    ? require('../../../shared/identityDocumentPolicy') : window.IdentityDocumentPolicy;

  const FIELD_LABELS = /\b(?:LAST\s*NAME|SURNAME|FIRST\s*NAME|GIVEN\s*NAMES?|MIDDLE\s*NAME|FULL\s*NAME|NAME|PANGALAN|APELYIDO|DATE\s*OF\s*ISSUE|ISSU(?:E|ED)\s*DATE|ISSUED|DATE\s*OF\s*BIRTH|BIRTH\s*DATE|D\.?O\.?B\.?|BIRTHDAY|KAPANGANAKAN|ADD?\s*RESS?|RESIDENCE|TIRAHAN|HOME\s*ADDRESS|STREET\s*ADDRESS|NATIONALITY|CITIZENSHIP|SEX|GENDER|KASARIAN|EXPIRY|EXPIRATION|VALID\s*(?:UNTIL|THRU)|ID\s*NO|LICENSE\s*NO|CRN|PCN|WEIGHT|HEIGHT|AGENCY\s*CODE|BLOOD\s*TYPE|RESTRICTIONS|CONDITIONS)\b/i;
  const BIRTH_LABEL = /\b(?:(?:PETSA(?:NG|\s+NG)?\s+)?KAPANGANAKAN(?:\s*[/|\\]\s*DATE\s*OF\s*B[A-Z]{2,6})?|DATE\s*OF\s*B[A-Z]{2,6}|BIRTH\s*DATE|D\.?O\.?B\.?|BIRTHDAY)\b/i;
  const ISSUE_LABEL = /\b(?:DATE\s*OF\s*ISSUE|ISSU(?:E|ED)\s*DATE|ISSUED)\b/i;
  const EXPIRY_LABEL = /\b(?:EXPIR(?:ATION|Y)?(?:\s+DATE)?|VALID\s*(?:UNTIL|THRU))\b/i;
  const ADDRESS_LABEL = /\b(?:TIRAHAN(?:\s*[/|\\]\s*ADD?\s*RESS?)?|HOME\s*ADDRESS|STREET\s*ADDRESS|ADD?\s*RESS?|RESIDENCE)\b/i;
  const DOCUMENT_HEADING = /\b(?:REPUBLIKA\s+NG|REPUBLIC\s+OF\s+(?:THE\s+)?PHIL|PAMBANSANG\s+PAGKAKAKIL|PHILIPPINE\s+IDENTIFICATION|UNIFIED\s+MULTI[\s-]*PURPOSE)/i;
  const PHYSICAL_ADDRESS_PREFIX = /\b(?:PUROK|PRK|SITIO|BARANGAY|BRGY|BLK|BLOCK|LOT|ZONE|CITY|MUNICIPALITY|PROVINCE|ST(?:REET)?|ROAD|AVE(?:NUE)?|SUBD(?:IVISION)?|BUILDING|UNIT)\b/i;
  const LICENSE_LABEL = /\b(?:LICENSE\s*(?:NO\.?|NUMBER)?|[A-Z]\d{2}[-\s]?\d{2}[-\s]?\d{6})\b/i;
  const DATE_VALUE = /\b(?:\d{4}\s*[\/.-]\s*\d{1,2}\s*[\/.-]\s*\d{1,2}|\d{1,2}\s*[\/.-]\s*\d{1,2}\s*[\/.-]\s*\d{2,4}|\d{1,2}\s+[A-Z]{3,9}\s+\d{4}|[A-Z]{3,9}\s+\d{1,2}(?:,\s*|\s+)\d{4})\b/gi;
  const FILIPINO_NAME_LABELS = [
    [/\bGitnang\s+Apelyido(?:\s*[/|\\]\s*Middle\s+Name)?\b|\bMiddle\s+Name\b/i, 'MIDDLE NAME'],
    [/\bMga\s+Pangalan(?:\s*[/|\\]\s*Given\s+Names?)?\b|\bGiven\s+Names?\b/i, 'GIVEN NAMES'],
    [/(?<!Gitnang\s)\bApelyido(?:\s*[/|\\]\s*(?:Last\s+Name|Surname))?\b|\b(?:Last\s+Name|Surname)\b/i, 'SURNAME']
  ];

  const SUPPORTED_ID_TYPES = {
    PHILSYS: {
      code: 'PHILSYS',
      label: 'PhilSys National ID',
      standardized: true,
      detectionRegex: /\b(?:PHILID|PAMBANSANG\s+PAGKAKAKILANLAN|PHILIPPINE\s+IDENTIFICATION\s+CARD|(?:DIGITAL|PHILIPPINE|PHILSYS)\s+NATIONAL\s+ID)\b/i,
      idNumberRegex: /\b(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/
    },
    DRIVERS_LICENSE: {
      code: 'DRIVERS_LICENSE',
      label: "LTO Driver's License",
      standardized: true,
      detectionRegex: /LAND\s+TRANSPORTATION|\bLTO\b|DRIVER.?S?\s+LIC(?:ENSE)?|LISENSYA|\bDL\s*CODES?\b|\bAGENCY\s*CODE\b|\b[A-Z]\d{2}[-\s]?\d{2}[-\s]?\d{6}\b/i,
      idNumberRegex: /\b([A-Z]\d{2}[-\s]?\d{2}[-\s]?\d{6})\b/i
    },
    PASSPORT: {
      code: 'PASSPORT',
      label: 'Philippine Passport',
      standardized: true,
      detectionRegex: /PASSPORT|PASAPORTE|REPUBLIKA\s+NG\s+PILIPINAS.*PASSPORT/i,
      idNumberRegex: /\b([A-Z]\d{7}[A-Z]|[A-Z]\d{8}|[A-Z]{2}\d{7})\b/i
    },
    UMID: {
      code: 'UMID',
      label: 'Unified Multi-Purpose ID (UMID)',
      standardized: true,
      detectionRegex: /\bUNIFIED\s+MULTI[\s-]*PURPOSE\s+(?:ID|IDENTIFICATION)\b/i,
      idNumberRegex: /\b(\d{4}[-\s]?\d{7}[-\s]?\d)\b/
    },
    SSS: {
      code: 'SSS',
      label: 'Social Security System (SSS) ID',
      standardized: true,
      detectionRegex: /\bSOCIAL\s+SECURITY\s+SYSTEM\b/i,
      idNumberRegex: /\b(\d{2}[-\s]\d{7}[-\s]\d)\b/
    },
    PHILHEALTH: {
      code: 'PHILHEALTH',
      label: 'PhilHealth ID',
      standardized: true,
      detectionRegex: /PHILHEALTH|PHILIPPINE\s+HEALTH\s+INSURANCE/i,
      idNumberRegex: /\b(\d{2}[-\s]\d{9}[-\s]\d)\b/
    },
    PRC_ID: {
      code: 'PRC_ID',
      label: 'PRC Professional ID',
      standardized: false, // Semi-standardized heuristic
      detectionRegex: /PROFESSIONAL\s+REGULATION|\bPRC\b/i,
      idNumberRegex: /\b(\d{7})\b/
    },
    POSTAL_ID: {
      code: 'POSTAL_ID',
      label: 'Philippine Postal ID',
      standardized: false, // Semi-standardized heuristic
      detectionRegex: /POSTAL\s+ID|PHILIPPINE\s+POSTAL/i,
      idNumberRegex: /\b([A-Z0-9]{4}[-\s]?[A-Z0-9]{4}[-\s]?[A-Z0-9]{4}[-\s]?[A-Z0-9]{4})\b/i
    },
    VOTERS_ID: {
      code: 'VOTERS_ID',
      label: "COMELEC Voter's ID",
      standardized: false, // CONTRACT DECISION REQUIRED: LGU/VIN variation
      detectionRegex: /COMMISSION\s+ON\s+ELECTIONS|\bCOMELEC\b|VOTER.?S?\s+ID/i,
      idNumberRegex: /\b(\d{4}[-\s]?\d{4}[A-Z][-\s]?[A-Z0-9]+)\b/i
    },
    SENIOR_CITIZEN: {
      code: 'SENIOR_CITIZEN',
      label: 'Senior Citizen / OSCA ID',
      standardized: false, // CONTRACT DECISION REQUIRED: LGU non-standardized
      detectionRegex: /SENIOR\s+CITIZEN|\bOSCA\b/i,
      idNumberRegex: /(?:ID\s*NO\.?|CONTROL\s*NO\.?|OSCA\s*NO\.?)\s*[:\-]?\s*([A-Z0-9\-]+)/i
    },
    PWD: {
      code: 'PWD',
      label: 'Persons with Disability (PWD) ID',
      standardized: false, // CONTRACT DECISION REQUIRED: LGU/PDAO non-standardized
      detectionRegex: /PERSONS?\s+WITH\s+DISAB|PWD\s+ID/i,
      idNumberRegex: /(?:ID\s*NO\.?|RR[\s\-]?NO\.?)\s*[:\-]?\s*([A-Z0-9\-]+)/i
    }
  };

  const VALIDATION_STATES = Object.freeze({
    PENDING_REVIEW: 'pending_review',
    DOCUMENT_DETECTED: 'document_detected',
    NEEDS_MANUAL_REVIEW: 'needs_manual_review',
    REJECTED: 'rejected'
  });

  const DISCLAIMER_TEXT = 'OCR document validation only; does not establish official government authenticity verification.';

  function normalizeText(value) {
    return String(value || '').replace(/[|]/g, 'I').replace(/\s+/g, ' ').trim();
  }

  function getLines(value) {
    return String(value || '').slice(0, 65536)
      .split(/\r?\n/)
      .map(line => normalizeText(line).replace(/^[:\-]+|[:\-]+$/g, '').trim())
      .filter(Boolean);
  }

  function titleCaseName(value) {
    if (!value || !/\p{L}{2}/u.test(value)) return '';
    return normalizeText(value)
      .replace(/[^\p{L}\p{M}.'’\-\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(part => /\p{L}/u.test(part))
      .map(part => part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : '')
      .join(' ');
  }

  function normalizeDate(value, requireUnambiguous = false) {
    if (!value) return '';
    const raw = normalizeText(value).replace(/\s*([\/.-])\s*/g, '$1');

    // Textual month format: 15 MAY 1990 or MAY 15 1990
    const textMonthMatch = raw.match(/\b(\d{1,2})\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+(\d{2,4})\b/i) ||
      raw.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+(\d{1,2})(?:,\s*|\s+)(\d{2,4})\b/i);

    if (textMonthMatch) {
      const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
      let d, m, y;
      if (/^\d/.test(textMonthMatch[1])) {
        d = Number(textMonthMatch[1]);
        m = months[textMonthMatch[2].toLowerCase().slice(0, 3)];
        y = Number(textMonthMatch[3]);
      } else {
        m = months[textMonthMatch[1].toLowerCase().slice(0, 3)];
        d = Number(textMonthMatch[2]);
        y = Number(textMonthMatch[3]);
      }
      if (requireUnambiguous && y < 100) return '';
      if (y < 100) y += y >= 30 ? 1900 : 2000;
      const date = new Date(Date.UTC(y, m - 1, d));
      if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
      return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
    }

    const numericMatch = raw.match(/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/) ||
      raw.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
    if (!numericMatch) return '';

    let year, month, day;
    if (numericMatch[1].length === 4) {
      year = Number(numericMatch[1]);
      month = Number(numericMatch[2]);
      day = Number(numericMatch[3]);
    } else {
      const p1 = Number(numericMatch[1]);
      const p2 = Number(numericMatch[2]);
      year = Number(numericMatch[3]);
      if (requireUnambiguous && (year < 100 || (p1 <= 12 && p2 <= 12 && p1 !== p2))) return '';
      if (year < 100) year += year >= 30 ? 1900 : 2000;

      if (p1 > 12 && p2 <= 12) {
        day = p1;
        month = p2;
      } else if (p2 > 12 && p1 <= 12) {
        month = p1;
        day = p2;
      } else {
        month = p1;
        day = p2;
      }
    }

    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
  }

  function valueAfterLabel(line, label) {
    const match = line.match(label);
    return match ? line.slice(match.index + match[0].length).replace(/^\s*[:\-#]?\s*/, '').trim() : '';
  }

  function detectIdType(text) {
    const types = Object.values(SUPPORTED_ID_TYPES).filter(type => type.detectionRegex.test(text));
    const { PHILSYS, UMID, SSS } = SUPPORTED_ID_TYPES;
    // Weaker headers need corroborating document-specific identifiers.
    if (!types.includes(PHILSYS) && /\b(?:PHILSYS|NATIONAL\s+ID|PHILIPPINE\s+(?:STATISTICS\s+AUTHORITY|IDENTIFICATION)|PCN)\b/i.test(text) &&
      PHILSYS.idNumberRegex.test(text)) types.push(PHILSYS);
    if (!types.includes(UMID) && /\bCRN\b/i.test(text) &&
      (/\bUNIFIED\s+MULTI[\s-]*PURPOSE\b/i.test(text) ||
        (/\bUMID\b/i.test(text) && UMID.idNumberRegex.test(text)))) types.push(UMID);
    if (!types.includes(SSS) && /\bSSS\b/i.test(text) && SSS.idNumberRegex.test(text)) types.push(SSS);

    const candidates = types.filter(type => type !== SSS || !types.includes(UMID));
    if (candidates.length === 1) return candidates[0];
    return {
      code: 'UNKNOWN',
      label: 'Unknown / Generic ID',
      standardized: false
    };
  }

  function extractIdNumber(text, idTypeCode) {
    const typeConf = SUPPORTED_ID_TYPES[idTypeCode];
    if (idTypeCode === 'PHILSYS') {
      const lines = getLines(text.replace(/[–—]/g, '-'));
      const candidates = lines.flatMap(line => [...line.matchAll(/(?:^|[^\w-])(\d{4}(?:[ -]?\d{4}){3})(?![\w-])/g)]
        .map(match => match[1]));
      return readIdentityRegion('idNumber', candidates.join('\n'), idTypeCode);
    }
    if (typeConf && typeConf.idNumberRegex) {
      const match = text.match(typeConf.idNumberRegex);
      if (match && match[1]) {
        const val = normalizeText(match[1]).replace(/\s+/g, '-');
        if (idTypeCode === 'DRIVERS_LICENSE') {
          const ltoParts = val.match(/^([A-Z]\d{2})[-\s]?(\d{2})[-\s]?(\d{6})$/i);
          if (ltoParts) return `${ltoParts[1].toUpperCase()}-${ltoParts[2]}-${ltoParts[3]}`;
        }
        return val;
      }
      return '';
    }

    // Generic fallback: explicit label patterns
    const genericMatch = text.match(/\b(ID\s*NO\.?|CARD\s*NO\.?|CRN|PCN|NUMBER|NO\.)\s*[:\-]?\s*([A-Z0-9\-]{6,25})/i);
    if (genericMatch && /\d/.test(genericMatch[2]) && !FIELD_LABELS.test(genericMatch[2])) {
      const [, label, candidate] = genericMatch;
      if (/^(CRN|PCN)$/i.test(label)) {
        return readIdentityRegion('idNumber', candidate, label.toUpperCase() === 'CRN' ? 'UMID' : 'PHILSYS');
      }
      const val = normalizeText(candidate);
      const ltoParts = val.match(/^([A-Z]\d{2})[-\s]?(\d{2})[-\s]?(\d{6})$/i);
      if (ltoParts) return `${ltoParts[1].toUpperCase()}-${ltoParts[2]}-${ltoParts[3]}`;
      return val;
    }
    return '';
  }

  function extractSex(text) {
    const match = text.match(/(?:SEX|GENDER|KASARIAN)\s*[:\-]?\s*(MALE|FEMALE|LALAKE|BABAE|\bM\b|\bF\b)/i);
    if (!match) return '';
    const raw = match[1].toUpperCase();
    if (raw === 'M' || raw === 'MALE' || raw === 'LALAKE') return 'M';
    if (raw === 'F' || raw === 'FEMALE' || raw === 'BABAE') return 'F';
    return '';
  }

  function labeledDate(lines, label) {
    for (let index = 0; index < lines.length; index++) {
      if (!label.test(lines[index])) continue;
      const tail = valueAfterLabel(lines[index], label);
      const inline = tail.split(FIELD_LABELS)[0];
      const candidates = inline.match(DATE_VALUE) || [];
      if (candidates.length === 1) return normalizeDate(candidates[0], label === BIRTH_LABEL);
      if (candidates.length > 1) return '';
      if (BIRTH_LABEL.test(lines[index]) && EXPIRY_LABEL.test(lines[index])) return '';
      for (let nextIdx = index + 1; nextIdx < Math.min(index + 5, lines.length); nextIdx++) {
        const next = lines[nextIdx];
        const licenseValues = label === EXPIRY_LABEL && LICENSE_LABEL.test(lines[index]) &&
          SUPPORTED_ID_TYPES.DRIVERS_LICENSE.idNumberRegex.test(next);
        if (ADDRESS_LABEL.test(next) || (LICENSE_LABEL.test(next) && !licenseValues)) break;
        if (ISSUE_LABEL.test(next) || (label === BIRTH_LABEL ? EXPIRY_LABEL.test(next) : BIRTH_LABEL.test(next))) break;
        const dates = next.match(DATE_VALUE) || [];
        if (dates.length === 1) return normalizeDate(dates[0], label === BIRTH_LABEL);
        if (dates.length > 1) break;
      }
    }
    return '';
  }

  function extractLicenseExpiry(lines) {
    const licenseNumber = SUPPORTED_ID_TYPES.DRIVERS_LICENSE.idNumberRegex;
    const index = lines.findIndex(line => licenseNumber.test(line) && !BIRTH_LABEL.test(line) && !ISSUE_LABEL.test(line));
    if (index < 0) return '';
    // Some LTO scans lose the column labels but preserve the license number,
    // optional agency code, and expiry in the same block.
    const inline = lines[index].slice(lines[index].search(licenseNumber)).replace(licenseNumber, '').trim();
    const next = /^[A-Z]\d{2}$/i.test(lines[index + 1] || '') ? lines[index + 2] : lines[index + 1];
    const candidates = (inline || next || '').match(DATE_VALUE) || [];
    if (candidates.length !== 1 || (next && (BIRTH_LABEL.test(next) || ISSUE_LABEL.test(next)))) return '';
    if (!inline && next?.trim() !== candidates[0]) return '';
    return normalizeDate(candidates[0]);
  }

  function extractFullName(lines, philSys = false) {
    lines = lines.map(line => line
      .replace(/\b((?:LAST|FIRST|MIDDLE|FULL)\s*)N[O0]ME\b/gi, '$1NAME')
      .replace(/^Gitnang\s+Apelyido(?:\s*[\/|\\]\s*(?:Middle Name\b|[^:]*))?/i, 'MIDDLE NAME')
      .replace(/^Mga\s+Pangalan(?:\s*[\/|\\]\s*(?:Given Names?\b|[^:]*))?/i, 'GIVEN NAMES')
      .replace(/^Apelyido(?=\s*(?:[\/|\\:]|$))(?:\s*[\/|\\]\s*(?:(?:Last Name|Surname)\b|[^:]*))?/i, 'SURNAME')
      .replace(/^Middle Name\s*[\/|\\]\s*Gitnang Apelyido/i, 'MIDDLE NAME')
      .replace(/^Given Names?\s*[\/|\\]\s*(?:Mga Pangalan|Prenoms?)/i, 'GIVEN NAMES')
      .replace(/^(?:Last Name|Surname)\s*[\/|\\]\s*(?:Apelyido|Nom)/i, 'LAST NAME'));
    const componentLabels = /\b(?:LAST\s*NAME|SURNAME|FIRST\s*NAME|GIVEN\s*NAMES?|MIDDLE\s*NAME)\b/gi;
    const fullNameLabel = /^(?:FULL\s*NAME|NAME|PANGALAN)\b/i;
    const combined = lines.findIndex(line => (line.match(componentLabels) || []).length >= 2);
    let value = '';
    const components = {};
    function followingName(index) {
      const parts = [];
      for (let next = index + 1; next < Math.min(index + 4, lines.length); next++) {
        if (FIELD_LABELS.test(lines[next]) || DOCUMENT_HEADING.test(lines[next]) ||
          (philSys && PHYSICAL_ADDRESS_PREFIX.test(lines[next])) || !/^[\p{L} .,'’\-]+$/u.test(lines[next])) break;
        if (!/[a-zA-ZñÑ]{2,}/.test(lines[next])) continue;
        parts.push(lines[next]);
        if (philSys) break;
      }
      return parts.join(' ');
    }
    for (let index = 0; index < lines.length; index++) {
      const matches = [...lines[index].matchAll(componentLabels)];
      for (let n = 0; n < matches.length; n++) {
        const label = matches[n];
        let tail = lines[index].slice(label.index + label[0].length, matches[n + 1]?.index)
          .replace(/^[\s:,\-\/|\\]+/, '')
          .replace(/^(?:APELYIDO|MGA\s*PANGALAN|PANGALAN|GITNANG\s*APELYIDO|NOM|PRENOMS?)\b/i, '')
          .replace(/^[\s:,\-\/|\\]+/, '')
          .split(FIELD_LABELS)[0].split(DOCUMENT_HEADING)[0].trim();
        if (tail && !/[a-zA-ZñÑ]{2,}/.test(tail)) tail = '';
        const part = tail || (combined < 0 && matches.length === 1 ? followingName(index) : '');
        const key = /LAST|SURNAME/i.test(label[0]) ? 'last' : /MIDDLE/i.test(label[0]) ? 'middle' : 'first';
        if (part && /[a-zA-ZñÑ]{2,}/.test(part)) components[key] = part;
      }
    }
    if (components.first && components.last) {
      return titleCaseName([components.first, components.middle, components.last].filter(Boolean).join(' '));
    }
    if (philSys && (combined >= 0 || Object.keys(components).length)) return '';
    if (combined >= 0) {
      for (let index = combined + 1; index < Math.min(combined + 4, lines.length); index++) {
        if (/\b(?:LAST|FIRST|MIDDLE|FULL)\s*(?:NAME|N[O0]ME|NARNE)\b/i.test(lines[index])) continue;
        if (FIELD_LABELS.test(lines[index])) break;
        if (!/[a-zA-ZñÑ]{2,}/.test(lines[index])) continue;
        value = lines[index];
        break;
      }
    } else {
      const nameIndex = lines.findIndex(line => fullNameLabel.test(line));
      if (nameIndex >= 0) {
        const candidate = valueAfterLabel(lines[nameIndex], fullNameLabel);
        value = (candidate && /[a-zA-ZñÑ]{2,}/.test(candidate)) ? candidate : followingName(nameIndex);
      }
    }
    if (/\b(?:LAST|FIRST|MIDDLE|FULL)\s*(?:NAME|N[O0]ME|NARNE)\b/i.test(value)) return '';
    if (philSys && (DOCUMENT_HEADING.test(value) || PHYSICAL_ADDRESS_PREFIX.test(value) ||
      (value.match(/\p{L}+/gu) || []).length < 2)) return '';
    const parts = value.split(FIELD_LABELS)[0].split(',')
      .map(part => part.trim())
      .filter(part => /[a-zA-ZñÑ]{2,}/.test(part));
    if (parts.length === 2) return titleCaseName(`${parts[1]} ${parts[0]}`);
    if (parts.length === 3) return titleCaseName(`${parts[1]} ${parts[2]} ${parts[0]}`);
    return titleCaseName(parts.join(' '));
  }

  function layoutRows(words) {
    if (!Array.isArray(words)) return [];
    const ordered = words.slice(0, 2000).filter(word =>
      typeof word?.text === 'string' && word.text.length <= 128 &&
      ['x0', 'x1', 'y0', 'y1'].every(key => Number.isFinite(word.bbox?.[key])) &&
      word.bbox.x1 > word.bbox.x0 && word.bbox.y1 > word.bbox.y0
    ).sort((a, b) => (a.bbox.y0 + a.bbox.y1) - (b.bbox.y0 + b.bbox.y1));
    const rows = [];
    for (const word of ordered) {
      const center = (word.bbox.y0 + word.bbox.y1) / 2;
      const height = word.bbox.y1 - word.bbox.y0;
      let row = rows[rows.length - 1];
      if (!row || Math.abs(row.center - center) > Math.min(row.height, height) * 0.5) {
        row = { words: [], center, height };
        rows.push(row);
      }
      row.words.push(word);
    }
    return rows.map(row => {
      row.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      let offset = 0;
      row.ranges = row.words.map(word => {
        const range = { start: offset, end: offset + word.text.length, word };
        offset = range.end + 1;
        return range;
      });
      row.text = row.words.map(word => word.text).join(' ');
      return row;
    });
  }

  function layoutDate(rows, label) {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const match = row.text.match(label);
      if (!match) continue;
      const bounds = row.ranges.filter(range => range.end > match.index && range.start < match.index + match[0].length);
      if (!bounds.length) continue;
      const left = bounds[0].word.bbox.x0;
      const rightLabel = bounds[bounds.length - 1].word.bbox.x1;
      const following = row.text.slice(match.index + match[0].length).match(FIELD_LABELS);
      const nextLabel = following ? row.ranges.find(range => range.end > match.index + match[0].length + following.index) : null;
      const right = nextLabel?.word.bbox.x0 ?? Infinity;
      for (let candidate = index; candidate < Math.min(index + 4, rows.length); candidate++) {
        const source = rows[candidate];
        if (source.center - row.center > row.height * 4) break;
        if (candidate > index && FIELD_LABELS.test(source.text)) break;
        const text = source.words.filter(word => {
          const center = (word.bbox.x0 + word.bbox.x1) / 2;
          return center >= (candidate === index ? rightLabel : left - row.height * 0.5) && center < right;
        }).map(word => word.text).join(' ');
        const dates = text.match(DATE_VALUE) || [];
        if (dates.length === 1) return normalizeDate(dates[0], label === BIRTH_LABEL);
        if (dates.length > 1) return '';
      }
    }
    return '';
  }

  function findLayoutLabel(rows, label) {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const match = row.text.match(label);
      if (!match) continue;
      const ranges = row.ranges.filter(range => range.end > match.index && range.start < match.index + match[0].length);
      if (!ranges.length) continue;
      return {
        index, row, end: match.index + match[0].length,
        left: Math.min(...ranges.map(range => range.word.bbox.x0)),
        right: Math.max(...ranges.map(range => range.word.bbox.x1)),
        top: Math.min(...ranges.map(range => range.word.bbox.y0)),
        bottom: Math.max(...ranges.map(range => range.word.bbox.y1)),
      };
    }
    return null;
  }

  function layoutPhilSysName(rows) {
    const lines = [];
    const anchors = FILIPINO_NAME_LABELS.map(([label, name]) => ({ anchor: findLayoutLabel(rows, label), name }))
      .filter(item => item.anchor).sort((a, b) => a.anchor.index - b.anchor.index);
    for (const [index, { anchor, name }] of anchors.entries()) {
      const height = anchor.bottom - anchor.top;
      const nextLabel = anchors[index + 1]?.anchor.index ?? rows.length;
      const nextField = rows.slice(anchor.index + 1, nextLabel).findIndex(row => BIRTH_LABEL.test(row.text) || ADDRESS_LABEL.test(row.text));
      const stop = nextField < 0 ? nextLabel : anchor.index + 1 + nextField;
      const following = rows.slice(anchor.index + 1, stop)
        .filter(row => row.center <= anchor.bottom + height * 4);
      const candidate = following.map(row => {
        const nearby = row.words.filter(word => word.bbox.x0 >= anchor.left - height * .5);
        if (!nearby.length || nearby[0].bbox.x0 > anchor.left + height * 1.5) return '';
        const group = [];
        for (const word of nearby) {
          const previous = group.at(-1);
          if (previous && word.bbox.x0 - previous.bbox.x1 > height * 1.6) break;
          if (!/^\p{L}[\p{L}\p{M}.'’\-]+$/u.test(word.text) ||
            (Number.isFinite(word.confidence) && word.confidence < 40)) break;
          group.push(word);
        }
        return group.map(word => word.text).join(' ');
      }).find(Boolean);
      if (candidate) lines.push(`${name}: ${candidate}`);
    }
    return extractFullName(lines, true);
  }

  function philSysAddress(lines, allowPrintedRegion = false) {
    const index = lines.findIndex(line => ADDRESS_LABEL.test(line) && !DOCUMENT_HEADING.test(line));
    if (index < 0 && !allowPrintedRegion) return '';
    const value = index < 0 ? '' : valueAfterLabel(lines[index], ADDRESS_LABEL);
    const parts = [];
    // A mangled second label after “Tirahan /” is not an inline address.
    if (value && PHYSICAL_ADDRESS_PREFIX.test(value) && !/^[/|\\]/.test(value) &&
      !DOCUMENT_HEADING.test(value)) parts.push(value);
    for (const line of lines.slice(index + 1, index + 5)) {
      if (DOCUMENT_HEADING.test(line) || FIELD_LABELS.test(line) || /^(?:PHL|[A-Z])$/i.test(line) ||
        (line.match(DATE_VALUE) || []).length || SUPPORTED_ID_TYPES.PHILSYS.idNumberRegex.test(line)) break;
      if (!/\p{L}{2}/u.test(line)) continue;
      if (!parts.length && !PHYSICAL_ADDRESS_PREFIX.test(line)) continue;
      parts.push(line);
    }
    const address = parts.filter(line => /\p{L}{2}/u.test(line)).join(', ');
    return PHYSICAL_ADDRESS_PREFIX.test(address) ? address.slice(0, 255) : '';
  }

  function identityScanRegions(words, size, fields = {}) {
    if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height) || size.width <= 0 || size.height <= 0) return [];
    const rows = layoutRows((Array.isArray(words) ? words : []).filter(word =>
      word?.bbox?.x0 >= 0 && word?.bbox?.y0 >= 0 && word.bbox.x1 <= size.width && word.bbox.y1 <= size.height
    ));
    const birth = findLayoutLabel(rows, BIRTH_LABEL);
    const address = findLayoutLabel(rows, ADDRESS_LABEL);
    const license = findLayoutLabel(rows, LICENSE_LABEL);
    const metadata = fields.idType === 'DRIVERS_LICENSE' ? findLayoutLabel(rows, /\b(?:NATIONALITY|NAT|NATION|NOTORARTY)\b.*\b(?:SEX|GENDER|SEU)\b|\b(?:SEX|SEU)\b.*\bDATE\b/i) : null;
    const definitions = [
      { field: 'birthDate', anchor: birth || metadata, stop: /\b(?:ADD?\s*RESS?|LICENSE\s*NO)\b/i },
      { field: 'address', anchor: address, stop: /\b(?:LICENSE\s*NO|EXPIRATION|EXPIRY)\b/i, multiline: true },
      { field: 'expiryDate', anchor: findLayoutLabel(rows, EXPIRY_LABEL) || (fields.idType === 'DRIVERS_LICENSE' ? license : null), stop: /\b(?:BLOOD|RESTRICTIONS|CONDITIONS|DL\s*CODES?)\b/i },
    ];
    const regions = [];
    for (const definition of definitions) {
      if (definition.field === 'expiryDate' && fields.expiryDate === null && !fields.expiryDatePresent) continue;
      if (fields[definition.field] || fields.conflicts?.includes(definition.field) || !definition.anchor) continue;
      const anchor = definition.anchor;
      const labelHeight = anchor.bottom - anchor.top;
      const following = anchor.row.text.slice(anchor.end).match(FIELD_LABELS);
      const nextLabel = following ? anchor.row.ranges.find(range => range.end > anchor.end + following.index) : null;
      const left = Math.max(0, Math.floor(anchor.left - labelHeight));
      const top = Math.max(0, Math.floor(definition.field === 'address' ? anchor.bottom + 2 : anchor.bottom - labelHeight * 0.15));
      const barrier = rows.slice(anchor.index + 1).find(row => row.center > anchor.bottom && definition.stop.test(row.text));
      const bottom = Math.min(size.height, barrier ? Math.min(...barrier.words.map(word => word.bbox.y0)) : top + Math.max(labelHeight * 6, size.height * (definition.multiline ? 0.18 : 0.1)));
      const right = definition.multiline ? size.width : Math.min(size.width, nextLabel?.word.bbox.x0 ?? left + size.width * 0.5);
      if (right > left && bottom > top) regions.push({ field: definition.field, left, top, width: Math.ceil(right - left), height: Math.ceil(bottom - top) });
    }
    if (!fields.address && !address && metadata && license && license.top > metadata.bottom) {
      const left = Math.max(0, Math.floor(metadata.left - metadata.row.height));
      const top = Math.ceil(metadata.bottom + Math.max(metadata.row.height * 2.2, size.height * 0.04));
      const bottom = Math.floor(license.top);
      if (bottom > top) regions.push({ field: 'address', left, top, width: Math.ceil(size.width - left), height: bottom - top });
    }
    return regions;
  }

  function readIdentityRegion(field, text, type, words = []) {
    if (field === 'idNumber') {
      const regex = SUPPORTED_ID_TYPES[type]?.idNumberRegex;
      if (!regex || !['PHILSYS', 'UMID'].includes(type)) return '';
      const numbers = getLines(text).map(line => line.replace(/\s*[-–—]\s*/g, '-').replace(/^[-\s]+/, '').trim())
        .filter(line => /^\d[\d -]*$/.test(line) && line.match(regex)?.[0] === line)
        .map(line => line.replace(/\D/g, ''));
      const unique = [...new Set(numbers)];
      if (unique.length !== 1) return '';
      const number = unique[0];
      return type === 'UMID' ? `${number.slice(0, 4)}-${number.slice(4, 11)}-${number.slice(11)}`
        : number.match(/.{4}/g).join('-');
    }
    if (field === 'fullName' && type === 'PHILSYS') {
      return extractFullName(getLines(text), true) || layoutPhilSysName(layoutRows(words));
    }
    if (field === 'birthDate' || field === 'expiryDate') {
      if (ISSUE_LABEL.test(text) || (field === 'birthDate' ? EXPIRY_LABEL.test(text) : BIRTH_LABEL.test(text))) return '';
      const dates = [...new Set((String(text || '').match(DATE_VALUE) || [])
        .map(value => normalizeDate(value, field === 'birthDate')).filter(Boolean))];
      if (dates.length === 1) return dates[0];
      if (field === 'birthDate' && dates.length > 1) {
        const currentYear = new Date().getUTCFullYear();
        const birthCandidates = dates.filter(d => {
          const y = parseInt(d.slice(-4), 10);
          return y <= currentYear - 15 && y >= currentYear - 100;
        });
        if (birthCandidates.length === 1) return birthCandidates[0];
      }
      return '';
    }
    if (field !== 'address') return '';
    if (type === 'PHILSYS') return philSysAddress(getLines(text), true);
    const lines = getLines(text).map(line =>
      line.replace(ADDRESS_LABEL, '')
        .replace(/^[\s:\-\/,|#]+/, '')
        .replace(/^(?:TIRAHAN|ADD?\s*RESS?|RESIDENCE)\b/i, '')
        .replace(/^[\s:\-\/,|]+/, '')
        .trim()
    ).filter(line =>
      line && (line.length > 2 || /\d/.test(line)) &&
      !DOCUMENT_HEADING.test(line) && !FIELD_LABELS.test(line) && !(line.match(DATE_VALUE) || []).length &&
      !/^PHL\b|^[MF]\s+\d/i.test(line)
    );
    let address = normalizeText(lines.join(', '))
      .replace(/([A-Z0-9])\.\s+([A-Z0-9])/g, '$1, $2')
      .replace(/^NN[,:\-\s]+/i, '')
      .replace(/^[\s,.\-\/|]+|[\s,.\-\/|#]+$/g, '');
    return address.length >= 8 && (address.match(/[A-Z]{2,}/gi) || []).length >= 2 ? address.slice(0, 255) : '';
  }

  function mergeIdentityReadings(primary, secondary) {
    if (!secondary) return { ...primary };
    if (primary.idType !== secondary.idType) {
      if ([primary.idType, secondary.idType].every(type => type === 'PHILSYS' || type === 'UMID')) {
        return {
          ...primary, idType: 'UNKNOWN', idTypeLabel: 'Unknown / Generic ID',
          idNumber: '', fullName: '', birthDate: '', address: '', expiryDate: '',
          expiryDatePresent: false, standardized: false, conflicts: ['idType']
        };
      }
      return { ...primary };
    }
    const merged = { ...primary, expiryDatePresent: primary.expiryDatePresent || secondary.expiryDatePresent };
    merged.conflicts = [...new Set([...(primary.conflicts || []), ...(secondary.conflicts || [])])];
    const philSys = primary.idType === 'PHILSYS';
    const keys = ['fullName', 'birthDate', 'address', 'expiryDate'];
    if (philSys) keys.push('idNumber');
    for (const key of keys) {
      if (merged.conflicts.includes(key)) { merged[key] = ''; continue; }
      if (!merged[key] && secondary[key]) merged[key] = secondary[key];
      else if ((philSys || key !== 'address') && secondary[key] && !agreeIdentityField(merged[key], secondary[key])) {
        merged[key] = '';
        merged.conflicts.push(key);
      }
    }
    return merged;
  }

  function extractIdentityFields(rawText, words = []) {
    try {
      const rows = layoutRows(words);
      const lines = getLines(rows.length ? rows.map(row => row.text).join('\n') : rawText);
      if (!lines.length) {
        return {
          fullName: '',
          birthDate: '',
          address: '',
          idType: 'UNKNOWN',
          idTypeLabel: 'Unknown / Generic ID',
          idNumber: '',
          expiryDate: '',
          sex: '',
          nationality: '',
          standardized: false
        };
      }
      const text = lines.join(' ');

      // 1. Detect candidate ID type
      const detectedType = detectIdType(text);

      // 2. Extract ID number
      const philSys = detectedType.code === 'PHILSYS';
      const idNumber = extractIdNumber(philSys ? lines.join('\n') : text, detectedType.code);

      // 3. Extract Full Name
      const fullName = (philSys && layoutPhilSysName(rows)) || extractFullName(lines, philSys);

      // 4. Extract Birth Date
      const hasSharedDateLabels = lines.some(line => BIRTH_LABEL.test(line) && EXPIRY_LABEL.test(line));
      let birthDate = layoutDate(rows, BIRTH_LABEL) || labeledDate(lines, BIRTH_LABEL);
      if (!birthDate && !hasSharedDateLabels && !philSys) {
        const linesWithDates = lines.filter(line => (line.match(DATE_VALUE) || []).length);
        const birthCandidates = [];
        for (const line of linesWithDates) {
          if (ISSUE_LABEL.test(line) || EXPIRY_LABEL.test(line)) continue;
          const dates = line.match(DATE_VALUE) || [];
          for (const d of dates) {
            const normalized = normalizeDate(d, true);
            if (!normalized) continue;
            const y = parseInt(normalized.slice(-4), 10);
            const currentYear = new Date().getUTCFullYear();
            if (y <= currentYear - 15 && y >= currentYear - 100) {
              birthCandidates.push(normalized);
            }
          }
        }
        const uniqueBirths = [...new Set(birthCandidates)];
        if (uniqueBirths.length === 1) {
          birthDate = uniqueBirths[0];
        }
      }

      // 5. Extract Address
      let address = philSys ? philSysAddress(lines) : '';
      const addressLabel = ADDRESS_LABEL;
      const addressIndex = lines.findIndex(line => addressLabel.test(line));
      if (!philSys && addressIndex >= 0 && !DOCUMENT_HEADING.test(lines[addressIndex])) {
        let inlineVal = valueAfterLabel(lines[addressIndex], addressLabel)
          .replace(/^[\s:\-\/,|]+/, '')
          .replace(/^(?:TIRAHAN|ADD?\s*RESS?|RESIDENCE)\b/i, '')
          .replace(/^[\s:\-\/,|]+/, '')
          .split(FIELD_LABELS)[0].trim();
        const addressParts = (inlineVal && !DOCUMENT_HEADING.test(inlineVal) && (inlineVal.length > 2 || /\d/.test(inlineVal))) ? [inlineVal] : [];
        for (let index = addressIndex + 1; index < lines.length && addressParts.length < 3; index++) {
          if (FIELD_LABELS.test(lines[index]) || DOCUMENT_HEADING.test(lines[index])) break;
          if (extractIdNumber(lines[index], detectedType.code)) break;
          if ((lines[index].match(DATE_VALUE) || []).length) break;
          const cleanLine = lines[index].replace(/^[\s:\-\/,|]+/, '').trim();
          if (!cleanLine || (cleanLine.length <= 2 && !/\d/.test(cleanLine))) continue;
          addressParts.push(cleanLine);
        }
        address = addressParts.filter(Boolean).join(', ');
      }
      if (!address && rows.length && detectedType.code === 'DRIVERS_LICENSE') {
        const licenseRowIdx = rows.findIndex(r =>
          LICENSE_LABEL.test(r.text) || (idNumber && r.text.includes(idNumber)) || /\b[A-Z]\d{2}[-\s]?\d{2}[-\s]?\d{6}\b/i.test(r.text)
        );
        const demoRowIdx = rows.findIndex(r =>
          BIRTH_LABEL.test(r.text) || (birthDate && (r.text.includes(birthDate.slice(-4)) || (r.text.match(DATE_VALUE) || []).length)) || /\b(?:NATIONALITY|SEX|WEIGHT|HEIGHT|PHL|NOTORARTY)\b/i.test(r.text)
        );
        if (licenseRowIdx > 0) {
          const startIdx = demoRowIdx >= 0 ? demoRowIdx + 1 : Math.max(0, licenseRowIdx - 2);
          for (let i = startIdx; i < licenseRowIdx; i++) {
            const rowText = rows[i].text.trim();
            if (rowText && !FIELD_LABELS.test(rowText) && !(rowText.match(DATE_VALUE) || []).length) {
              if (rowText.length >= 8 && (rowText.match(/[a-zA-ZñÑ]{2,}/g) || []).length >= 2) {
                address = rowText;
                break;
              }
            }
          }
        }
      }
      if (!address && !philSys && detectedType.code !== 'PASSPORT') {
        const ADDRESS_PATTERN = /\b(?:P(?:UROK)?[\s\-]?\d+|SITIO|BRGY\.?|BARANGAY|BGY\.?|ZONE|CAMP|BASE\s*CAMP|BLOCK|BLK\.?|LOT|PHASE|SUBD(?:IVISION)?|VILLAGE|VIL\.?|POB(?:LACION)?|ST(?:REET)?|AVE(?:NUE)?|RD|ROAD|HWY|HIGHWAY|CITY|MUN(?:ICIPALITY)?|PROV(?:INCE)?|MANILA|CEBU|DAVAO|ILOILO|BACOLOD|BUKIDNON|BULACAN|CAVITE|LAGUNA|RIZAL|BATANGAS|PAMPANGA|PANGASINAN|TARLAC|BENGUET|PALAWAN|LEYTE|BOHOL|MISAMIS|COTABATO|CAGAYAN|SURIGAO|AGUSAN|ZAMBOANGA|QUEZON|CALOOCAN|PASIG|TAGUIG|MAKATI|NEGROS)\b/i;
        const lineIdx = lines.findIndex(line => {
          if ((line.match(DATE_VALUE) || []).length) return false;
          if (FIELD_LABELS.test(line) || DOCUMENT_HEADING.test(line)) return false;
          if (extractIdNumber(line, detectedType.code)) return false;
          return /^\d+\s+[a-zA-Z].{6,}/.test(line) || ADDRESS_PATTERN.test(line);
        });
        if (lineIdx >= 0) {
          const parts = [lines[lineIdx]];
          for (let next = lineIdx + 1; next < Math.min(lineIdx + 3, lines.length); next++) {
            if (FIELD_LABELS.test(lines[next]) || DOCUMENT_HEADING.test(lines[next])) break;
            if (extractIdNumber(lines[next], detectedType.code)) break;
            if ((lines[next].match(DATE_VALUE) || []).length) break;
            if (lines[next].length > 2) parts.push(lines[next]);
          }
          address = parts.join(', ');
        }
      }
      address = DOCUMENT_HEADING.test(address) ? '' : normalizeText(address);
      if (!philSys) address = address.replace(/([A-Z0-9])\.\s+([A-Z0-9])/g, '$1, $2');
      address = address
        .replace(/^NN[,:\-\s]+/i, '')
        .replace(/^[\s,.\-\/|]+|[\s,.\-\/|#]+$/g, '')
        .slice(0, 255);

      // 6. Extract Sex / Gender
      const sex = extractSex(text);

      const expiryDatePresent = EXPIRY_LABEL.test(text);
      const expiryDate = layoutDate(rows, EXPIRY_LABEL) || labeledDate(lines, EXPIRY_LABEL) ||
        (!expiryDatePresent && detectedType.code === 'DRIVERS_LICENSE' ? extractLicenseExpiry(lines) : '') ||
        (policy.expiryRequirement(detectedType.code) === 'not_applicable' ? null : '');

      return {
        fullName,
        birthDate,
        address,
        idType: detectedType.code,
        idTypeLabel: detectedType.label,
        idNumber,
        expiryDate,
        expiryDatePresent,
        sex,
        nationality: '',
        standardized: detectedType.standardized
      };
    } catch (error) {
      console.error('[IdIdentityService] Identity parsing failed.');
      return {
        fullName: '',
        birthDate: '',
        address: '',
        idType: 'UNKNOWN',
        idTypeLabel: 'Unknown / Generic ID',
        idNumber: '',
        expiryDate: '',
        sex: '',
        nationality: '',
        standardized: false
      };
    }
  }

  function agreeIdentityField(first, second) {
    if (!first || !second) return '';
    const tokens = value => value.normalize('NFC').toUpperCase().replace(/[^\p{L}\p{M}\d]+/gu, ' ').trim();
    return tokens(first) === tokens(second) ? first : '';
  }

  function corroboratePhilSysAddress(first, second, documentTexts) {
    const agreement = agreeIdentityField(first, second);
    if (agreement) return agreement;

    const labeled = documentTexts.map(text => philSysAddress(getLines(text))).filter(Boolean);
    const confirmed = [first, second].filter(candidate =>
      labeled.some(address => agreeIdentityField(candidate, address)));
    return confirmed.length === 1 ? confirmed[0] : '';
  }

  function consistentPhilSysDocumentField(readings, field, focused) {
    // Layout guesses can shift the crop. Require at least two document
    // readings to agree, and leave the field blank when a crop contradicts them.
    const values = readings.filter(reading => reading?.idType === 'PHILSYS')
      .map(reading => reading[field]).filter(Boolean);
    const first = values[0];
    return values.length >= 2 && [...values, ...focused.filter(Boolean)]
      .every(value => agreeIdentityField(first, value)) ? first : '';
  }

  function prepareScanFields(fields) {
    const idRule = SUPPORTED_ID_TYPES[fields.idType]?.idNumberRegex;
    const idNumber = fields.idNumber?.trim() || '';
    return {
      ...fields,
      address: DOCUMENT_HEADING.test(fields.address || '') ||
        (fields.idType === 'PHILSYS' && !PHYSICAL_ADDRESS_PREFIX.test(fields.address || '')) ? '' : fields.address,
      idNumber: idNumber && idRule?.exec(idNumber)?.[0] === idNumber ? idNumber : ''
    };
  }

  function validateDocumentFields(fieldsOrRawText, referenceDate = new Date()) {
    const fields = typeof fieldsOrRawText === 'string'
      ? extractIdentityFields(fieldsOrRawText)
      : (fieldsOrRawText || {});

    const missingFields = [];
    const issues = [];

    if (!fields.fullName || fields.fullName.trim().length < 3) {
      missingFields.push('fullName');
      issues.push('Missing or unreadable full name.');
    }
    if (!fields.birthDate) {
      missingFields.push('birthDate');
      issues.push('Missing or invalid date of birth.');
    }
    if (!fields.address) {
      missingFields.push('address');
      issues.push('Missing or unreadable address.');
    }
    if (!fields.idType || fields.idType === 'UNKNOWN') {
      missingFields.push('idType');
      issues.push('Unrecognized ID type.');
    }
    if (!fields.idNumber) {
      missingFields.push('idNumber');
      issues.push('Missing or unreadable ID number.');
    }

    const validity = policy.expiration(fields.idType, fields.expiryDate, {
      referenceDate, expiryDatePresent: fields.expiryDatePresent
    });
    if (validity.requiresDate && validity.isExpired === null) {
      missingFields.push('expiryDate');
      issues.push('Enter the expiration date printed on the ID.');
    }
    if (validity.isExpired) issues.push('The document has expired.');

    // Scoring heuristic (0-100)
    let score = 0;
    if (fields.fullName) score += 25;
    if (fields.birthDate) score += 20;
    if (fields.address) score += 20;
    if (fields.idType && fields.idType !== 'UNKNOWN') score += 15;
    if (fields.idNumber) score += 20;

    let state;
    if (score >= 80 && fields.idType && fields.idType !== 'UNKNOWN' && !validity.isExpired && missingFields.length === 0) {
      state = VALIDATION_STATES.DOCUMENT_DETECTED;
    } else if (score >= 40 || validity.isExpired) {
      state = VALIDATION_STATES.NEEDS_MANUAL_REVIEW;
    } else {
      state = VALIDATION_STATES.REJECTED;
    }

    return {
      state,
      isExpired: validity.isExpired,
      expirationStatus: validity.status,
      confidenceScore: score,
      missingFields,
      issues,
      disclaimer: DISCLAIMER_TEXT
    };
  }

  function createIdentityDTO(parsedFields, validationResult) {
    const fields = parsedFields || {};
    const validation = validationResult || validateDocumentFields(fields);

    return {
      documentType: fields.idType || 'UNKNOWN',
      documentTypeLabel: fields.idTypeLabel || 'Unknown / Generic ID',
      idNumber: fields.idNumber || null,
      fullName: fields.fullName || '',
      birthDate: fields.birthDate || null,
      expiryDate: fields.expiryDate || null,
      sex: fields.sex || null,
      nationality: fields.nationality || null,
      address: fields.address || '',
      validationState: validation.state || VALIDATION_STATES.PENDING_REVIEW,
      confidenceScore: validation.confidenceScore ?? 0,
      isExpired: validation.isExpired ?? null,
      expirationStatus: validation.expirationStatus,
      standardizedFormat: Boolean(fields.standardized),
      disclaimer: DISCLAIMER_TEXT
    };
  }

  function stripPurokDetails(text) {
    return String(text || '')
      .replace(/\b(?:purok|prk\.?|puk\.?)\s*[^,\n\r;]+/gi, ' ')
      .replace(/\b(?:zone|phase|blk|block|lot|sitio)\s*[^,\n\r;]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getTokens(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }


  async function compareLocationWithIdAddress({
    idAddress,
    latitude,
    longitude,
    reverseGeocodeProvider = 'nominatim'
  } = {}) {
    try {
      const hasId = typeof idAddress === 'string' && idAddress.trim().length > 0;
      const latNum = latitude !== null && latitude !== undefined && latitude !== '' ? Number(latitude) : NaN;
      const lngNum = longitude !== null && longitude !== undefined && longitude !== '' ? Number(longitude) : NaN;
      const hasGps = Number.isFinite(latNum) && Number.isFinite(lngNum) && (latNum !== 0 || lngNum !== 0);

      if (!hasId || !hasGps) {
        return {
          ok: false,
          matches: false,
          similarity: 0,
          idBarangay: null,
          liveBarangay: null,
          message: 'Insufficient address or GPS data; comparison cannot be performed.'
        };
      }

      let geoAddress = '';
      if (typeof window !== 'undefined' && window.ReverseGeocode && typeof window.ReverseGeocode.lookup === 'function') {
        const geo = await window.ReverseGeocode.lookup({ latitude, longitude, provider: reverseGeocodeProvider });
        geoAddress = geo?.formattedAddress || geo?.displayName || '';
      }

      const cleanedId = stripPurokDetails(idAddress);
      const idTokens = new Set(getTokens(cleanedId));
      const liveTokens = new Set(getTokens(geoAddress));

      const overlap = [...idTokens].filter(token => liveTokens.has(token)).length;
      const total = Math.max(idTokens.size, liveTokens.size);
      const similarity = total ? overlap / total : 0;

      // Extract official Barangay only — ignore Purok/Prk
      const idBarangay = typeof window !== 'undefined' && typeof window.normalizeToOfficialBarangay === 'function'
        ? (window.normalizeToOfficialBarangay(idAddress) || window.normalizeToOfficialBarangay(cleanedId))
        : null;

      let liveBarangay = null;
      if (typeof window !== 'undefined' && typeof window.normalizeToOfficialBarangay === 'function') {
        liveBarangay = window.normalizeToOfficialBarangay(geoAddress);
      }
      if (!liveBarangay && typeof window !== 'undefined') {
        const reference = await window.BacolodMap?.reportAreaAt({ lat: latNum, lng: lngNum }, accuracy);
        liveBarangay = reference?.feature?.properties.name || null;
      }

      // Barangay matching logic (Purok/Prk excluded)
      const barangayMatch = Boolean(idBarangay && liveBarangay && idBarangay.toLowerCase() === liveBarangay.toLowerCase());
      const isOfficialBacolodBarangay = Boolean(idBarangay && Array.isArray(window?.BACOLOD_BARANGAYS) && window.BACOLOD_BARANGAYS.includes(idBarangay));
      const hasBacolodAffiliation = /bacolod|negros/i.test(idAddress);

      const isVerified = barangayMatch || (isOfficialBacolodBarangay && (hasBacolodAffiliation || similarity >= 0.15));

      return {
        ok: true,
        matches: isVerified,
        similarity,
        liveAddress: geoAddress,
        idBarangay: idBarangay || null,
        liveBarangay: liveBarangay || null,
        message: isVerified
          ? ` Barangay verified: ${idBarangay || liveBarangay} (Purok not required).`
          : `The ID address must belong to an official Bacolod Barangay.`
      };
    } catch (error) {
      console.error('[IdIdentityService] compareLocationWithIdAddress error:', error);
      return {
        ok: false,
        matches: false,
        similarity: 0,
        idBarangay: null,
        liveBarangay: null,
        message: 'Address validation error occurred; cannot verify location match.'
      };
    }
  }

  const IdIdentityService = {
    SUPPORTED_ID_TYPES,
    VALIDATION_STATES,
    DISCLAIMER_TEXT,
    extractIdentityFields,
    prepareScanFields,
    agreeIdentityField,
    corroboratePhilSysAddress,
    consistentPhilSysDocumentField,
    identityScanRegions,
    readIdentityRegion,
    mergeIdentityReadings,
    validateDocumentFields,
    createIdentityDTO,
    compareLocationWithIdAddress
  };

  if (typeof window !== 'undefined') {
    window.IdIdentityService = IdIdentityService;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = IdIdentityService;
  }
})();

