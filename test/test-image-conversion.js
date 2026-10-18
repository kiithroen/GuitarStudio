const assert = require('node:assert/strict');
const buildAiPromptText = require('../src/ai-prompt.js');

const sourceText = '\\title "safe"\n\\ts (3 4)\n:4 3.5';
const prompt = buildAiPromptText(sourceText);

assert.match(prompt, /alphaTab 1\.8\.4 alphaTex/);
assert.match(prompt, /프렛\.현/);
assert.match(prompt, /3\.5는 5번 현 3프렛/);
assert.match(prompt, /:4 3\.5/);
assert.match(prompt, /동시음은 괄호로 묶어 \(0\.3 1\.2\)/);
assert.match(prompt, /\\voice/);
assert.match(prompt, /\\ts \(3 4\)/);
assert.match(prompt, /\\capo 5/);
assert.match(prompt, /lf 값은 1 엄지/);
assert.match(prompt, /"\\\\title/);
assert.match(prompt, /불확실성 목록/);
assert.doesNotMatch(prompt, /12프렛보다 높은.*미지원/);
assert.doesNotMatch(prompt, /표준 튜닝이 아닌.*출력을 중단/);

process.stdout.write('Result: alphaTex image prompt checks passed (13 assertions)\n');
