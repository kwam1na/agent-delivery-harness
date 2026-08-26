/**
 * A minimal JSON Schema (draft 2020-12) evaluator, for cross-checking the
 * published schemas against the normative validator.
 *
 * WHY NOT A SCHEMA LIBRARY. The schemas are cross-checked, not relied on: the
 * hand-rolled validator is the normative implementation, and this evaluator
 * exists only to answer "does the published shape agree with the vectors?". A
 * dependency on the most security-adjacent path in the repository is a poor
 * trade for a job this small, and the same reasoning kept the canonicalizer
 * in-kernel.
 *
 * WHY IT REFUSES WHAT IT DOES NOT KNOW. It implements exactly the keywords the
 * two published schemas use and **throws** on any other keyword — and, for the
 * same reason, on a constraint sitting beside a `$ref`, which it would otherwise
 * drop while resolving. An evaluator that skipped an unrecognized constraint
 * would silently report "passes the schema" for a document the schema rejects,
 * which is the one failure this cross-check cannot afford: the partition it
 * feeds would then be wrong in the direction that hides a disagreement.
 */

export interface SchemaViolation {
  /** RFC 6901 pointer into the instance. */
  readonly pointer: string;
  readonly keyword: string;
  readonly message: string;
}

const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  // Metadata, no constraint.
  "$schema",
  "$id",
  "$defs",
  "title",
  "description",
  "format",
  // Constraints.
  "$ref",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
]);

type Schema = Record<string, unknown>;

/** A subschema is an object, or a boolean: `true` admits anything, `false` nothing. */
type Subschema = Schema | boolean;

/** Keywords that carry no constraint, and so may legally sit beside a `$ref`. */
const METADATA_KEYWORDS: ReadonlySet<string> = new Set(["$ref", "$schema", "$id", "$defs", "title", "description"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeMatches(name: string, value: unknown): boolean {
  switch (name) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      throw new Error(`unsupported JSON Schema type "${name}"`);
  }
}

function escape(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function validateAgainstSchema(schema: unknown, instance: unknown): readonly SchemaViolation[] {
  if (!isRecord(schema)) throw new Error("schema must be an object");
  const violations: SchemaViolation[] = [];
  check(schema, schema, instance, "", violations);
  return violations;
}

function resolve(root: Schema, schema: Schema): Schema {
  const ref = schema["$ref"];
  if (ref === undefined) return schema;
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) {
    throw new Error(`unsupported $ref "${String(ref)}"`);
  }
  // In 2020-12 a constraint beside a `$ref` still applies. This evaluator
  // replaces the schema with its target, so a sibling constraint would be
  // dropped — which is the silent-pass failure the whole module refuses.
  const siblings = Object.keys(schema).filter((keyword) => !METADATA_KEYWORDS.has(keyword));
  if (siblings.length > 0) {
    throw new Error(`unsupported $ref sibling keyword(s): ${siblings.join(", ")}`);
  }
  const defs = root["$defs"];
  const name = ref.slice("#/$defs/".length);
  if (!isRecord(defs) || !isRecord(defs[name])) throw new Error(`unresolvable $ref "${ref}"`);
  return defs[name];
}

/** Evaluates a value against a subschema in either of its two forms. */
function checkSubschema(
  root: Schema,
  subschema: Subschema,
  instance: unknown,
  pointer: string,
  violations: SchemaViolation[],
  keyword: string,
  message: string,
): void {
  if (subschema === true) return;
  if (subschema === false) {
    violations.push({ pointer, keyword, message });
    return;
  }
  if (!isRecord(subschema)) throw new Error(`unsupported subschema ${JSON.stringify(subschema)}`);
  check(root, subschema, instance, pointer, violations);
}

function check(root: Schema, rawSchema: Schema, instance: unknown, pointer: string, violations: SchemaViolation[]): void {
  for (const keyword of Object.keys(rawSchema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported JSON Schema keyword "${keyword}"`);
    }
  }
  const schema = resolve(root, rawSchema);
  if (schema !== rawSchema) {
    check(root, schema, instance, pointer, violations);
    return;
  }

  const emit = (keyword: string, message: string): void => {
    violations.push({ pointer, keyword, message });
  };

  const type = schema["type"];
  if (type !== undefined) {
    const names = Array.isArray(type) ? (type as string[]) : [type as string];
    if (!names.some((name) => typeMatches(name, instance))) {
      emit("type", `expected ${names.join(" or ")}`);
      return;
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const") && JSON.stringify(schema["const"]) !== JSON.stringify(instance)) {
    emit("const", `expected ${JSON.stringify(schema["const"])}`);
  }

  const enumeration = schema["enum"];
  if (Array.isArray(enumeration) && !enumeration.some((option) => JSON.stringify(option) === JSON.stringify(instance))) {
    emit("enum", `expected one of ${JSON.stringify(enumeration)}`);
  }

  if (typeof instance === "string") {
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(instance)) emit("pattern", `does not match ${pattern}`);
    const minLength = schema["minLength"];
    if (typeof minLength === "number" && instance.length < minLength) emit("minLength", `shorter than ${minLength}`);
    const maxLength = schema["maxLength"];
    if (typeof maxLength === "number" && instance.length > maxLength) emit("maxLength", `longer than ${maxLength}`);
  }

  if (typeof instance === "number") {
    const minimum = schema["minimum"];
    if (typeof minimum === "number" && instance < minimum) emit("minimum", `below ${minimum}`);
  }

  if (Array.isArray(instance)) {
    const minItems = schema["minItems"];
    if (typeof minItems === "number" && instance.length < minItems) emit("minItems", `fewer than ${minItems} items`);
    const maxItems = schema["maxItems"];
    if (typeof maxItems === "number" && instance.length > maxItems) emit("maxItems", `more than ${maxItems} items`);
    if (schema["uniqueItems"] === true) {
      const seen = new Set(instance.map((item) => JSON.stringify(item)));
      if (seen.size !== instance.length) emit("uniqueItems", "items are not unique");
    }
    const items = schema["items"];
    if (items !== undefined) {
      instance.forEach((item, index) => {
        checkSubschema(root, items as Subschema, item, `${pointer}/${index}`, violations, "items", "no item is valid here");
      });
    }
  }

  if (isRecord(instance)) {
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const name of required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(instance, name)) {
          emit("required", `missing required property "${name}"`);
        }
      }
    }
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    for (const [name, value] of Object.entries(instance)) {
      const at = `${pointer}/${escape(name)}`;
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        checkSubschema(root, properties[name] as Subschema, value, at, violations, "properties", "no value is valid for this property");
        continue;
      }
      const additional = schema["additionalProperties"];
      if (additional === undefined) continue;
      checkSubschema(root, additional as Subschema, value, at, violations, "additionalProperties", "property is not allowed");
    }
  }
}
