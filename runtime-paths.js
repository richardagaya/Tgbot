const fs = require('fs');
const path = require('path');

const PROJECT_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : PROJECT_DIR;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copySeedFile(filename) {
  const target = path.join(DATA_DIR, filename);
  if (fs.existsSync(target)) return target;
  const seed = path.join(PROJECT_DIR, filename);
  if (DATA_DIR !== PROJECT_DIR && fs.existsSync(seed)) {
    ensureDir(path.dirname(target));
    fs.copyFileSync(seed, target);
  }
  return target;
}

function copyDirContents(source, target) {
  ensureDir(target);
  for (const name of fs.readdirSync(source)) {
    const src = path.join(source, name);
    const dest = path.join(target, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      copyDirContents(src, dest);
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

function seedRuntimeDir(dirname, target) {
  const seed = path.join(PROJECT_DIR, dirname);
  if (DATA_DIR === PROJECT_DIR || !fs.existsSync(seed) || !fs.statSync(seed).isDirectory()) return;
  if (fs.readdirSync(target).length > 0) return;
  copyDirContents(seed, target);
}

function runtimeFile(filename) {
  ensureDir(DATA_DIR);
  return copySeedFile(filename);
}

function runtimeDir(dirname) {
  const target = path.join(DATA_DIR, dirname);
  ensureDir(target);
  seedRuntimeDir(dirname, target);
  return target;
}

function projectRelativeOrAbsolute(absPath) {
  const rel = path.relative(PROJECT_DIR, absPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return absPath;
}

function resolveProjectPath(relOrAbs) {
  if (!relOrAbs) return null;
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(PROJECT_DIR, relOrAbs);
}

module.exports = {
  PROJECT_DIR,
  DATA_DIR,
  runtimeFile,
  runtimeDir,
  projectRelativeOrAbsolute,
  resolveProjectPath,
};
