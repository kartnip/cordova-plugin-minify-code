var fs = require('fs');
var path = require('path');
var vm = require('vm');
var JavaScriptObfuscator = require('javascript-obfuscator');
var htmlMinifierTerser = require('html-minifier-terser');

// Obfuscator options used for every .js file and every inline <script> block.
// `compact` alone gives us the "minify" half of the job; the rest add real
// obfuscation on top (identifier renaming, string-array extraction). We
// deliberately skip the heaviest transforms (controlFlowFlattening,
// deadCodeInjection) — they multiply build time and output size and this
// runs on every build, including pre-minified third-party vendor files that
// gain little from them.
//
// selfDefending is OFF as of 2026-08-24. It was the documented mechanism
// behind this file's one confirmed hang bug (re-obfuscating already-
// obfuscated selfDefending output produces a string-array rotation loop
// that never terminates — see OBFUSCATION_MARKERS below, which exists to
// prevent exactly that). Stress-testing this exact config against every
// real .js file in the app plus all vendored libraries (410 obfuscation
// passes, 50 execution runs) found zero syntax corruption and zero hangs,
// so no other concrete cause was confirmed for a separately-reported
// intermittent ~20-30%-of-builds breakage — but selfDefending remains the
// single riskiest, most fragile setting here by a wide margin (it's also
// the one most likely to misfire in ways that don't show up in a
// synthetic test harness), so it was turned off as a reliability trade:
// losing anti-tamper/anti-debugging protection in exchange for removing
// the most plausible remaining suspect. Revisit if tamper-resistance is
// needed again and the intermittent breakage turns out to have a
// different, confirmed cause.
var OBFUSCATOR_OPTIONS = {
    compact: true,
    controlFlowFlattening: false,
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

// Marks code we've already obfuscated.
//
// As of 2026-08-24, obfuscate()'s input is normally read from the pristine
// www/ source (see resolvePristineSource/resolvePristineRoot above), which
// this file never writes to — so for those files, there's structurally
// nothing to double-obfuscate, and this marker's check is a harmless no-op.
// It still matters for two narrower cases: (1) files with no pristine
// counterpart at all (cordova.js, cordova_plugins.js, plugin JS shims),
// which are read from platformWWW in place exactly like before this
// change existed, and (2) defense-in-depth if pristine-source resolution
// ever fails to find a match it should have. For those, the original
// concern still applies: `after_prepare` re-runs on every `cordova
// prepare`, and if that ever happens more than once within a single build
// (e.g. a `cordova prepare` step followed by `cordova build`, which
// triggers its own internal prepare), the second pass would see the first
// pass's already-obfuscated output. Feeding javascript-obfuscator's own
// output back into itself is not safe to do: the string-array bootstrap it
// injects assumes it's rotating a table it built itself, and obfuscating
// that a second time can produce code whose rotation loop never
// terminates — the app hangs on load. This marker makes obfuscate() a
// no-op on code we've already processed, so a stale re-run can't corrupt
// it.
//
// Every marker string this file has ever stamped onto obfuscated output,
// oldest first — obfuscate() treats a match against ANY of these as
// "already done". A leftover platforms/.../www file built before a purely
// cosmetic wording change to the marker still needs to be recognized as
// processed; recognizing only the current exact string is what let a
// wording change re-trigger the double-obfuscation hang this marker exists
// to prevent. To change the marker's text, PUSH A NEW ENTRY rather than
// editing an existing one in place — editing history instead of appending
// to it reproduces exactly that bug.
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

function obfuscate(code, label) {
    if (!code || !code.trim()) return code;
    if (alreadyObfuscated(code)) return code;
    try {
        var obfuscated = JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
        // getObfuscatedCode() doesn't re-parse its own output, so a bug in
        // the obfuscator that produces syntactically invalid JS wouldn't
        // throw here at all — it would only show up later as a broken app,
        // build after build, with nothing in this hook's own logs pointing
        // at the cause. Parsing it ourselves (compile-only, never
        // executed) catches that class of failure at build time instead,
        // so a bad pass falls back to shipping the original file rather
        // than shipping broken code.
        new vm.Script(obfuscated);
        return OBFUSCATION_MARKER + obfuscated;
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
function processHtmlFile(filePath, readPath) {
    var html = fs.readFileSync(readPath, 'utf8');

    html = html.replace(SCRIPT_BLOCK_RE, function (fullMatch, attrs, inner) {
        if (isExternalScript(attrs) || !isJavaScriptType(attrs) || !inner.trim()) {
            return fullMatch;
        }
        return '<script' + attrs + '>' + obfuscate(inner, filePath + ' (inline script)') + '</script>';
    });

    return Promise.resolve()
        .then(function () {
            return htmlMinifierTerser.minify(html, HTML_MINIFY_OPTIONS);
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
//
// Deliberately no cross-extension guessing (a destination foo.html is only
// matched against a pristine foo.html, never foo.htm) and no probing of a
// merges/<platform>/ overlay (this app doesn't use one; a future maintainer
// wiring merges/ support in should extend this function, not work around
// it elsewhere).
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
    var htmlCount = 0;

    // Sequential on purpose: this only runs once per build, keeps memory/CPU
    // bounded regardless of how many files www contains, and keeps errors
    // easy to attribute to a single file.
    return files
        .reduce(function (chain, filePath) {
            return chain.then(function () {
                var ext = path.extname(filePath).toLowerCase();
                // Prefer reading from the pristine source (structurally
                // clean, see resolvePristineSource) over the platformWWW
                // copy in place; fall back to the old in-place, marker-
                // gated behavior for files with no pristine counterpart
                // (cordova.js, cordova_plugins.js, plugin JS shims).
                var readPath = resolvePristineSource(pristineWWW, platformWWW, filePath) || filePath;
                if (ext === '.js') {
                    processJsFile(filePath, readPath);
                    jsCount++;
                } else if (ext === '.html' || ext === '.htm') {
                    htmlCount++;
                    return processHtmlFile(filePath, readPath);
                }
            });
        }, Promise.resolve())
        .then(function () {
            console.log('cordova-plugin-minify-code: minify + obfuscate success! (' + jsCount + ' .js file(s), ' + htmlCount + ' html file(s))');
        });
};
