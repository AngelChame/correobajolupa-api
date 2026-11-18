import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '../src/db/email.js';

describe('normalizeEmail', () => {
  it('quita espacios y pasa a minúsculas', () => {
    expect(normalizeEmail('  Ana.Perez@Ejemplo.INVALID ')).toBe('ana.perez@ejemplo.invalid');
  });
});
