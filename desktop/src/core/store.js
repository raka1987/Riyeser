// Tiny JSON-file store. Everything the app remembers lives in one data folder on the user's machine.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = {};
  }
  file(name) { return path.join(this.dir, `${name}.json`); }
  get(name, fallback) {
    if (name in this.cache) return this.cache[name];
    try { this.cache[name] = JSON.parse(fs.readFileSync(this.file(name), 'utf8')); }
    catch { this.cache[name] = fallback; }
    return this.cache[name];
  }
  set(name, value) {
    this.cache[name] = value;
    const tmp = this.file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, this.file(name));
    return value;
  }
  update(name, fallback, fn) { return this.set(name, fn(this.get(name, fallback))); }
}

module.exports = { Store };
