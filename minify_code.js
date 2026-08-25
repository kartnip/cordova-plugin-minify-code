var fs = require('fs');
var path = require('path');
var vm = require('vm');
var acorn = require('acorn');

// Heavy dependencies are lazy-loaded on first use rather than at module load.
// This keeps `require('cordova-plugin-minify-code')` cheap (the hook module is
// pulled in on every prepare) and lets the pure AST/splicing logic be unit
// tested without loading the obfuscator. setObfuscator() (see __test__ export)
// can substitute a stand-in for tests.
var _obfuscatorImpl = null;
function getObfuscator() {
    if (!_obfuscatorImpl) _obfuscatorImpl = require('javascript-obfuscator');
    return _obfuscatorImpl;
}
var _htmlMinifier = null;
function getHtmlMinifier() {
    if (!_htmlMinifier) _htmlMinifier = require('html-minifier-terser');
    return _htmlMinifier;
}

// ---------------------------------------------------------------------------
// Design (2026-08-25): obfuscate METHOD INTERNALS ONLY, leave namespaces intact
// ---------------------------------------------------------------------------
// The old design fed each whole file to javascript-obfuscator. Even with
// `renameGlobals:false` (which already preserves top-level names) and the fact
// that javascript-obfuscator never mangles property/method names, one
// whole-program transform still reached the "namespace surface": `stringArray`
// lifted EVERY string literal — DOM selectors, bracket-access keys like
// pullRefresh['isTouchDevice'], and the string commands the iframe/postMessage
// layer dispatches — into a shared base64 table + decoder bootstrap injected at
// program scope. That bootstrap is also the documented cause of the
// double-obfuscation "rotation loop that never terminates" hang and the
// intermittent build breakage that motivated turning selfDefending off.
//
// This version confines ALL transformation to the inside of function bodies:
//   * We parse each file, find the outermost functions, and obfuscate only the
//     statements BETWEEN their braces.
//   * Everything outside a function body — the `var X = {}` namespace
//     scaffolding, property/method names, top-level statements, and every
//     top-level string literal — is emitted byte-for-byte from the original
//     source (we splice by character offset; we never re-print the outer code).
//   * Each body's string-array / control-flow machinery is relocated to live
//     INSIDE that body, so nothing lands at program scope. That both guarantees
//     the namespace surface is untouched AND removes the program-scope
//     string-array bootstrap that caused the hang / intermittent breakage.
//
// Because obfuscation can no longer touch program scope, we can safely run the
// STRONG transforms (controlFlowFlattening + stringArray) inside bodies.

// Options used to obfuscate a single function body (wrapped as its own tiny
// program — see obfuscateBody). renameGlobals stays false so that references
// the body makes to outer namespaces (pullRefresh, sequence, $, ons, other-file
// globals) and to its own parameters are left literal and still resolve; only
// identifiers actually declared inside the body get renamed.
var STRONG_OPTS = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: false,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    disableConsoleOutput: false
};

// Markup-whitespace pass only — JS is handled by us beforehand, so
// html-minifier-terser's own JS minification is left off to avoid running
// two different tools over the same (already-obfuscated) code.
var HTML_MINIFY_OPTIONS = {
    collapseWhitespace: true,
    conservativeCollapse: true,
    minifyJS: false,
    minifyCSS: false
};

// Matches a <script>...</script> block, capturing its attribute string and
// inner content separately so external references and non-JS payloads can be
// told apart from the actual code we need to touch.
var SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function isExternalScript(attrs) {
    return /\bsrc\s*=/i.test(attrs);
}

// Only obfuscate blocks that are actually JavaScript — a missing type
// attribute defaults to JS, but templating engines commonly repurpose
// <script type="text/ng-template">, type="application/json", etc. for
// non-JS payloads, and running those through the obfuscator would corrupt
// the page.
function isJavaScriptType(attrs) {
    var match = attrs.match(/\btype\s*=\s*["']([^"']*)["']/i);
    if (!match) return true;
    var type = match[1].trim().toLowerCase();
    return (
        type === '' ||
        type === 'text/javascript' ||
        type === 'application/javascript' ||
        type === 'module'
    );
}

// Only our own app-authored JS is obfuscated. Third-party libraries gain
// nothing from it and are the riskiest to transform, and Cordova's own runtime
// files must stay byte-exact. Excludes anything under a lib/ or plugins/
// directory, pre-minified *.min.js, and cordova.js / cordova_plugins.js.
function isAppAuthoredJs(relPath) {
    var segs = relPath.split(path.sep).join('/').split('/');
    if (segs.indexOf('lib') !== -1) return false;
    if (segs.indexOf('plugins') !== -1) return false;
    var base = segs[segs.length - 1];
    if (base === 'cordova.js' || base === 'cordova_plugins.js') return false;
    if (/\.min\.js$/i.test(base)) return false;
    return true;
}

// Marks code we've already obfuscated. See the history below: the marker is how
// a stale re-run of `after_prepare` is prevented from feeding obfuscated output
// back into itself. The per-function design already keeps the string array out
// of program scope (the specific thing that hung on re-obfuscation), but the
// marker is kept as belt-and-suspenders and for files read in place.
//
// Every marker string this file has ever stamped onto obfuscated output,
// oldest first — obfuscate() treats a match against ANY of these as
// "already done". To change the marker's text, PUSH A NEW ENTRY rather than
// editing an existing one in place.
var OBFUSCATION_MARKERS = [
    '/* cordova-plugin-minify-code:done */',
    '/* Copyright blah blah all rights whatever Jeffrey Reisberg, Kartnip, Petrol Avengers LLC */',
    '/* Copyright Jeffrey Reisberg, Kartnip, Petrol Avengers LLC, All Rights Reserved */'
];
// The one stamped onto newly-obfuscated output going forward — always the
// most recent entry above.
var OBFUSCATION_MARKER = OBFUSCATION_MARKERS[OBFUSCATION_MARKERS.length - 1];

function alreadyObfuscated(code) {
    return OBFUSCATION_MARKERS.some(function (marker) {
        return code.indexOf(marker) === 0;
    });
}

// Parse with acorn, tolerating either script or module source. acorn stamps
// numeric .start/.end offsets on every node by default, which the splicing
// below relies on. Throws if the code parses as neither.
function parseFlexible(code) {
    try {
        return acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
    } catch (scriptErr) {
        return acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    }
}

// Depth-first walk over an acorn AST. visit(node) may return 'skip' to avoid
// descending into that node's children. Deliberately hand-rolled (rather than
// estraverse) so unfamiliar/newer node types from ecmaVersion:'latest' can't
// throw — we simply recurse into any child that itself looks like a node.
function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    if (visit(node) === 'skip') return;
    for (var key in node) {
        if (key === 'type' || key === 'start' || key === 'end') continue;
        var child = node[key];
        if (Array.isArray(child)) {
            for (var i = 0; i < child.length; i++) {
                if (child[i] && typeof child[i].type === 'string') walk(child[i], visit);
            }
        } else if (child && typeof child.type === 'string') {
            walk(child, visit);
        }
    }
}

// The set of functions whose bodies we obfuscate: the outermost block-bodied
// functions (function declarations/expressions, arrows, and object/class method
// values all surface as one of these node types). We record a function and stop
// descending, because obfuscating its body already handles every function
// nested inside it. Expression-bodied arrows (x => x+1) have nothing to confine
// but are still descended into, in case they wrap a nested block-bodied fn.
function collectOutermostFunctions(ast) {
    var fns = [];
    walk(ast, function (node) {
        if (
            node.type === 'FunctionDeclaration' ||
            node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression'
        ) {
            if (node.body && node.body.type === 'BlockStatement') {
                fns.push(node);
                return 'skip';
            }
        }
        return undefined;
    });
    return fns;
}

// Obfuscate the statements of a single function body. `bodyInner` is the raw
// text between the function's braces; `kind` carries async/generator flags so
// the throwaway wrapper matches (otherwise await/yield in the body would fail
// to parse). Returns the replacement inner text, or null to leave the body
// untouched (e.g. a body using `super`, which is illegal in the standalone
// wrapper — a safe no-op fallback).
function obfuscateBody(bodyInner, kind) {
    if (!bodyInner || !bodyInner.trim()) return null;

    var prefix = 'var __o = ' + (kind.async ? 'async ' : '') + 'function' + (kind.generator ? '*' : '') + '(){';
    var program = prefix + '\n' + bodyInner + '\n};';

    var out;
    try {
        out = getObfuscator().obfuscate(program, STRONG_OPTS).getObfuscatedCode();
    } catch (err) {
        return null;
    }

    var oast;
    try {
        oast = acorn.parse(out, { ecmaVersion: 'latest' });
    } catch (err) {
        return null;
    }

    // Locate the wrapper `var __o = <function>` (renameGlobals:false keeps the
    // name literal). Everything ELSE at program scope is the string-array /
    // control-flow bootstrap the obfuscator injected; we relocate it to the top
    // of the body so the machinery lives inside the function, not at file scope.
    var fnNode = null;
    var prelude = [];
    for (var i = 0; i < oast.body.length; i++) {
        var stmt = oast.body[i];
        var matched = false;
        if (stmt.type === 'VariableDeclaration') {
            for (var j = 0; j < stmt.declarations.length; j++) {
                var d = stmt.declarations[j];
                if (d.id && d.id.name === '__o' && d.init) {
                    fnNode = d.init;
                    matched = true;
                }
            }
        }
        if (!matched) prelude.push(out.slice(stmt.start, stmt.end));
    }

    if (!fnNode || fnNode.type !== 'FunctionExpression' || !fnNode.body) return null;

    var newInner = out.slice(fnNode.body.start + 1, fnNode.body.end - 1);
    if (prelude.length) {
        // Each part is a complete top-level statement; ';' between/after keeps
        // them valid whether a part ends in '}' (function decl) or an
        // expression (var decl acorn slices without its trailing ';').
        newInner = prelude.join(';\n') + ';\n' + newInner;
    }
    return newInner;
}

// Transform one JS source string: obfuscate every outermost function body,
// leave every other byte exactly as written. Splices are applied back-to-front
// so earlier offsets stay valid. Throws only if the file itself won't parse.
function transformSource(code) {
    var ast = parseFlexible(code);
    var fns = collectOutermostFunctions(ast);
    if (!fns.length) return code;

    var edits = [];
    for (var i = 0; i < fns.length; i++) {
        var fn = fns[i];
        var innerStart = fn.body.start + 1;
        var innerEnd = fn.body.end - 1;
        var bodyInner = code.slice(innerStart, innerEnd);
        var newInner = obfuscateBody(bodyInner, { async: !!fn.async, generator: !!fn.generator });
        if (newInner == null) continue;
        edits.push({ start: innerStart, end: innerEnd, text: newInner });
    }

    edits.sort(function (a, b) { return b.start - a.start; });
    var out = code;
    for (var k = 0; k < edits.length; k++) {
        out = out.slice(0, edits[k].start) + edits[k].text + out.slice(edits[k].end);
    }
    return out;
}

function obfuscate(code, label) {
    if (!code || !code.trim()) return code;
    if (alreadyObfuscated(code)) return code;
    try {
        var transformed = transformSource(code);
        // Compile-only (never executed) syntax backstop: getObfuscatedCode()
        // doesn't re-parse its own output, and our splicing could in principle
        // produce invalid JS, so parse the assembled result and fall back to
        // the original file if anything is wrong. NOTE: this catches syntax
        // corruption, not a runtime hang — per-function confinement (nothing at
        // program scope) is what actually removes the hang risk.
        new vm.Script(transformed);
        return OBFUSCATION_MARKER + transformed;
    } catch (err) {
        console.warn('cordova-plugin-minify-code: failed to obfuscate ' + label + ', leaving it as-is: ' + err.message);
        return code;
    }
}

// readPath is where the CONTENT comes from — the pristine-source match if
// one was found, otherwise filePath itself (platformWWW, in-place, marker-
// gated). filePath is always where the result gets written.
function processJsFile(filePath, readPath) {
    var code = fs.readFileSync(readPath, 'utf8');
    fs.writeFileSync(filePath, obfuscate(code, filePath), 'utf8');
}

// html-minifier-terser's minify() is async (it has been since v6, regardless
// of which sub-options are enabled), so this returns a promise — unlike
// processJsFile, which is pure CPU-bound work and stays synchronous.
// obfuscateInline gates whether inline <script> bodies are obfuscated (only for
// app-authored HTML); the markup-whitespace pass runs either way.
function processHtmlFile(filePath, readPath, obfuscateInline) {
    var html = fs.readFileSync(readPath, 'utf8');

    if (obfuscateInline) {
        html = html.replace(SCRIPT_BLOCK_RE, function (fullMatch, attrs, inner) {
            if (isExternalScript(attrs) || !isJavaScriptType(attrs) || !inner.trim()) {
                return fullMatch;
            }
            return '<script' + attrs + '>' + obfuscate(inner, filePath + ' (inline script)') + '</script>';
        });
    }

    return Promise.resolve()
        .then(function () {
            return getHtmlMinifier().minify(html, HTML_MINIFY_OPTIONS);
        })
        .catch(function (err) {
            console.warn('cordova-plugin-minify-code: failed to minify markup in ' + filePath + ', keeping obfuscated-but-unminified HTML: ' + err.message);
            return html;
        })
        .then(function (finalHtml) {
            fs.writeFileSync(filePath, finalHtml, 'utf8');
        });
}

function collectFiles(dir) {
    var files = [];
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
        var fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(collectFiles(fullPath));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    });
    return files;
}

// The pristine, never-written-to source tree this hook's output is derived
// from — Cordova's own default `<projectRoot>/www/`. Nothing in this file
// ever writes here, so it's structurally guaranteed clean input on every
// run, unlike platformWWW (see resolvePristineSource below).
function resolvePristineRoot(projectRoot) {
    return path.resolve(projectRoot, 'www');
}

// Maps a platformWWW destination file back to its pristine-source
// counterpart, if one exists at the same relative path under
// resolvePristineRoot(). Returns null (not the destination path) when there
// isn't one, so the caller can fall back to the old marker-gated in-place
// behavior for files Cordova/plugins inject directly into platformWWW with
// no corresponding source under the app's own www/ (cordova.js,
// cordova_plugins.js, plugin JS shims under a plugins/ subfolder).
function resolvePristineSource(pristineRoot, platformWWW, filePath) {
    var relativePath = path.relative(platformWWW, filePath);
    var candidate = path.join(pristineRoot, relativePath);
    try {
        return fs.statSync(candidate).isFile() ? candidate : null;
    } catch (err) {
        return null;
    }
}

module.exports = function (context) {
    var platforms = context.opts.platforms;
    var projectRoot = context.opts.projectRoot;
    var platformWWW;

    if (platforms.indexOf('ios') >= 0 || platforms.indexOf('windows') >= 0) {
        platformWWW = path.resolve(projectRoot, 'platforms', platforms[0], 'www');
    } else if (platforms.indexOf('android') >= 0) {
        platformWWW = path.resolve(projectRoot, 'platforms', platforms[0], 'app/src/main/assets/www');
    } else {
        console.log('ERROR: not supported platform.');
        return;
    }

    console.log('cordova-plugin-minify-code: Minify + Obfuscate Target Directory: ' + platformWWW);

    if (!fs.existsSync(platformWWW)) {
        console.log('cordova-plugin-minify-code: target directory not found, skipping.');
        return;
    }

    console.log('cordova-plugin-minify-code: Task Start...');

    var pristineWWW = resolvePristineRoot(projectRoot);
    var files = collectFiles(platformWWW);
    var jsCount = 0;
    var jsSkipped = 0;
    var htmlCount = 0;

    // Sequential on purpose: this only runs once per build, keeps memory/CPU
    // bounded regardless of how many files www contains, and keeps errors
    // easy to attribute to a single file.
    return files
        .reduce(function (chain, filePath) {
            return chain.then(function () {
                var ext = path.extname(filePath).toLowerCase();
                var relPath = path.relative(platformWWW, filePath);
                // Prefer reading from the pristine source (structurally
                // clean, see resolvePristineSource) over the platformWWW
                // copy in place; fall back to the old in-place, marker-
                // gated behavior for files with no pristine counterpart
                // (cordova.js, cordova_plugins.js, plugin JS shims).
                var readPath = resolvePristineSource(pristineWWW, platformWWW, filePath) || filePath;
                if (ext === '.js') {
                    // Only obfuscate app-authored JS; vendor libs and Cordova
                    // runtime files are left as the plain platform copy.
                    if (!isAppAuthoredJs(relPath)) {
                        jsSkipped++;
                        return;
                    }
                    processJsFile(filePath, readPath);
                    jsCount++;
                } else if (ext === '.html' || ext === '.htm') {
                    htmlCount++;
                    return processHtmlFile(filePath, readPath, isAppAuthoredJs(relPath));
                }
            });
        }, Promise.resolve())
        .then(function () {
            console.log('cordova-plugin-minify-code: minify + obfuscate success! (' +
                jsCount + ' .js file(s) obfuscated, ' + jsSkipped + ' .js file(s) skipped, ' +
                htmlCount + ' html file(s))');
        });
};

// Internal surface for unit tests only (see test/). Not part of the plugin API.
module.exports.__test__ = {
    parseFlexible: parseFlexible,
    collectOutermostFunctions: collectOutermostFunctions,
    obfuscateBody: obfuscateBody,
    transformSource: transformSource,
    obfuscate: obfuscate,
    isAppAuthoredJs: isAppAuthoredJs,
    setObfuscator: function (impl) { _obfuscatorImpl = impl; }
};
