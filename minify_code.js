var fs = require('fs');
var path = require('path');
var JavaScriptObfuscator = require('javascript-obfuscator');
var htmlMinifierTerser = require('html-minifier-terser');

// Obfuscator options used for every .js file and every inline <script> block.
// `compact` alone gives us the "minify" half of the job; the rest add real
// obfuscation on top (identifier renaming, string-array extraction). We
// deliberately skip the heaviest transforms (controlFlowFlattening,
// deadCodeInjection) — they multiply build time and output size and this
// runs on every build, including pre-minified third-party vendor files that
// gain little from them.
var OBFUSCATOR_OPTIONS = {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: true,
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

function obfuscate(code, label) {
    if (!code || !code.trim()) return code;
    try {
        return JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
    } catch (err) {
        console.warn('cordova-plugin-minify-code: failed to obfuscate ' + label + ', leaving it as-is: ' + err.message);
        return code;
    }
}

function processJsFile(filePath) {
    var code = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, obfuscate(code, filePath), 'utf8');
}

// html-minifier-terser's minify() is async (it has been since v6, regardless
// of which sub-options are enabled), so this returns a promise — unlike
// processJsFile, which is pure CPU-bound work and stays synchronous.
function processHtmlFile(filePath) {
    var html = fs.readFileSync(filePath, 'utf8');

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
                if (ext === '.js') {
                    processJsFile(filePath);
                    jsCount++;
                } else if (ext === '.html' || ext === '.htm') {
                    htmlCount++;
                    return processHtmlFile(filePath);
                }
            });
        }, Promise.resolve())
        .then(function () {
            console.log('cordova-plugin-minify-code: minify + obfuscate success! (' + jsCount + ' .js file(s), ' + htmlCount + ' html file(s))');
        });
};
