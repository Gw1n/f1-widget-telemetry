const fs = require('fs');
const path = require('path');

/** Tiny JSON-file settings store (synchronous: the file is a few hundred bytes). */
class Settings {
  constructor(dir, defaults) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...defaults };
    try {
      this.data = { ...defaults, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      // first run or unreadable file: keep defaults
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('settings not saved:', err.message);
    }
  }
}

module.exports = { Settings };
