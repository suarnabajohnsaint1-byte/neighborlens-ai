const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function nullableText(value, max = 255) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim()

  if (!normalized) return null;

  return normalized.slice(0, max)
}

function nullableIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return undefined;

  const [year, month, day] = value.split('-').map(Number);

  const parsed = new Date(Date.UTC(year, month - 1, day));

  const isValid = parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;

  return isValid ? value : undefined;
}

function nullableConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) return undefined;
  return number > 1 ? Number((number / 100).toFixed(4)) : Number(number.toFixed(4));
}


function validateIdentityDto(body = {}) {
  const documentType = nullableText(body.documentType, 50);
  const idNumber = nullableText(body.idNumber, 100);
  const fullName = nullableText(body.fullName, 190);
  const address = nullableText(body.address, 255);
  const birthDate = nullableIsoDate(body.birthDate);
  const expiryDate = nullableIsoDate(body.expiryDate);
  const ocrConfidence = nullableConfidence(body.ocrConfidence);

  const fields = { documentType, idNumber, fullName, address, birthDate, expiryDate, ocrConfidence };
  const invalidField = Object.entries(fields).find(([, v]) => v === undefined);
  if (invalidField) {
    return { error: `Invalid value for field "${invalidField[0]}".` };
  }

  return { value: fields };
}

module.exports = { validateIdentityDto };
