const { randomInt } = require('node:crypto');
const { generatePersona } = require('../../domain/community/community.rules');
module.exports = { generate: () => generatePersona(randomInt(1, 10000000), randomInt(1, 10000000), randomInt(1, 10000000)) };
