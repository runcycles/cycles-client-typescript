/** The withCycles higher-order function for budget-guarded function calls. */

import { CyclesClient } from "./client.js";
import type { CyclesConfig } from "./config.js";
import { AsyncCyclesLifecycle, type WithCyclesConfig } from "./lifecycle.js";
import { CommitRetryEngine } from "./retry.js";

let _defaultClient: CyclesClient | undefined;
let _defaultConfig: CyclesConfig | undefined;

export function setDefaultClient(client: CyclesClient): void {
  _defaultClient = client;
}

export function setDefaultConfig(config: CyclesConfig): void {
  _defaultConfig = config;
}

/** @internal Exposed for testing only. */
export function _resetDefaults(): void {
  _defaultClient = undefined;
  _defaultConfig = undefined;
}

function getEffectiveClient(
  explicitClient: CyclesClient | undefined,
): CyclesClient {
  if (explicitClient) return explicitClient;
  if (_defaultClient) return _defaultClient;
  if (_defaultConfig) {
    _defaultClient = new CyclesClient(_defaultConfig);
    return _defaultClient;
  }
  throw new Error(
    "No Cycles client available. Either pass client in options, " +
      "call setDefaultClient(), or call setDefaultConfig().",
  );
}

export function withCycles<TArgs extends unknown[], TResult>(
  options: WithCyclesConfig & { client?: CyclesClient },
  fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    const client = getEffectiveClient(options.client);
    const config = client.config;

    const defaultSubject = {
      tenant: config.tenant,
      workspace: config.workspace,
      app: config.app,
      workflow: config.workflow,
      agent: config.agent,
      toolset: config.toolset,
    };

    const retryEngine = new CommitRetryEngine(config);
    const lifecycle = new AsyncCyclesLifecycle(
      client,
      retryEngine,
      defaultSubject,
    );

    return lifecycle.execute(
      fn as (...args: unknown[]) => Promise<TResult>,
      args,
      options,
    );
  };
}
