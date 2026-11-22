// Перевірка вхідних подій схемами contracts (той самий тег, що й validator-lib). Схеми беруться з пакета
// @lad/contracts під час старту. Консюмер толерантний до нових полів (contracts README: MINOR лише
// адитивний), тому additionalProperties: false при завантаженні знімається: невідоме поле не робить
// подію невалідною, а відсутнє обов'язкове чи поле не того типу — робить.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

const BASE = 'https://lad.example/contracts/schemas/events/';

/** Копія схеми без additionalProperties: false (толерантність до полів новішого MINOR). */
function tolerant(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tolerant);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' && v === false) continue;
    out[k] = tolerant(v);
  }
  return out;
}

function load(): Ajv2020 {
  const dir = join(dirname(createRequire(import.meta.url).resolve('@lad/contracts/package.json')), 'schemas', 'events');
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) ajv.addSchema(tolerant(JSON.parse(readFileSync(join(dir, f), 'utf8'))) as object);
  return ajv;
}

const ajv = load();
const cache = new Map<string, ValidateFunction>();

/** null — подія відповідає схемі `${name}.v1.json`; інакше — перша причина (шлях і повідомлення ajv). */
export function contractError(name: string, event: unknown): string | null {
  let validate = cache.get(name);
  if (!validate) {
    validate = ajv.getSchema(`${BASE}${name}.v1.json`);
    if (!validate) throw new Error(`немає схеми contracts ${name}.v1.json`);
    cache.set(name, validate);
  }
  if (validate(event)) return null;
  const e = validate.errors?.[0];
  return e ? `${e.instancePath || '/'} ${e.message ?? 'не відповідає схемі'}` : 'не відповідає схемі';
}
