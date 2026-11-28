import { createHash } from "node:crypto";

export const ALLOWED_SOURCE_HOSTS = new Set([
  "react.dev",
  "www.react.dev",
  "expressjs.com",
  "www.expressjs.com",
  "zod.dev",
  "v4.zod.dev",
  "nextjs.org",
  "www.nextjs.org",
  "nodejs.org",
  "www.nodejs.org",
  "typescriptlang.org",
  "www.typescriptlang.org",
  "docs.python.org",
  "fastapi.tiangolo.com",
  "docs.djangoproject.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.numpy.org",
  "prisma.io",
  "www.prisma.io",
  "vite.dev",
  "vitejs.dev",
  "requests.readthedocs.io",
  "docs.pydantic.dev",
  "flask.palletsprojects.com",
  "www.postgresql.org",
  "postgresql.org",
  "docs.docker.com",
  "docs.stripe.com",
  "developers.openai.com",
  "platform.openai.com",
  "docs.langchain.com",
  "reference.langchain.com",
  "python.langchain.com",
  "js.langchain.com",
  "docs.aws.amazon.com",
  "boto3.amazonaws.com",
  "docs.x402.org",
  "www.solanakit.com",
  "solanakit.com",
  "solana.com",
  "ts.sdk.modelcontextprotocol.io",
  "py.sdk.modelcontextprotocol.io",
  "modelcontextprotocol.io",
  "docs.phantom.com",
  "ai-sdk.dev",
  "hono.dev",
  "supabase.com",
  "www.supabase.com",
  "orm.drizzle.team",
  "trpc.io",
  "www.trpc.io",
  "platform.claude.com",
  "docs.anthropic.com",
  "www.anchor-lang.com",
  "anchor-lang.com",
  "developers.cloudflare.com",
  "docs.expo.dev",
  "tanstack.com",
  "playwright.dev",
  "svelte.dev",
  "authjs.dev",
  "bun.com",
  "bun.sh",
  "docs.sqlalchemy.org",
  "docs.llamaindex.ai",
  "developers.llamaindex.ai",
  "reactrouter.com",
  "www.reactrouter.com",
  "vitest.dev",
  "docs.pytest.org",
  "docs.astral.sh",
  "biomejs.dev",
  "eslint.org",
  "prettier.io",
]);

export const ALLOWED_GITHUB_REPOS = [
  "facebook/react",
  "reactjs/react.dev",
  "expressjs/express",
  "expressjs/expressjs.com",
  "colinhacks/zod",
  "vercel/next.js",
  "nodejs/node",
  "microsoft/TypeScript-Website",
  "python/cpython",
  "tiangolo/fastapi",
  "django/django",
  "pandas-dev/pandas",
  "numpy/numpy",
  "prisma/prisma",
  "vitejs/vite",
  "psf/requests",
  "pydantic/pydantic",
  "pallets/flask",
  "postgres/postgres",
  "docker/docs",
  "stripe/stripe-node",
  "stripe/stripe-python",
  "openai/openai-python",
  "openai/openai-node",
  "langchain-ai/langchain",
  "langchain-ai/langchainjs",
  "aws/aws-sdk-js-v3",
  "boto/boto3",
  "x402-foundation/x402",
  "coinbase/x402",
  "anza-xyz/kit",
  "solana-foundation/solana-web3.js",
  "modelcontextprotocol/typescript-sdk",
  "modelcontextprotocol/python-sdk",
  "vercel/ai",
  "honojs/hono",
  "honojs/website",
  "supabase/supabase",
  "supabase/supabase-js",
  "drizzle-team/drizzle-orm",
  "trpc/trpc",
  "anthropics/anthropic-sdk-typescript",
  "anthropics/anthropic-sdk-python",
  "coral-xyz/anchor",
  "cloudflare/workers-sdk",
  "cloudflare/cloudflare-docs",
  "expo/expo",
  "TanStack/query",
  "microsoft/playwright",
  "sveltejs/kit",
  "sveltejs/svelte",
  "nextauthjs/next-auth",
  "oven-sh/bun",
  "sqlalchemy/sqlalchemy",
  "run-llama/llama_index",
  "remix-run/react-router",
  "vitest-dev/vitest",
  "pytest-dev/pytest",
  "astral-sh/uv",
  "astral-sh/ruff",
  "biomejs/biome",
  "biomejs/website",
  "eslint/eslint",
  "prettier/prettier",
];

export const MAX_BODY_CHARS = 1500;
export const MIN_BODY_CHARS = 40;
export const MAX_TITLE_CHARS = 160;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type SourceCheck =
  | { ok: true; hostname: string; normalizedUrl: string }
  | { ok: false; error: string };

export function contentHash(parts: {
  library: string;
  libraryVersion: string;
  title: string;
  body: string;
  sourceUrl: string;
}): string {
  const material = [
    parts.library.trim().toLowerCase(),
    parts.libraryVersion.trim(),
    parts.title.trim(),
    parts.body.trim(),
    parts.sourceUrl.trim(),
  ].join("|");
  return createHash("sha256").update(material).digest("hex");
}

export function isSolanaAddress(value: string): boolean {
  return BASE58.test(value);
}

export function checkSourceUrl(raw: string): SourceCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "sourceUrl must be a valid absolute URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "sourceUrl must use https" };
  }
  const host = url.hostname.toLowerCase();
  if (ALLOWED_SOURCE_HOSTS.has(host)) {
    return { ok: true, hostname: host, normalizedUrl: url.toString() };
  }
  if (host === "github.com" || host === "www.github.com") {
    const path = url.pathname.replace(/^\/+/, "");
    const ok = ALLOWED_GITHUB_REPOS.some((repo) => path === repo || path.startsWith(`${repo}/`));
    if (ok) {
      return { ok: true, hostname: host, normalizedUrl: url.toString() };
    }
    return {
      ok: false,
      error: "github.com sources must be from an official seed-library repository",
    };
  }
  return {
    ok: false,
    error: `source host ${host} is not on the official-docs allowlist`,
  };
}

export function checkSnippetFields(input: {
  wallet: string;
  library: string;
  libraryVersion: string;
  title: string;
  body: string;
  sourceUrl: string;
}): { ok: true } | { ok: false; error: string } {
  if (!isSolanaAddress(input.wallet) && input.wallet !== "platform" && input.wallet !== "house") {
    return { ok: false, error: "wallet must be a Solana address" };
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.library)) {
    return { ok: false, error: "library must be a lowercase slug" };
  }
  if (!input.libraryVersion.trim() || input.libraryVersion.length > 40) {
    return { ok: false, error: "libraryVersion is required" };
  }
  if (!input.title.trim() || input.title.length > MAX_TITLE_CHARS) {
    return { ok: false, error: `title is required and must be <= ${MAX_TITLE_CHARS} characters` };
  }
  const body = input.body.trim();
  if (body.length < MIN_BODY_CHARS) {
    return { ok: false, error: `body must be at least ${MIN_BODY_CHARS} characters` };
  }
  if (body.length > MAX_BODY_CHARS) {
    return { ok: false, error: `body must be <= ${MAX_BODY_CHARS} characters (short cited excerpts only)` };
  }
  const source = checkSourceUrl(input.sourceUrl);
  if (!source.ok) return source;
  return { ok: true };
}

export type ReputationEvent =
  | "contribution_verified"
  | "verification_accepted"
  | "fact_used_submitter"
  | "fact_used_verifier"
  | "snippet_rejected";

export function reputationDelta(event: ReputationEvent): number {
  switch (event) {
    case "contribution_verified":
      return 1;
    case "verification_accepted":
      return 1;
    case "fact_used_submitter":
      return 2;
    case "fact_used_verifier":
      return 1;
    case "snippet_rejected":
      return -2;
  }
}
