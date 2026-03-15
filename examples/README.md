# Examples

Working examples showing how to integrate the `runcycles` TypeScript client with popular LLM providers, frameworks, and patterns.

## Integration patterns

Every example demonstrates one or both of the two main integration patterns:

| Pattern | Best for | How it works |
|---|---|---|
| **`withCycles`** (HOF) | Non-streaming calls | Wraps an async function with automatic reserve → execute → commit. Budget is reserved before your function runs, actual usage is committed after it returns, and the reservation is released if it throws. |
| **`reserveForStream`** (streaming adapter) | Streaming / long-running calls | Returns a handle with `commit()` and `release()` methods. You control when to commit (typically in an `onFinish` callback). A background heartbeat keeps the reservation alive during the stream. |

## LLM provider examples

| Example | Provider | Patterns | Key features |
|---|---|---|---|
| [anthropic-sdk](./anthropic-sdk/) | Anthropic Claude | Both | `messages.create()` and `messages.stream()`, caps-aware `max_tokens` |
| [openai-sdk](./openai-sdk/) | OpenAI | Both | `chat.completions.create()` with `stream: true`, usage from chunks |
| [aws-bedrock](./aws-bedrock/) | AWS Bedrock | Both | `InvokeModelCommand` / `InvokeModelWithResponseStreamCommand`, Claude on Bedrock |
| [google-gemini](./google-gemini/) | Google Gemini | Both | `generateContent()` / `generateContentStream()`, `usageMetadata` extraction |

## Framework examples

| Example | Framework | Patterns | Key features |
|---|---|---|---|
| [vercel-ai-sdk](./vercel-ai-sdk/) | Next.js + Vercel AI SDK | Streaming | `streamText` with `onFinish` callback, 402 response on budget exhaustion |
| [express-middleware](./express-middleware/) | Express | Both | Reusable `cyclesGuard` middleware factory, `res.locals.cyclesHandle`, auto-release on disconnect |
| [langchain-js](./langchain-js/) | LangChain.js | Both | Prompt+LLM chains, multi-step ReAct agent with caps-based tool filtering |

## Standalone examples

These single-file examples demonstrate core client patterns without any LLM or framework dependency:

| File | What it demonstrates |
|---|---|
| [basic-usage.ts](./basic-usage.ts) | Programmatic `CyclesClient` — manual reserve → execute → commit with wire-format JSON |
| [async-usage.ts](./async-usage.ts) | `withCycles` HOF — wrapping an async function with automatic lifecycle management |
| [decorator-usage.ts](./decorator-usage.ts) | `withCycles` with callable estimate/actual functions, reading `caps` and setting `commitMetadata` |

## Running an example

Each integration example is a self-contained project with its own `package.json`:

```bash
cd examples/anthropic-sdk    # or any other example directory
npm install
cp .env.example .env         # fill in your API keys
npm run non-streaming        # or npm run streaming, npm run dev, etc.
```

All examples require:
- **Node.js 20+**
- A running [Cycles server](https://runcycles.io/quickstart/deploying-the-full-cycles-stack)
- A `CYCLES_API_KEY` and `CYCLES_TENANT` configured

See each example's README for provider-specific setup (API keys, AWS credentials, etc.).

## Choosing an example

- **New to Cycles?** Start with `basic-usage.ts` for the raw API, then `async-usage.ts` for the recommended `withCycles` pattern.
- **Integrating an LLM?** Pick the example matching your provider (Anthropic, OpenAI, Bedrock, Gemini).
- **Building a web API?** See `express-middleware` for Express or `vercel-ai-sdk` for Next.js.
- **Using an orchestration framework?** See `langchain-js` for chains and agents.
