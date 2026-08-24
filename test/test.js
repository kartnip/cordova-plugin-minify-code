var fs = require('fs');
var path = require('path');
var os = require('os');
var assert = require('assert');
var vm = require('vm');

var PLUGIN_ROOT = __dirname.slice(0, -5);

// Small manual recursive copy — avoids assuming fs.cpSync (Node >=16.7) and
// avoids relying on git (keeps this test self-contained and independent of
// working-tree state), consistent with this plugin's zero-devDependency
// style.
function copyRecursive(src, dest) {
    var stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach(function (entry) {
            copyRecursive(path.join(src, entry), path.join(dest, entry));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

// Copies this plugin's own fixtures into a fresh temp directory, so running
// the suite doesn't mutate the committed www/ and platforms/ trees (the old
// version of this test did exactly that, in place, with no reset — harmless
// for a pure crash-smoke-test, but not safe for the "does the destination
// end up with the right content" assertions below, which need a known
// starting state on every run).
function freshFixtureRoot() {
    var tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minify-code-test-'));
    copyRecursive(path.join(PLUGIN_ROOT, 'www'), path.join(tempRoot, 'www'));
    copyRecursive(path.join(PLUGIN_ROOT, 'platforms'), path.join(tempRoot, 'platforms'));
    return tempRoot;
}

var PLATFORM_WWW_PATHS = {
    ios: function (root) { return path.join(root, 'platforms', 'ios', 'www'); },
    windows: function (root) { return path.join(root, 'platforms', 'windows', 'www'); },
    android: function (root) { return path.join(root, 'platforms', 'android', 'app', 'src', 'main', 'assets', 'www'); }
};

function readIfExists(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

// Executes obfuscated code in a bare sandbox and returns the value of
// calling the named top-level function — used to assert on *behavior*
// rather than exact output text, since javascript-obfuscator's identifier
// renaming/string-array transforms aren't seeded/deterministic here.
function callFunction(code, functionName) {
    var sandbox = { result: undefined };
    vm.createContext(sandbox);
    new vm.Script(code + '\nresult = ' + functionName + '();').runInContext(sandbox);
    return sandbox.result;
}

var minifyCode = require('../minify_code');

function testPlatform(tempRoot, platform) {
    var platformWWW = PLATFORM_WWW_PATHS[platform](tempRoot);
    var context = { opts: { platforms: [platform], projectRoot: tempRoot } };

    // --- pre-run snapshot, for the "stale" assertions below ---
    var staleDestBefore = readIfExists(path.join(platformWWW, 'stale.js'));
    var injectedBefore = readIfExists(path.join(platformWWW, 'injected.js'));
    assert.ok(staleDestBefore !== null, '[' + platform + '] expected stale.js fixture to exist before run 1');
    assert.ok(injectedBefore !== null, '[' + platform + '] expected injected.js fixture to exist before run 1');
    assert.ok(
        !fs.existsSync(path.join(tempRoot, 'www', 'injected.js')),
        '[' + platform + '] injected.js must have NO pristine www/ counterpart for this fixture to mean anything'
    );

    return Promise.resolve(minifyCode(context))
        .then(function () {
            // --- existing smoke coverage: dummy.js/html/css still process without throwing ---
            assert.ok(fs.existsSync(path.join(platformWWW, 'dummy.js')), '[' + platform + '] dummy.js missing after run 1');
            assert.ok(fs.existsSync(path.join(platformWWW, 'dummy.html')), '[' + platform + '] dummy.html missing after run 1');
            assert.ok(fs.existsSync(path.join(platformWWW, 'dummy.css')), '[' + platform + '] dummy.css missing after run 1');

            // --- stale destination gets overwritten from pristine, not compounded ---
            var staleDestAfterRun1 = fs.readFileSync(path.join(platformWWW, 'stale.js'), 'utf8');
            assert.notStrictEqual(
                staleDestAfterRun1, staleDestBefore,
                '[' + platform + '] stale.js should have been rewritten from pristine source, not left as the stale destination content'
            );
            assert.strictEqual(
                callFunction(staleDestAfterRun1, 'stale'), 'pristine',
                '[' + platform + '] stale.js after run 1 should behave like the pristine www/stale.js source ("pristine"), not the stale destination content ("stale-destination-content")'
            );

            // --- no-pristine-equivalent file: obfuscated in place once, then re-run to check idempotency ---
            var injectedAfterRun1 = fs.readFileSync(path.join(platformWWW, 'injected.js'), 'utf8');
            assert.notStrictEqual(
                injectedAfterRun1, injectedBefore,
                '[' + platform + '] injected.js (no pristine counterpart) should have been obfuscated in place on run 1'
            );
            assert.strictEqual(
                callFunction(injectedAfterRun1, 'injected'), 'injected-no-pristine-counterpart',
                '[' + platform + '] injected.js after run 1 should still behave the same as before obfuscation'
            );

            return Promise.resolve(minifyCode(context)).then(function () {
                var injectedAfterRun2 = fs.readFileSync(path.join(platformWWW, 'injected.js'), 'utf8');
                assert.strictEqual(
                    injectedAfterRun2, injectedAfterRun1,
                    '[' + platform + '] injected.js must be byte-identical after a second run (marker-gated idempotency) — a stale re-run must not double-obfuscate it'
                );

                var staleDestAfterRun2 = fs.readFileSync(path.join(platformWWW, 'stale.js'), 'utf8');
                assert.strictEqual(
                    callFunction(staleDestAfterRun2, 'stale'), 'pristine',
                    '[' + platform + '] stale.js should still behave like pristine source after a second run'
                );
            });
        })
        .then(function () {
            console.log('[' + platform + '] all assertions passed');
        });
}

var tempRoot = freshFixtureRoot();
var platforms = Object.keys(PLATFORM_WWW_PATHS);

// Sequential on purpose — keeps failures attributable to one platform at a
// time and avoids needing Promise.all + exit-code plumbing for a plain,
// dependency-free script.
platforms
    .reduce(function (chain, platform) {
        return chain.then(function () { return testPlatform(tempRoot, platform); });
    }, Promise.resolve())
    .then(function () {
        console.log('all platforms passed');
    })
    .catch(function (err) {
        console.error(err);
        console.error('fixture copy left at: ' + tempRoot);
        process.exitCode = 1;
    });
