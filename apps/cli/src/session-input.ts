import { readFileSync } from "node:fs";

type SessionInputOptions = {
  file?: string;
  stdin?: boolean;
};

type InputReader = (source: string | number) => string;

const defaultReader: InputReader = (source) => readFileSync(source, "utf8");

/** Read exactly one JSON session payload without forcing agents to create a file. */
export function readSessionCreateInput(
  options: SessionInputOptions,
  read: InputReader = defaultReader,
): Record<string, unknown> {
  if (Boolean(options.file) === Boolean(options.stdin)) {
    throw new Error("Provide exactly one of --file <path> or --stdin");
  }

  const raw = options.stdin ? read(0) : read(options.file!);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Session input must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Session input must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
