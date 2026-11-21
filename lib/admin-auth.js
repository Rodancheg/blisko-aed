'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const fail = (status, message) => Object.assign(new Error(message), {status});
const digest = value => crypto.createHash('sha256').update(value).digest();

class AdminAuth {
  constructor(directory) { this.directory = directory; this.ready = null; this.failures = new Map(); }
  async setup() {
    await fs.mkdir(this.directory, {recursive: true});
    async function secret(file, generated) {
      try { await fs.writeFile(file, generated, {flag: 'wx', mode: 0o600}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      return (await fs.readFile(file, 'utf8')).trim();
    }
    const key = await secret(path.join(this.directory, 'admin-signing-key'), crypto.randomBytes(32).toString('hex'));
    const password = process.env.AED_ADMIN_PASSWORD || await secret(path.join(this.directory, 'admin-password.txt'), crypto.randomBytes(18).toString('base64url'));
    return {key, password};
  }
  config() { return this.ready ||= this.setup(); }
  async authenticated(req) {
    const token = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('aed_admin='))?.slice(10);
    if (!token) return false;
    const {key} = await this.config(), [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return false;
    const expected = crypto.createHmac('sha256', key).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(digest(signature), digest(expected))) return false;
    try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); return data.role === 'admin' && data.exp > Date.now(); }
    catch { return false; }
  }
  async require(req) { if (!await this.authenticated(req)) throw fail(401, 'Zaloguj się jako administrator, aby zatwierdzić zmianę.'); }
  async login(req, password) {
    const address = req.socket.remoteAddress || 'local', now = Date.now();
    let failures = this.failures.get(address);
    if (!failures || now - failures.started > 60000) { failures = {started: now, count: 0}; this.failures.set(address, failures); }
    if (failures.count >= 5) throw fail(429, 'Zbyt wiele prób. Spróbuj ponownie za minutę.');
    const config = await this.config();
    if (typeof password !== 'string' || !crypto.timingSafeEqual(digest(password), digest(config.password))) {
      failures.count++; throw fail(401, 'Nieprawidłowe hasło administratora.');
    }
    this.failures.delete(address);
    const payload = Buffer.from(JSON.stringify({role: 'admin', exp: now + 8 * 60 * 60 * 1000, nonce: crypto.randomBytes(12).toString('hex')})).toString('base64url');
    const signature = crypto.createHmac('sha256', config.key).update(payload).digest('base64url');
    const secure = req.socket.encrypted || req.headers.origin?.startsWith('https://');
    return `aed_admin=${payload}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`;
  }
}
module.exports = {AdminAuth};
