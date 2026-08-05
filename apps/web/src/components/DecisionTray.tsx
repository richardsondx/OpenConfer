import { useState } from "react";
import { Button } from "./primitives";

export interface JsonSchema {
  type?: "object" | "string" | "boolean" | "number" | "integer" | "array" | "null" | Array<"object" | "string" | "boolean" | "number" | "integer" | "array" | "null">;
  title?: string;
  description?: string;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  nullable?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | JsonSchema;
}

type Errors = Record<string, string>;

function labelFor(name: string, schema: JsonSchema) {
  return schema.title ?? name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function allowsNull(schema: JsonSchema): boolean {
  if (schema.nullable) return true;
  return Array.isArray(schema.type) ? schema.type.includes("null") : schema.type === "null";
}

function primaryType(schema: JsonSchema): JsonSchema["type"] {
  if (Array.isArray(schema.type)) {
    return schema.type.find((entry) => entry !== "null") ?? schema.type[0];
  }
  return schema.type;
}

function isEmptyOptional(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function validate(schema: JsonSchema, value: unknown, path = "result", required = false): Errors {
  const errors: Errors = {};

  if (schema.oneOf?.length) {
    const matches = schema.oneOf.filter((candidate) => Object.keys(validate(candidate, value, path, required)).length === 0);
    if (matches.length !== 1) {
      errors[path] = "Value must match exactly one allowed shape.";
    }
    return errors;
  }

  if (schema.anyOf?.length) {
    const matches = schema.anyOf.some((candidate) => Object.keys(validate(candidate, value, path, required)).length === 0);
    if (!matches) errors[path] = "Value must match at least one allowed shape.";
    return errors;
  }

  if (isEmptyOptional(value)) {
    if (required) {
      errors[path] = "This field is required.";
    }
    return errors;
  }

  if (value === null) {
    if (!allowsNull(schema)) errors[path] = "This field cannot be null.";
    return errors;
  }

  const type = primaryType(schema);

  if (type === "object" || schema.properties) {
    if (typeof value !== "object" || Array.isArray(value)) {
      errors[path] = "Enter an object.";
      return errors;
    }
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      const field = object[name];
      if (field === undefined || field === null || field === "") {
        errors[`${path}.${name}`] = "This field is required.";
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(object)) {
        if (!allowed.has(key)) errors[`${path}.${key}`] = "Additional properties are not allowed.";
      }
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      Object.assign(errors, validate(child, object[name], `${path}.${name}`, (schema.required ?? []).includes(name)));
    }
    return errors;
  }

  if ((type === "number" || type === "integer") && value !== undefined && value !== "") {
    if (typeof value !== "number" || !Number.isFinite(value)) errors[path] = "Enter a valid number.";
    else if (type === "integer" && !Number.isInteger(value)) errors[path] = "Enter a whole number.";
    else if (schema.minimum !== undefined && value < schema.minimum) errors[path] = `Must be at least ${schema.minimum}.`;
    else if (schema.maximum !== undefined && value > schema.maximum) errors[path] = `Must be at most ${schema.maximum}.`;
  }
  if (type === "boolean" && value !== undefined && typeof value !== "boolean") errors[path] = "Enter true or false.";
  if (type === "string" && value !== undefined) {
    if (typeof value !== "string") errors[path] = "Enter text.";
    else if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors[path] = `Must be at least ${schema.minLength} characters.`;
    } else if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors[path] = `Must be at most ${schema.maxLength} characters.`;
    } else if (required && value.trim() === "") {
      errors[path] = "This field is required.";
    }
  }
  if (type === "array") {
    if (!Array.isArray(value)) errors[path] = "Enter a list of items.";
    else {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors[path] = `Provide at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}.`;
      } else if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors[path] = `Provide at most ${schema.maxItems} item${schema.maxItems === 1 ? "" : "s"}.`;
      } else if (required && value.length === 0) {
        errors[path] = "This field is required.";
      }
      if (schema.items) {
        value.forEach((item, index) => {
          Object.assign(errors, validate(schema.items!, item, `${path}.${index}`, true));
        });
      }
    }
  }
  if (schema.enum && value !== undefined && !schema.enum.some((option) => Object.is(option, value))) {
    errors[path] = "Choose one of the allowed values.";
  }
  return errors;
}

export function validateDecisionResult(schema: JsonSchema, value: unknown): Errors {
  return validate(schema, value, "result", true);
}

function setAtPath(source: Record<string, unknown>, path: string[], value: unknown) {
  const result = { ...source };
  let cursor: unknown = result;
  path.forEach((part, index) => {
    const parent = cursor as Record<string, unknown> | unknown[];
    if (index === path.length - 1) {
      if (Array.isArray(parent)) parent[Number(part)] = value;
      else parent[part] = value;
      return;
    }
    const current = Array.isArray(parent) ? parent[Number(part)] : parent[part];
    const clone = Array.isArray(current)
      ? [...current]
      : { ...((current as Record<string, unknown> | undefined) ?? {}) };
    if (Array.isArray(parent)) parent[Number(part)] = clone;
    else parent[part] = clone;
    cursor = clone;
  });
  return result;
}

function emptyItem(schema?: JsonSchema): unknown {
  const type = primaryType(schema ?? {});
  if (type === "object" || schema?.properties) return {};
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  return "";
}

function ResultField({
  name,
  schema,
  value,
  required,
  path,
  errors,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  path: string[];
  errors: Errors;
  onChange: (path: string[], value: unknown) => void;
}) {
  const id = `result-${path.join("-")}`;
  const error = errors[`result.${path.join(".")}`] ?? errors[path.length ? `result.${path.join(".")}` : "result"];
  const pathKey = `result.${path.join(".")}`;
  const fieldError = errors[pathKey];
  const describedBy = [schema.description ? `${id}-description` : "", fieldError ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ") || undefined;
  const label = labelFor(name, schema);
  const type = primaryType(schema);

  if (schema.oneOf?.length || schema.anyOf?.length) {
    const variants = schema.oneOf ?? schema.anyOf ?? [];
    const selectedIndex = typeof value === "object" && value && "__variant" in (value as object)
      ? Number((value as { __variant: number }).__variant)
      : 0;
    const selected = variants[selectedIndex] ?? variants[0]!;
    const payload = typeof value === "object" && value && "value" in (value as object)
      ? (value as { value: unknown }).value
      : value;
    return (
      <fieldset className="field-group" aria-invalid={fieldError ? true : undefined}>
        <legend>{label}{required && <span className="required-marker" aria-label="required"> *</span>}</legend>
        {schema.description && <p className="field-description">{schema.description}</p>}
        <label className="field-label" htmlFor={`${id}-variant`}>Variant</label>
        <select
          id={`${id}-variant`}
          className="field-input"
          value={String(selectedIndex)}
          onChange={(event) => onChange(path, { __variant: Number(event.target.value), value: emptyItem(variants[Number(event.target.value)]) })}
        >
          {variants.map((variant, index) => (
            <option key={index} value={index}>{variant.title ?? `Option ${index + 1}`}</option>
          ))}
        </select>
        <ResultField
          name="value"
          schema={selected}
          value={payload}
          required={required}
          path={[...path, "value"]}
          errors={errors}
          onChange={(childPath, childValue) => {
            const nextPath = childPath.slice(path.length + 1);
            if (nextPath.length === 0) onChange(path, { __variant: selectedIndex, value: childValue });
            else {
              const base = (typeof payload === "object" && payload && !Array.isArray(payload)
                ? payload
                : {}) as Record<string, unknown>;
              onChange(path, { __variant: selectedIndex, value: setAtPath(base, nextPath, childValue) });
            }
          }}
        />
        {fieldError && <p className="field-error" role="alert">{fieldError}</p>}
      </fieldset>
    );
  }

  if (type === "object" || schema.properties) {
    const object = (value ?? {}) as Record<string, unknown>;
    return (
      <fieldset className="field-group" aria-invalid={fieldError ? true : undefined}>
        <legend>{label}{required && <span className="required-marker" aria-label="required"> *</span>}</legend>
        {schema.description && <p className="field-description">{schema.description}</p>}
        {Object.entries(schema.properties ?? {}).map(([childName, child]) => (
          <ResultField
            key={childName}
            name={childName}
            schema={child}
            value={object[childName]}
            required={(schema.required ?? []).includes(childName)}
            path={[...path, childName]}
            errors={errors}
            onChange={onChange}
          />
        ))}
        {fieldError && <p className="field-error" role="alert">{fieldError}</p>}
      </fieldset>
    );
  }

  const common = {
    id,
    name: path.join("."),
    "aria-invalid": fieldError ? true : undefined,
    "aria-describedby": describedBy,
  };

  let control;
  if (schema.enum) {
    const enumValue = value === undefined || value === null ? "" : String(value);
    control = (
      <select
        className="field-input"
        value={enumValue}
        onChange={(event) => {
          const selected = schema.enum?.find((option) => String(option) === event.target.value);
          onChange(path, event.target.value === "" ? undefined : selected);
        }}
        {...common}
      >
        <option value="">Choose an option</option>
        {schema.enum.map((option) => (
          <option key={String(option)} value={String(option)}>{String(option)}</option>
        ))}
      </select>
    );
  } else if (type === "boolean") {
    control = (
      <select
        className="field-input"
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(event) => onChange(path, event.target.value === "" ? undefined : event.target.value === "true")}
        {...common}
      >
        <option value="">Choose yes or no</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
        {allowsNull(schema) && <option value="null">Null</option>}
      </select>
    );
  } else if (type === "array") {
    const itemSchema = schema.items ?? { type: "string" };
    const objectItems = primaryType(itemSchema) === "object" || Boolean(itemSchema.properties);
    const items = Array.isArray(value) ? value : [];
    if (objectItems) {
      control = (
        <div className="array-object-editor">
          {items.map((item, index) => (
            <div key={index} className="array-object-item">
              <ResultField
                name={`Item ${index + 1}`}
                schema={itemSchema}
                value={item}
                required
                path={[...path, String(index)]}
                errors={errors}
                onChange={onChange}
              />
              <Button
                variant="ghost"
                type="button"
                onClick={() => onChange(path, items.filter((_, itemIndex) => itemIndex !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            type="button"
            onClick={() => onChange(path, [...items, emptyItem(itemSchema)])}
            disabled={schema.maxItems !== undefined && items.length >= schema.maxItems}
          >
            Add item
          </Button>
        </div>
      );
    } else {
      control = (
        <textarea
          className="field-textarea"
          value={items.map((item) => String(item ?? "")).join("\n")}
          placeholder="One item per line"
          onChange={(event) => {
            const itemType = primaryType(itemSchema);
            const lines = event.target.value.split("\n").map((item) => item.trim()).filter(Boolean);
            onChange(
              path,
              lines.map((item) =>
                itemType === "boolean"
                  ? item === "true"
                  : itemType === "number" || itemType === "integer"
                    ? Number(item)
                    : item,
              ),
            );
          }}
          {...common}
        />
      );
    }
  } else {
    control = (
      <input
        className="field-input"
        type={type === "number" || type === "integer" ? "number" : "text"}
        step={type === "integer" ? 1 : type === "number" ? "any" : undefined}
        min={schema.minimum}
        max={schema.maximum}
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(event) => {
          if (event.target.value === "" && allowsNull(schema) && !required) {
            onChange(path, null);
            return;
          }
          onChange(
            path,
            type === "number" || type === "integer"
              ? (event.target.value === "" ? undefined : Number(event.target.value))
              : event.target.value,
          );
        }}
        {...common}
      />
    );
  }

  return (
    <div className="field-row">
      <label className="field-label" htmlFor={id}>
        {label}{required && <span className="required-marker" aria-label="required"> *</span>}
      </label>
      {schema.description && <p id={`${id}-description`} className="field-description">{schema.description}</p>}
      {control}
      {fieldError && <p id={`${id}-error`} className="field-error" role="alert">{fieldError}</p>}
      {!fieldError && error && path.length > 0 && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}

function unwrapVariants(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapVariants);
  if (value && typeof value === "object" && "__variant" in (value as object) && "value" in (value as object)) {
    return unwrapVariants((value as { value: unknown }).value);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, unwrapVariants(child)]),
    );
  }
  return value;
}

export function DecisionTray({
  schema,
  initialResult,
  onConfirm,
  confirming,
  mode = "live",
}: {
  schema?: Record<string, unknown>;
  initialResult?: Record<string, unknown>;
  onConfirm: (result: Record<string, unknown>, summary: string) => void;
  confirming?: boolean;
  mode?: "live" | "text";
}) {
  const resultSchema = (schema ?? { type: "object", properties: {} }) as JsonSchema;
  const [result, setResult] = useState<Record<string, unknown>>(initialResult ?? {});
  const [summary, setSummary] = useState("");
  const [errors, setErrors] = useState<Errors>({});

  const handleConfirm = () => {
    const payload = unwrapVariants(result) as Record<string, unknown>;
    const nextErrors = validateDecisionResult(resultSchema, payload);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) onConfirm(payload, summary);
  };

  return (
    <section className="decision-tray" aria-labelledby="decision-tray-heading">
      <h2 id="decision-tray-heading">{mode === "text" ? "Text response" : "Captured decision"}</h2>
      <p className="decision-intro">Fields marked <span aria-hidden="true">*</span> are required.</p>
      {Object.entries(resultSchema.properties ?? {}).map(([name, property]) => (
        <ResultField
          key={name}
          name={name}
          schema={property}
          value={result[name]}
          required={(resultSchema.required ?? []).includes(name)}
          path={[name]}
          errors={errors}
          onChange={(path, value) => setResult((current) => setAtPath(current, path, value))}
        />
      ))}
      {errors.result && <p className="field-error" role="alert">{errors.result}</p>}
      <div className="field-row">
        <label className="field-label" htmlFor="summary">Summary (optional)</label>
        <input
          id="summary"
          className="field-input"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="Brief summary of the decision"
        />
      </div>
      <div className="confirm-bar">
        <Button onClick={handleConfirm} disabled={confirming} aria-label="Confirm and return decision to agent">
          {confirming ? "Confirming…" : "Confirm and return"}
        </Button>
      </div>
    </section>
  );
}
