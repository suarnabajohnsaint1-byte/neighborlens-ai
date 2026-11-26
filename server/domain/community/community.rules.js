const { ValidationError, ForbiddenError } = require('../errors');
const { statuses } = require('../../../shared/reportVocabulary');

function id(value) {
  if (!/^[1-9]\d{0,9}$/.test(String(value)) || Number(value) > 2147483647) throw new ValidationError('Invalid community record ID.');
  return Number(value);
}

function parentId(value) {
  if (value === undefined || value === null || value === '') return null;
  return id(value);
}

function member(user) {
  if (!['citizen', 'barangay'].includes(user?.role) || !Number.isSafeInteger(Number(user.barangayId)) || Number(user.barangayId) < 1) {
    throw new ForbiddenError('An active barangay membership is required.');
  }
  return Number(user.barangayId);
}

function viewer(user) {
  if (!['citizen', 'barangay'].includes(user?.role)) throw new ForbiddenError('An authenticated community account is required.');
}

function text(value, maximum, required = true) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) throw new ValidationError(`Enter text within ${maximum} characters.`);
  return value.trim();
}

function key(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(value)) throw new ValidationError('A valid request key is required.');
  return value;
}

function query(input = {}) {
  if (Object.keys(input).some(name => !['page', 'pageSize', 'search', 'sort', 'status', 'official', 'scope', 'barangay', 'barangayId'].includes(name))) throw new ValidationError('Unsupported community filter.');
  const page = input.page === undefined ? 1 : id(input.page);
  const size = input.pageSize === undefined ? 10 : id(input.pageSize);
  if (page > 1000 || size > 20) throw new ValidationError('Community pagination exceeds its limit.');
  const sort = input.sort || 'latest';
  if (!['latest', 'oldest', 'reacted'].includes(sort)) throw new ValidationError('Invalid community sort.');
  const status = input.status ?? 'all';
  if (!['all', ...Object.keys(statuses)].includes(status)) throw new ValidationError('Invalid report status filter.');
  if (input.official !== undefined && !['true', 'false'].includes(input.official)) throw new ValidationError('Invalid official filter.');
  const { scope } = input;
  if (scope !== undefined && !['local', 'citywide'].includes(scope)) throw new ValidationError('Invalid community area.');
  if (scope !== undefined && (input.barangay !== undefined || input.barangayId !== undefined)) throw new ValidationError('Choose one community area filter.');
  if (input.barangay !== undefined && input.barangayId !== undefined) throw new ValidationError('Choose one Barangay filter.');
  const rawBarangay = input.barangay !== undefined ? input.barangay : input.barangayId;
  if (rawBarangay !== undefined && (typeof rawBarangay !== 'string' && typeof rawBarangay !== 'number')) throw new ValidationError('Invalid Barangay filter.');
  const barangay = (rawBarangay !== undefined && rawBarangay !== null && String(rawBarangay).trim() !== '' && String(rawBarangay).trim().toLowerCase() !== 'all')
    ? text(String(rawBarangay), 120, false)
    : null;
  if (barangay && /^\d+$/.test(barangay)) id(barangay);
  return { page, size, search: input.search === undefined ? '' : text(input.search, 120, false), sort, status, official: input.official === 'true', barangay, scope };
}

function addressBarangay(address, catalog) {
  const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\b(?:brgy|bgy)\b/g, 'barangay').replace(/\bbarangay 0+(?=\d)/g, 'barangay ');
  const parts = address.split(/[,\n]+/).map(normalize).filter(Boolean);
  const fullAddress = ` ${parts.join(' ')} `;
  const cityIndex = fullAddress.search(/ (?:city of )?bacolod /);
  const beforeCity = cityIndex < 0 ? '' : fullAddress.slice(0, cityIndex);
  const candidates = catalog.filter(row => row.city === 'Bacolod City').map(row => {
    const name = normalize(row.name);
    const numbered = name.startsWith('barangay ');
    const explicit = numbered ? name : `barangay ${name}`;
    const priority = numbered && cityIndex < 0 ? 0
      : fullAddress.includes(` ${explicit} `) ? 3
      : parts.includes(name) ? 2
        : cityIndex >= 0 && beforeCity.endsWith(` ${name}`) ? 1 : 0;
    return { row, priority };
  });
  for (const priority of [3, 2, 1]) {
    const matches = candidates.filter(candidate => candidate.priority === priority);
    if (matches.length) return matches.length === 1 ? matches[0].row : null;
  }
  return null;
}

function commentQuery(input = {}) {
  const { parentCommentId, ...rest } = input;
  return { ...query({ ...rest, pageSize: rest.pageSize ?? 5 }), parent: parentId(parentCommentId) };
}

function reaction(value) {
  if (![null, 'like', 'heart'].includes(value)) throw new ValidationError('Select Like, Heart, or remove the reaction.');
  return value;
}

function owner(row, user) {
  if (Number(row.author_id) !== Number(user.id)) throw new ForbiddenError('Only the author can change this content.');
}

function generatePersona(firstSeed, secondSeed, attempt = 0) {
  const adjectives = ['Lucky', 'Calm', 'Brave', 'Clever', 'Swift', 'Gentle', 'Bright', 'Steady', 'Wise', 'Merry', 'Quiet', 'Silver'];
  const nouns = ['Fox', 'Panda', 'Koala', 'Otter', 'Owl', 'Capybara', 'Hawk', 'Falcon', 'Robin', 'Deer', 'Badger', 'Finch'];
  const p = Math.abs(Number(firstSeed) || 1);
  const u = Math.abs(Number(secondSeed) || 1);
  const seed = (p * 43 + u * 97 + attempt * 257) >>> 0;
  const adjIndex = (seed + attempt) % adjectives.length;
  const nounIndex = ((seed * 7) + attempt * 3) % nouns.length;
  const num = ((seed * 13 + attempt * 79) % 900) + 100;
  const displayName = `${adjectives[adjIndex]}${nouns[nounIndex]}_${num}`;
  const avatarVariant = nounIndex % 4;
  return { displayName, avatarVariant };
}

function author(row) {
  const isOfficial = Boolean(row.is_official);
  const pseudonymValue = isOfficial
    ? `Barangay ${row.barangay}`.replace('Barangay Barangay ', 'Barangay ')
    : (row.author_pseudonym || 'Anonymous resident');
  const variant = isOfficial
    ? 0
    : (row.author_avatar_variant !== undefined && row.author_avatar_variant !== null
      ? Number(row.author_avatar_variant)
      : 0);
  const out = {
    label: isOfficial ? `Barangay ${row.barangay}`.replace('Barangay Barangay ', 'Barangay ') : 'Anonymous resident',
    official: isOfficial
  };
  Object.defineProperties(out, {
    pseudonym: {
      value: pseudonymValue,
      enumerable: false,
      writable: true,
      configurable: true
    },
    avatarVariant: {
      value: variant,
      enumerable: false,
      writable: true,
      configurable: true
    }
  });
  return out;
}

module.exports = { id, parentId, member, viewer, text, key, query, addressBarangay, commentQuery, reaction, owner, author, generatePersona };
