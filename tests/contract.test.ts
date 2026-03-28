import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

// Ajv and ajv-formats use CJS default exports that conflict with NodeNext
// module resolution. Use dynamic import to get the runtime values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Ajv: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let addFormats: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ValidateFunction = any;

// ---------------------------------------------------------------------------
// Load OpenAPI spec and register component schemas with Ajv
// ---------------------------------------------------------------------------

const specPath = resolve(import.meta.dirname, "fixtures/cycles-protocol-v0.yaml");
const spec = YAML.parse(readFileSync(specPath, "utf-8"));
const schemas = spec.components.schemas as Record<string, Record<string, unknown>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ajv: any;
const validators: Record<string, ValidateFunction> = {};

beforeAll(async () => {
  // Dynamic imports to handle CJS/ESM interop with NodeNext resolution
  const ajvMod = await import("ajv");
  const fmtMod = await import("ajv-formats");
  Ajv = ajvMod.default ?? ajvMod;
  addFormats = fmtMod.default ?? fmtMod;

  ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  // First pass: register every component schema so $ref can resolve.
  for (const [name, schema] of Object.entries(schemas)) {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }

  // Second pass: compile validators for the schemas we care about.
  const targetSchemas = [
    "DecisionRequest",
    "DecisionResponse",
    "ReservationCreateRequest",
    "ReservationCreateResponse",
    "CommitRequest",
    "CommitResponse",
    "EventCreateRequest",
    "EventCreateResponse",
    "ErrorResponse",
    "Amount",
    "Subject",
    "Action",
    "UnitEnum",
    "ErrorCode",
  ];

  for (const name of targetSchemas) {
    validators[name] = ajv.compile(schemas[name]);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function valid(schemaName: string, data: unknown) {
  const validate = validators[schemaName];
  const ok = validate(data);
  if (!ok) {
    return { pass: false, errors: validate.errors };
  }
  return { pass: true, errors: null };
}

function expectValid(schemaName: string, data: unknown) {
  const result = valid(schemaName, data);
  expect(result.errors).toBeNull();
  expect(result.pass).toBe(true);
}

function expectInvalid(schemaName: string, data: unknown) {
  const result = valid(schemaName, data);
  expect(result.pass).toBe(false);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SUBJECT = { tenant: "acme" };
const ACTION = { kind: "llm.completion", name: "openai:gpt-4o" };
const AMOUNT = { unit: "USD_MICROCENTS", amount: 50000 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAPI contract tests", () => {
  // ---- Primitive / enum schemas ------------------------------------------

  describe("UnitEnum", () => {
    const expectedValues = ["USD_MICROCENTS", "TOKENS", "CREDITS", "RISK_POINTS"];

    it("has exactly the expected values", () => {
      expect(schemas["UnitEnum"].enum).toEqual(expectedValues);
    });

    it.each(expectedValues)("accepts %s", (val) => {
      expectValid("UnitEnum", val);
    });

    it("rejects unknown value", () => {
      expectInvalid("UnitEnum", "EUROS");
    });
  });

  describe("ErrorCode", () => {
    const expectedValues = [
      "INVALID_REQUEST",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "BUDGET_EXCEEDED",
      "BUDGET_FROZEN",
      "BUDGET_CLOSED",
      "RESERVATION_EXPIRED",
      "RESERVATION_FINALIZED",
      "IDEMPOTENCY_MISMATCH",
      "UNIT_MISMATCH",
      "OVERDRAFT_LIMIT_EXCEEDED",
      "DEBT_OUTSTANDING",
      "MAX_EXTENSIONS_EXCEEDED",
      "INTERNAL_ERROR",
    ];

    it("has exactly the expected values", () => {
      expect(schemas["ErrorCode"].enum).toEqual(expectedValues);
    });

    it.each(expectedValues)("accepts %s", (val) => {
      expectValid("ErrorCode", val);
    });

    it("rejects unknown code", () => {
      expectInvalid("ErrorCode", "UNKNOWN_ERROR");
    });
  });

  // ---- Leaf object schemas -----------------------------------------------

  describe("Amount", () => {
    it("validates a correct Amount", () => {
      expectValid("Amount", AMOUNT);
    });

    it("rejects missing unit", () => {
      expectInvalid("Amount", { amount: 100 });
    });

    it("rejects negative amount", () => {
      expectInvalid("Amount", { unit: "TOKENS", amount: -1 });
    });

    it("rejects additional properties", () => {
      expectInvalid("Amount", { ...AMOUNT, extra: true });
    });
  });

  describe("Subject", () => {
    it("validates with tenant", () => {
      expectValid("Subject", { tenant: "acme" });
    });

    it("validates with multiple fields", () => {
      expectValid("Subject", { tenant: "acme", workspace: "ws-1", agent: "agent-1" });
    });

    it("validates with dimensions alongside a standard field", () => {
      expectValid("Subject", { tenant: "acme", dimensions: { cost_center: "eng" } });
    });

    it("rejects empty object", () => {
      expectInvalid("Subject", {});
    });

    it("rejects additional properties", () => {
      expectInvalid("Subject", { tenant: "acme", unknown_field: "x" });
    });
  });

  describe("Action", () => {
    it("validates a correct Action", () => {
      expectValid("Action", ACTION);
    });

    it("validates with tags", () => {
      expectValid("Action", { ...ACTION, tags: ["prod", "customer-facing"] });
    });

    it("rejects missing kind", () => {
      expectInvalid("Action", { name: "gpt-4" });
    });

    it("rejects missing name", () => {
      expectInvalid("Action", { kind: "llm.completion" });
    });
  });

  // ---- Request schemas ---------------------------------------------------

  describe("DecisionRequest", () => {
    const validBody = {
      idempotency_key: "dk-1",
      subject: SUBJECT,
      action: ACTION,
      estimate: AMOUNT,
    };

    it("validates a correct body", () => {
      expectValid("DecisionRequest", validBody);
    });

    it("validates with optional metadata", () => {
      expectValid("DecisionRequest", { ...validBody, metadata: { trace_id: "abc" } });
    });

    it("rejects missing idempotency_key", () => {
      const { idempotency_key: _, ...body } = validBody;
      expectInvalid("DecisionRequest", body);
    });

    it("rejects missing subject", () => {
      const { subject: _, ...body } = validBody;
      expectInvalid("DecisionRequest", body);
    });

    it("rejects missing action", () => {
      const { action: _, ...body } = validBody;
      expectInvalid("DecisionRequest", body);
    });

    it("rejects missing estimate", () => {
      const { estimate: _, ...body } = validBody;
      expectInvalid("DecisionRequest", body);
    });

    it("rejects additional properties", () => {
      expectInvalid("DecisionRequest", { ...validBody, extra: "nope" });
    });
  });

  describe("ReservationCreateRequest", () => {
    const validBody = {
      idempotency_key: "rk-1",
      subject: SUBJECT,
      action: ACTION,
      estimate: AMOUNT,
    };

    it("validates a correct body", () => {
      expectValid("ReservationCreateRequest", validBody);
    });

    it("validates with all optional fields", () => {
      expectValid("ReservationCreateRequest", {
        ...validBody,
        ttl_ms: 30000,
        grace_period_ms: 5000,
        overage_policy: "ALLOW_IF_AVAILABLE",
        dry_run: false,
        metadata: { foo: "bar" },
      });
    });

    it("rejects missing idempotency_key", () => {
      const { idempotency_key: _, ...body } = validBody;
      expectInvalid("ReservationCreateRequest", body);
    });

    it("rejects missing subject", () => {
      const { subject: _, ...body } = validBody;
      expectInvalid("ReservationCreateRequest", body);
    });

    it("rejects missing action", () => {
      const { action: _, ...body } = validBody;
      expectInvalid("ReservationCreateRequest", body);
    });

    it("rejects missing estimate", () => {
      const { estimate: _, ...body } = validBody;
      expectInvalid("ReservationCreateRequest", body);
    });

    it("rejects ttl_ms below minimum", () => {
      expectInvalid("ReservationCreateRequest", { ...validBody, ttl_ms: 500 });
    });

    it("rejects additional properties", () => {
      expectInvalid("ReservationCreateRequest", { ...validBody, extra: true });
    });
  });

  describe("CommitRequest", () => {
    const validBody = {
      idempotency_key: "ck-1",
      actual: AMOUNT,
    };

    it("validates a correct body", () => {
      expectValid("CommitRequest", validBody);
    });

    it("validates with optional metrics", () => {
      expectValid("CommitRequest", {
        ...validBody,
        metrics: { tokens_input: 100, tokens_output: 50, latency_ms: 320 },
      });
    });

    it("validates with optional metadata", () => {
      expectValid("CommitRequest", { ...validBody, metadata: { ref: "abc" } });
    });

    it("rejects missing idempotency_key", () => {
      const { idempotency_key: _, ...body } = validBody;
      expectInvalid("CommitRequest", body);
    });

    it("rejects missing actual", () => {
      const { actual: _, ...body } = validBody;
      expectInvalid("CommitRequest", body);
    });

    it("rejects additional properties", () => {
      expectInvalid("CommitRequest", { ...validBody, extra: 1 });
    });
  });

  describe("EventCreateRequest", () => {
    const validBody = {
      idempotency_key: "ek-1",
      subject: SUBJECT,
      action: ACTION,
      actual: AMOUNT,
    };

    it("validates a correct body", () => {
      expectValid("EventCreateRequest", validBody);
    });

    it("validates with all optional fields", () => {
      expectValid("EventCreateRequest", {
        ...validBody,
        overage_policy: "ALLOW_WITH_OVERDRAFT",
        metrics: { tokens_input: 200 },
        client_time_ms: 1700000000000,
        metadata: { source: "test" },
      });
    });

    it("rejects missing idempotency_key", () => {
      const { idempotency_key: _, ...body } = validBody;
      expectInvalid("EventCreateRequest", body);
    });

    it("rejects missing subject", () => {
      const { subject: _, ...body } = validBody;
      expectInvalid("EventCreateRequest", body);
    });

    it("rejects missing action", () => {
      const { action: _, ...body } = validBody;
      expectInvalid("EventCreateRequest", body);
    });

    it("rejects missing actual", () => {
      const { actual: _, ...body } = validBody;
      expectInvalid("EventCreateRequest", body);
    });

    it("rejects additional properties", () => {
      expectInvalid("EventCreateRequest", { ...validBody, extra: true });
    });
  });

  // ---- Response schemas --------------------------------------------------

  describe("DecisionResponse", () => {
    it("validates ALLOW response", () => {
      expectValid("DecisionResponse", { decision: "ALLOW" });
    });

    it("validates ALLOW_WITH_CAPS response", () => {
      expectValid("DecisionResponse", {
        decision: "ALLOW_WITH_CAPS",
        caps: { max_tokens: 1000 },
      });
    });

    it("validates DENY response with reason", () => {
      expectValid("DecisionResponse", {
        decision: "DENY",
        reason_code: "BUDGET_EXCEEDED",
        retry_after_ms: 5000,
        affected_scopes: ["tenant:acme"],
      });
    });

    it("rejects missing decision", () => {
      expectInvalid("DecisionResponse", {});
    });

    it("rejects invalid decision value", () => {
      expectInvalid("DecisionResponse", { decision: "MAYBE" });
    });
  });

  describe("ReservationCreateResponse", () => {
    const validBody = {
      decision: "ALLOW",
      reservation_id: "r-123",
      affected_scopes: ["tenant:acme"],
    };

    it("validates a correct ALLOW response", () => {
      expectValid("ReservationCreateResponse", validBody);
    });

    it("validates with optional fields", () => {
      expectValid("ReservationCreateResponse", {
        ...validBody,
        reserved: AMOUNT,
        expires_at_ms: 1700000060000,
        scope_path: "tenant:acme",
        balances: [
          {
            scope: "tenant:acme",
            scope_path: "tenant:acme",
            remaining: { unit: "USD_MICROCENTS", amount: 900000 },
          },
        ],
      });
    });

    it("rejects missing decision", () => {
      expectInvalid("ReservationCreateResponse", { affected_scopes: ["tenant:acme"] });
    });

    it("rejects missing affected_scopes", () => {
      expectInvalid("ReservationCreateResponse", { decision: "ALLOW" });
    });
  });

  describe("CommitResponse", () => {
    const validBody = {
      status: "COMMITTED",
      charged: AMOUNT,
    };

    it("validates a correct response", () => {
      expectValid("CommitResponse", validBody);
    });

    it("validates with optional balances", () => {
      expectValid("CommitResponse", {
        ...validBody,
        released: { unit: "USD_MICROCENTS", amount: 10000 },
        balances: [
          {
            scope: "tenant:acme",
            scope_path: "tenant:acme",
            remaining: { unit: "USD_MICROCENTS", amount: 850000 },
          },
        ],
      });
    });

    it("rejects missing status", () => {
      expectInvalid("CommitResponse", { charged: AMOUNT });
    });

    it("rejects missing charged", () => {
      expectInvalid("CommitResponse", { status: "COMMITTED" });
    });

    it("rejects invalid status value", () => {
      expectInvalid("CommitResponse", { status: "DONE", charged: AMOUNT });
    });
  });

  describe("EventCreateResponse", () => {
    const validBody = {
      status: "APPLIED",
      event_id: "evt-123",
    };

    it("validates a correct response", () => {
      expectValid("EventCreateResponse", validBody);
    });

    it("validates with optional charged and balances", () => {
      expectValid("EventCreateResponse", {
        ...validBody,
        charged: AMOUNT,
        balances: [
          {
            scope: "tenant:acme",
            scope_path: "tenant:acme",
            remaining: { unit: "USD_MICROCENTS", amount: 750000 },
          },
        ],
      });
    });

    it("rejects missing status", () => {
      expectInvalid("EventCreateResponse", { event_id: "evt-1" });
    });

    it("rejects missing event_id", () => {
      expectInvalid("EventCreateResponse", { status: "APPLIED" });
    });

    it("rejects invalid status value", () => {
      expectInvalid("EventCreateResponse", { status: "DONE", event_id: "evt-1" });
    });
  });

  describe("ErrorResponse", () => {
    const validBody = {
      error: "BUDGET_EXCEEDED",
      message: "Tenant budget exceeded",
      request_id: "req-abc",
    };

    it("validates a correct error response", () => {
      expectValid("ErrorResponse", validBody);
    });

    it("validates with optional details", () => {
      expectValid("ErrorResponse", {
        ...validBody,
        details: { remaining: 0, limit: 100000 },
      });
    });

    it("rejects missing error", () => {
      expectInvalid("ErrorResponse", { message: "oops", request_id: "r-1" });
    });

    it("rejects missing message", () => {
      expectInvalid("ErrorResponse", { error: "INTERNAL_ERROR", request_id: "r-1" });
    });

    it("rejects missing request_id", () => {
      expectInvalid("ErrorResponse", { error: "INTERNAL_ERROR", message: "oops" });
    });

    it("rejects invalid error code", () => {
      expectInvalid("ErrorResponse", {
        error: "MADE_UP_CODE",
        message: "bad",
        request_id: "r-1",
      });
    });

    it("rejects additional properties", () => {
      expectInvalid("ErrorResponse", { ...validBody, extra_field: true });
    });
  });
});
