#!/usr/bin/env node
/** Prints the two secrets self-hosted mode requires, so nobody has to invent one. */
import { randomBytes } from 'node:crypto';

const secret = () => randomBytes(48).toString('base64');
console.log(`AUTH_SECRET=${secret()}`);
console.log(`STORAGE_SECRET=${secret()}`);
console.log();
console.log('AUTH_SECRET signs session tokens: changing it signs everyone out.');
console.log('STORAGE_SECRET signs document links and derives the ID number key:');
console.log('changing it makes stored ID numbers permanently unreadable. Back both up.');
