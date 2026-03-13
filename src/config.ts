/** Configuration for the Cycles client. */

export class CyclesConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly tenant?: string;
  readonly workspace?: string;
  readonly app?: string;
  readonly workflow?: string;
  readonly agent?: string;
  readonly toolset?: string;
  readonly connectTimeout: number;
  readonly readTimeout: number;
  readonly retryEnabled: boolean;
  readonly retryMaxAttempts: number;
  readonly retryInitialDelay: number;
  readonly retryMultiplier: number;
  readonly retryMaxDelay: number;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    tenant?: string;
    workspace?: string;
    app?: string;
    workflow?: string;
    agent?: string;
    toolset?: string;
    connectTimeout?: number;
    readTimeout?: number;
    retryEnabled?: boolean;
    retryMaxAttempts?: number;
    retryInitialDelay?: number;
    retryMultiplier?: number;
    retryMaxDelay?: number;
  }) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.tenant = options.tenant;
    this.workspace = options.workspace;
    this.app = options.app;
    this.workflow = options.workflow;
    this.agent = options.agent;
    this.toolset = options.toolset;
    this.connectTimeout = options.connectTimeout ?? 2_000;
    this.readTimeout = options.readTimeout ?? 5_000;
    this.retryEnabled = options.retryEnabled ?? true;
    this.retryMaxAttempts = options.retryMaxAttempts ?? 5;
    this.retryInitialDelay = options.retryInitialDelay ?? 500;
    this.retryMultiplier = options.retryMultiplier ?? 2.0;
    this.retryMaxDelay = options.retryMaxDelay ?? 30_000;
  }

  static fromEnv(prefix = "CYCLES_"): CyclesConfig {
    const baseUrl = process.env[`${prefix}BASE_URL`];
    const apiKey = process.env[`${prefix}API_KEY`];

    if (!baseUrl) {
      throw new Error(`${prefix}BASE_URL environment variable is required`);
    }
    if (!apiKey) {
      throw new Error(`${prefix}API_KEY environment variable is required`);
    }

    return new CyclesConfig({
      baseUrl,
      apiKey,
      tenant: process.env[`${prefix}TENANT`],
      workspace: process.env[`${prefix}WORKSPACE`],
      app: process.env[`${prefix}APP`],
      workflow: process.env[`${prefix}WORKFLOW`],
      agent: process.env[`${prefix}AGENT`],
      toolset: process.env[`${prefix}TOOLSET`],
      connectTimeout: optionalFloat(process.env[`${prefix}CONNECT_TIMEOUT`], 2_000),
      readTimeout: optionalFloat(process.env[`${prefix}READ_TIMEOUT`], 5_000),
      retryEnabled: process.env[`${prefix}RETRY_ENABLED`]?.toLowerCase() !== "false",
      retryMaxAttempts: optionalInt(process.env[`${prefix}RETRY_MAX_ATTEMPTS`], 5),
      retryInitialDelay: optionalFloat(process.env[`${prefix}RETRY_INITIAL_DELAY`], 500),
      retryMultiplier: optionalFloat(process.env[`${prefix}RETRY_MULTIPLIER`], 2.0),
      retryMaxDelay: optionalFloat(process.env[`${prefix}RETRY_MAX_DELAY`], 30_000),
    });
  }
}

function optionalInt(val: string | undefined, fallback: number): number {
  return val !== undefined ? parseInt(val, 10) : fallback;
}

function optionalFloat(val: string | undefined, fallback: number): number {
  return val !== undefined ? parseFloat(val) : fallback;
}
