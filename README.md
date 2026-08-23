# cordova-plugin-minify-code
  
![Travis CI](https://travis-ci.org/sakaitaka/cordova-plugin-minify-code.svg?branch=master "build pass")
  
The plugin minifies and obfuscates the source code at build time — including
JavaScript that lives inline in `<script>` blocks inside HTML files, not just
standalone `.js` files.

# Install

```
$ cordova plugin add cordova-plugin-minify-code
```
  
# Usage
  
1. Install this plugin in the Cordova project.  
2. The plugin will minify and obfuscate the source code at build time.  

Every `.js` file under the platform's `www` directory is run through
[javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator)
(compacted output, renamed identifiers, extracted string array). Every
`.html`/`.htm` file has its inline `<script>` blocks obfuscated the same way —
external references (`<script src="...">`, already covered by the `.js` pass)
and non-JavaScript blocks (e.g. `type="text/ng-template"` or
`type="application/json"`) are left untouched — and the resulting markup is
then whitespace-collapsed with `html-minifier-terser`.
  
# Platforms

```
ios, android, windows
```

# Require Module
  
Dependency NPM Packages:
  
```
javascript-obfuscator, html-minifier-terser
```
  
# License
  
MIT License

Copyright (c) 2019 sakaitaka
