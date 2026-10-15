/**
 * Recovery tool: reset (or create) an admin account directly in the database.
 *   pnpm admin:reset-password <username>
 * Run on the gateway computer with the gateway stopped. Prompts for the new password.
 */
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, loadDotEnv } from '../config.js';
import { hashPassword, validatePassword } from '../auth.js';
import { Store } from '../store.js';

loadDotEnv(path.resolve(process.cwd(), '.env'));
const username = process.argv[2];
if (!username) {
  console.error('Usage: pnpm admin:reset-password <username>');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const password = await new Promise<string>((resolve) => rl.question(`New password for ${username}: `, resolve));
rl.close();
const err = validatePassword(password);
if (err) {
  console.error(err);
  process.exit(1);
}

const store = new Store(loadConfig().dbPath);
const existing = store.findUserByName(username);
if (existing) {
  store.updateUser(existing.id, { passwordHash: hashPassword(password), disabled: false, role: 'admin' });
  store.deleteUserSessions(existing.id);
  console.log(`Password reset; ${username} is an active admin. Existing sessions were signed out.`);
} else {
  store.createUser(username, hashPassword(password), 'admin');
  console.log(`Created admin account ${username}.`);
}
store.audit('user.cli_reset', null, { username });
store.close();
