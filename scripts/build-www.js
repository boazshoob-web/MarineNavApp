// Copies web files to www/ for Capacitor builds.
// The source files at the project root remain the primary working copies.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const FILES = ['index.html', 'sw.js', 'manifest.json'];
const DIRS = ['icons'];

// Ensure www/ exists
fs.mkdirSync(WWW, { recursive: true });

// Copy individual files
for (const f of FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(WWW, f));
    }
}

// Copy directories recursively
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        if (fs.statSync(srcPath).isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

for (const d of DIRS) {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src)) {
        copyDir(src, path.join(WWW, d));
    }
}

console.log('Web files copied to www/');
