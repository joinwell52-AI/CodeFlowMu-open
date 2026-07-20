import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

export type SchemaName = "agent" | "task" | "review" | "session" | "skill";

const SCHEMA_NAMES: SchemaName[] = ["agent", "task", "review", "session", "skill"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMAS_DIR = path.resolve(__dirname, "..", "schemas");

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});
addFormats(ajv);

const validatorCache = new Map<SchemaName, ValidateFunction>();

export async function loadSchema(name: SchemaName): Promise<object> {
  const schemaPath = path.join(SCHEMAS_DIR, `${name}.schema.json`);
  const raw = await readFile(schemaPath, "utf-8");
  return JSON.parse(raw) as object;
}

export async function getValidator(name: SchemaName): Promise<ValidateFunction> {
  const cached = validatorCache.get(name);
  if (cached) return cached;
  const schema = await loadSchema(name);
  const fn = ajv.compile(schema);
  validatorCache.set(name, fn);
  return fn;
}

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null;
}

export async function validate(
  name: SchemaName,
  data: unknown,
): Promise<ValidationResult> {
  const fn = await getValidator(name);
  const valid = fn(data) as boolean;
  return { valid, errors: valid ? null : fn.errors ?? null };
}

export function isSchemaName(s: string): s is SchemaName {
  return (SCHEMA_NAMES as string[]).includes(s);
}
