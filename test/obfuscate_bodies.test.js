// Unit tests for the per-function-body obfuscation logic in minify_code.js.
//
// These validate the NEW risky parts — parsing, outermost-function detection,
// byte-faithful splicing, and relocation of the obfuscator's program-scope
// bootstrap into each body — using a stand-in obfuscator. The real
// javascript-obfuscator is a mature black box; it is not exercised here (and in
// this sandbox it can't even be require()'d). Run the real end-to-end pass in
// the actual Cordova build environment.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var acorn = require('acorn');

var plugin = require('../minify_code.js');
var T = plugin.__test__;

// A stand-in for javascript-obfuscator that mimics the SHAPE of its output for
// input of the form `var __o = <function>{ BODY };`:
//   * injects a program-scope "string array" statement (the bootstrap we must
//     relocate into the body), and
//   * marks the wrapper function body with /*BODYOBF*/ so we can prove the body
//     region was replaced.
// It does not rename or encode anything — that is the real tool's job, not what
// these tests cover.
function mockObfuscate(program /*, opts */) {
    var openBrace = program.indexOf('{'); // first '{' is the wrapper fn body
    var head = program.slice(0, openBrace + 1); // 'var __o = ... function(){'
    var rest = program.slice(openBrace + 1);    // ' BODY \n};'
    var out = "var _0xMOCKARR=['obf'];" + head + '/*BODYOBF*/' + rest;
    return { getObfuscatedCode: function () { return out; } };
}
T.setObfuscator({ obfuscate: mockObfuscate });

var results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (e) { results.push([false, name + ' -> ' + (e && e.message)]); }
}

var TARGET = path.resolve(__dirname, '../../sequence_decoder_meltino/www/js/pullrefresh.kartnip.2.0.js');
var code = fs.readFileSync(TARGET, 'utf8');

test('parses the real target file', function () {
    var ast = T.parseFlexible(code);
    assert.strictEqual(ast.type, 'Program');
});

test('finds the expected outermost functions', function () {
    var ast = T.parseFlexible(code);
    var fns = T.collectOutermostFunctions(ast);
    // ready() callback + 9 pullRefresh.* methods.
    assert.ok(fns.length >= 9, 'expected >=9 functions, got ' + fns.length);
    fns.forEach(function (fn) {
        assert.strictEqual(fn.body.type, 'BlockStatement');
    });
});

var transformed = T.transformSource(code);

test('output is still valid JavaScript', function () {
    new (require('vm').Script)(transformed); // throws on syntax error
});

test('NAMESPACE preserved: global object declaration untouched', function () {
    assert.ok(transformed.indexOf('var pullRefresh =') !== -1);
});

test('NAMESPACE preserved: object-literal property keys untouched', function () {
    ['ignoreActiveGesture: false', 'startedSwiping: false', 'pStart: {x:0, y:0}']
        .forEach(function (s) { assert.ok(transformed.indexOf(s) !== -1, 'missing: ' + s); });
});

test('NAMESPACE preserved: method names / assignment headers untouched', function () {
    ['pullRefresh.swipeStart = function', 'pullRefresh.swipeMove = function',
     'pullRefresh.pullRefreshDomExists = function', 'pullRefresh.startPullRefresh = function']
        .forEach(function (s) { assert.ok(transformed.indexOf(s) !== -1, 'missing: ' + s); });
});

test('NAMESPACE preserved: cross-namespace calls kept literal', function () {
    // These are referenced from inside bodies but must stay spelled the same so
    // the real obfuscator (renameGlobals:false) leaves them resolvable.
    ['sequence.browserRefresh', 'ons.notification.alert', 'isOnline']
        .forEach(function (s) { assert.ok(transformed.indexOf(s) !== -1, 'missing: ' + s); });
});

test('NAMESPACE preserved: everything before the first function body is byte-identical', function () {
    var ast = T.parseFlexible(code);
    var fns = T.collectOutermostFunctions(ast);
    var firstOpen = Math.min.apply(null, fns.map(function (f) { return f.body.start + 1; }));
    assert.strictEqual(transformed.slice(0, firstOpen), code.slice(0, firstOpen));
});

test('BODIES obfuscated: transform marker present', function () {
    assert.ok(transformed.indexOf('/*BODYOBF*/') !== -1);
});

test('BODIES self-contained: bootstrap relocated INSIDE bodies (not at file scope)', function () {
    assert.ok(transformed.indexOf('_0xMOCKARR') !== -1, 'bootstrap missing');
    // The real proof that nothing leaked to program scope: the transformed file
    // must have the SAME top-level statements as the original (same count, and
    // no top-level statement is directly the injected bootstrap declaration).
    var before = T.parseFlexible(code).body;
    var after = T.parseFlexible(transformed).body;
    assert.strictEqual(after.length, before.length,
        'top-level statement count changed: ' + before.length + ' -> ' + after.length);
    after.forEach(function (stmt) {
        var isBootstrap = stmt.type === 'VariableDeclaration' && stmt.declarations.some(function (d) {
            return d.id && d.id.name === '_0xMOCKARR';
        });
        assert.ok(!isBootstrap, 'bootstrap leaked to program scope');
    });
});

test('empty function body is left untouched', function () {
    var src = 'var x = 1;\nfunction noop(){}\n';
    var out = T.transformSource(src);
    assert.strictEqual(out, src);
});

test('a file with no functions is returned unchanged', function () {
    var src = "var ns = { a: 1, b: 'keep-me' };\nns.c = 3;\n";
    assert.strictEqual(T.transformSource(src), src);
});

test('async/generator flags select a matching wrapper (await/yield parse)', function () {
    // With a non-matching wrapper these bodies would fail to parse and be
    // skipped; matching wrappers let them transform. We assert they DID change.
    var asyncSrc = 'foo.bar = async function(){ await go(); return 1; };';
    var genSrc = 'foo.baz = function*(){ yield 1; yield 2; };';
    assert.ok(T.transformSource(asyncSrc).indexOf('/*BODYOBF*/') !== -1, 'async body not transformed');
    assert.ok(T.transformSource(genSrc).indexOf('/*BODYOBF*/') !== -1, 'generator body not transformed');
});

test('assumption holds: a `super` body is illegal in a plain wrapper (=> real tool skips it)', function () {
    // obfuscateBody wraps a body as `var __o = function(){ ... }`. A body using
    // `super` makes that wrapper a syntax error, so the real obfuscator throws
    // and obfuscateBody returns null (leaving the method untouched). Confirm the
    // wrapper really is unparseable, which is what our try/catch relies on.
    var threw = false;
    try { acorn.parse('var __o = function(){ super.foo(); };', { ecmaVersion: 'latest' }); }
    catch (e) { threw = true; }
    assert.ok(threw, 'expected super-in-plain-function to be a parse error');
});

test('isAppAuthoredJs: app files in, vendor/framework out', function () {
    assert.strictEqual(T.isAppAuthoredJs(path.join('js', 'pullrefresh.kartnip.2.0.js')), true);
    assert.strictEqual(T.isAppAuthoredJs(path.join('js', 'index.js')), true);
    assert.strictEqual(T.isAppAuthoredJs(path.join('js', 'lib', 'jquery.js')), false);
    assert.strictEqual(T.isAppAuthoredJs(path.join('js', 'app.min.js')), false);
    assert.strictEqual(T.isAppAuthoredJs('cordova.js'), false);
    assert.strictEqual(T.isAppAuthoredJs('cordova_plugins.js'), false);
    assert.strictEqual(T.isAppAuthoredJs(path.join('plugins', 'x', 'www', 'y.js')), false);
});

// -------- report --------
var failed = results.filter(function (r) { return !r[0]; });
results.forEach(function (r) { console.log((r[0] ? 'PASS ' : 'FAIL ') + r[1]); });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
