const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');


const SERVER = path.join(__dirname, '..');

function sourceFiles(dir = SERVER) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return dir === SERVER && entry.name === 'tests' ? [] : sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

function readCode(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceImports(source) {
  const patterns = [
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\b(?:import|export)\s+(?:[^;'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g
  ];
  return patterns.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1]));
}

function requiresIn(file) {
  return sourceImports(readCode(file));
}

function relative(file) {
  return path.relative(SERVER, file);
}

function filesIn(folder) {
  const dir = path.join(SERVER, folder);
  return fs.existsSync(dir) ? sourceFiles(dir) : [];
}

function resolveSpecifier(file, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  return path.relative(SERVER, path.resolve(path.dirname(file), specifier));
}

const SQL_PATTERN = /\b(SELECT\s+[\w*`]|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i;


test('no server/src, modules or bootstrap directory exists', () => {
  const forbidden = ['src', 'modules', 'bootstrap'];
  const present = forbidden.filter(name => fs.existsSync(path.join(SERVER, name)));
  assert.deepEqual(present, [], `the feature-first layout must not return:\n${present.join('\n')}`);

  const nested = sourceFiles()
    .map(relative)
    .filter(rel => /(^|[\\/])(modules|usecases|bootstrap)[\\/]/.test(rel));
  assert.deepEqual(nested, [], `no nested feature-first folders:\n${nested.join('\n')}`);
});

test('no file imports anything from the abandoned server/src tree', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    for (const specifier of requiresIn(file)) {
      if (/server\/src|\/src\//.test(specifier)) offenders.push(`${relative(file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], `stale imports remain:\n${offenders.join('\n')}`);
});


test('domain holds pure rules: no express, database driver, crypto library or filesystem', () => {
  const forbidden = [
    'express', 'mysql', 'mysql2', 'sqlite', 'node:sqlite', 'jsonwebtoken', 'bcrypt', 'bcryptjs',
    'multer', 'node:child_process', 'child_process', 'node:fs', 'node:fs/promises', 'fs'
  ];
  const violations = [];
  for (const file of filesIn('domain')) {
    for (const specifier of requiresIn(file)) {
      if (forbidden.includes(specifier)) violations.push(`${relative(file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, [], `domain must stay pure:\n${violations.join('\n')}`);
});

test('domain imports nothing from application, presentation or infrastructure', () => {
  const violations = [];
  for (const file of filesIn('domain')) {
    for (const specifier of requiresIn(file)) {
      const resolved = resolveSpecifier(file, specifier);
      if (/^(application|presentation|infrastructure)[\\/]/.test(resolved)) {
        violations.push(`${relative(file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, [], `domain must not depend outward:\n${violations.join('\n')}`);
});

test('use-cases orchestrate without reaching for concrete drivers, image decoders or filesystem APIs', () => {
  const forbidden = ['express', 'mysql', 'mysql2', 'sqlite', 'node:sqlite', 'jsonwebtoken', 'bcrypt', 'bcryptjs', 'multer', '@supabase/supabase-js', 'sharp', 'crc-32', 'node:fs', 'node:fs/promises', 'fs', 'fs/promises'];
  const violations = [];
  for (const file of filesIn('application')) {
    for (const specifier of requiresIn(file)) {
      if (forbidden.includes(specifier)) violations.push(`${relative(file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, [], `use-cases must go through repositories and infrastructure:\n${violations.join('\n')}`);
});

test('architecture import scanning covers require, imports and re-exports', () => {
  assert.deepEqual(sourceImports([
    "const adapter = require('../../infrastructure/ai');",
    "import adapter from '../../infrastructure/ai';",
    "import '../../infrastructure/ai';",
    "export { adapter } from '../../infrastructure/ai';",
    "const adapter = import('../../infrastructure/ai');"
  ].join('\n')), Array(5).fill('../../infrastructure/ai'));
});

test('use-cases contain no SQL', () => {
  const violations = filesIn('application').filter(file => SQL_PATTERN.test(readCode(file))).map(relative);
  assert.deepEqual(violations, [], `SQL belongs in repositories:\n${violations.join('\n')}`);
});

test('application infrastructure imports are limited to the exact remaining Phase 0 debt', () => {
  const remaining = [
    'application/use-cases/audit.service.js -> infrastructure/repositories/auditLog.repository',
    'application/use-cases/auth.service.js -> infrastructure/repositories/user.repository',
    'application/use-cases/auth.service.js -> infrastructure/security/passwordHasher',
    'application/use-cases/auth.service.js -> infrastructure/security/tokenProvider',
    'application/use-cases/citizenIdentity.service.js -> infrastructure/repositories/citizenIdentity.repository'
  ];
  const actual = [];
  for (const file of filesIn('application')) {
    for (const specifier of requiresIn(file)) {
      const resolved = resolveSpecifier(file, specifier).replaceAll('\\', '/');
      if (/^(infrastructure|presentation)\//.test(resolved) || /^(composition|app)(\.js)?$/.test(resolved)) {
        actual.push(`${relative(file).replaceAll('\\', '/')} -> ${resolved}`);
      }
    }
  }
  assert.deepEqual(actual.sort(), remaining.sort(), 'No new outward imports are allowed, including in Phase 1A services. Update the debt only when an existing violation is removed.');
});

test('controllers and routes stay thin', () => {
  const businessLogic = [
    { name: 'raw SQL', pattern: SQL_PATTERN },
    { name: 'point-in-polygon geometry', pattern: /pointInPolygon|inlier_ratio\s*=/i },
    { name: 'confidence thresholding', pattern: /minConfidence\s*[<>=]|confidence_score\s*>=/ },
    { name: 'identity conclusion derivation', pattern: /deriveIsExpired|deriveFormatCheckStatus|deriveDocumentValidationStatus/ },
    { name: 'password hashing', pattern: /bcrypt|hashSync|compareSync/ },
    { name: 'a direct repository import', pattern: /require\([^)]*repositories\// }
  ];

  const violations = [];
  for (const file of [...filesIn('presentation/http/controllers'), ...filesIn('presentation/http/routes')]) {
    const source = readCode(file);
    for (const { name, pattern } of businessLogic) {
      if (pattern.test(source)) violations.push(`${relative(file)} contains ${name}`);
    }
  }
  assert.deepEqual(violations, [], `controllers and routes must delegate:\n${violations.join('\n')}`);
});

test('routes declare endpoints only and never import a repository or a database', () => {
  const violations = [];
  for (const file of filesIn('presentation/http/routes')) {
    for (const specifier of requiresIn(file)) {
      const resolved = resolveSpecifier(file, specifier);
      if (/^(repositories|infrastructure)[\\/]/.test(resolved)) {
        violations.push(`${relative(file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, [], `routes must only wire middleware and controllers:\n${violations.join('\n')}`);
});

test('the AI controller resolves its use cases through composition', () => {
  const controller = path.join(SERVER, 'presentation/http/controllers/ai.controller.js');
  const dependencies = requiresIn(controller).map(specifier => resolveSpecifier(controller, specifier).replaceAll('\\', '/'));
  assert.ok(dependencies.includes('composition'));
  assert.deepEqual(dependencies.filter(dependency => /^(application|infrastructure)\//.test(dependency)), []);
});

test('repositories own persistence and carry no HTTP concern', () => {
  const violations = [];
  for (const file of filesIn('infrastructure/repositories')) {
    const source = readCode(file);
    if (/\bexpress\b|req\.|res\.status|res\.json/.test(source)) {
      violations.push(`${relative(file)} contains an HTTP concern`);
    }
    for (const specifier of requiresIn(file)) {
      const resolved = resolveSpecifier(file, specifier);
      if (/^(application|presentation)[\\/]/.test(resolved)) {
        violations.push(`${relative(file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, [], `repositories must stay a persistence boundary:\n${violations.join('\n')}`);
});

test('SQL appears only in repositories, database infrastructure, and migrations', () => {
  const allowed = /^infrastructure[\\/](repositories|database)[\\/]/;
  const violations = sourceFiles()
    .filter(file => !allowed.test(relative(file)))
    .filter(file => SQL_PATTERN.test(readCode(file)))
    .map(relative);

  assert.deepEqual(violations, [], `SQL escaped the persistence layer:\n${violations.join('\n')}`);
});


test('MySQL is the only driver normal runtime can select', () => {
  const selector = readCode(path.join(SERVER, 'infrastructure', 'database', 'index.js'));
  assert.equal(/sqlite/i.test(selector), false, 'the selector must not reference sqlite outside a comment');
  assert.match(selector, /RUNTIME_DRIVER = 'mysql'/);
});

test('nothing outside the database folder and tests constructs the sqlite adapter', () => {
  const violations = sourceFiles()
    .filter(file => !relative(file).startsWith(path.join('infrastructure', 'database')))
    .filter(file => /sqlite/i.test(readCode(file)))
    .map(relative);

  assert.deepEqual(violations, [],
    `SQLite is test-only and must not be reachable from runtime code:\n${violations.join('\n')}`);
});

test('no code path turns a MySQL failure into a different database', () => {
  const fallbackShapes = [
    /catch[\s\S]{0,120}sqlite/i,
    /catch[\s\S]{0,120}fallback/i,
    /\|\|\s*createSqlite/i
  ];
  const violations = [];
  for (const file of sourceFiles()) {
    const source = readCode(file);
    for (const pattern of fallbackShapes) {
      if (pattern.test(source)) violations.push(relative(file));
    }
  }
  assert.deepEqual(violations, [], `a silent database fallback would invalidate every test:\n${violations.join('\n')}`);
});



test('no layer smuggles a dependency in through a dynamic require', () => {
  const violations = sourceFiles()
    .filter(file => /\b(?:require|import)\(\s*(?!['"])/.test(readCode(file)))
    .map(relative);

  assert.deepEqual(violations, [], `dynamic requires bypass the static checks:\n${violations.join('\n')}`);
});

test('no duplicate backend implementation is left behind', () => {
  const expected = ['domain', 'application', 'infrastructure', 'presentation'];
  for (const folder of expected) {
    assert.ok(fs.existsSync(path.join(SERVER, folder)), `server/${folder} must exist`);
  }

  const legacy = ['controllers', 'routes', 'services', 'repositories', 'middleware', 'validation', 'config'];
  const present = legacy.filter(name => fs.existsSync(path.join(SERVER, name)));
  assert.deepEqual(present, [], `pre-layered folders must not coexist with the layered layout:\n${present.join('\n')}`);
});
