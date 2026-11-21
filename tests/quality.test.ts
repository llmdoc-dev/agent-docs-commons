import { describe, expect, it } from "vitest";
import {
  checkSourceUrl,
  checkSnippetFields,
  contentHash,
  isSolanaAddress,
  reputationDelta,
} from "../src/quality.ts";

describe("quality checks", () => {
  it("accepts official https doc hosts", () => {
    expect(checkSourceUrl("https://react.dev/reference/react/useState").ok).toBe(true);
    expect(checkSourceUrl("https://expressjs.com/en/guide/using-middleware.html").ok).toBe(true);
    expect(checkSourceUrl("https://zod.dev/api").ok).toBe(true);
    expect(checkSourceUrl("https://nextjs.org/docs/app/building-your-application/routing").ok).toBe(true);
    expect(checkSourceUrl("https://nodejs.org/docs/latest-v22.x/api/fs.html").ok).toBe(true);
    expect(checkSourceUrl("https://www.typescriptlang.org/docs/handbook/utility-types.html").ok).toBe(true);
    expect(checkSourceUrl("https://docs.python.org/3/library/pathlib.html").ok).toBe(true);
    expect(checkSourceUrl("https://docs.docker.com/reference/dockerfile/").ok).toBe(true);
    expect(checkSourceUrl("https://docs.stripe.com/payments/payment-intents").ok).toBe(true);
    expect(checkSourceUrl("https://developers.openai.com/api/docs/guides/structured-outputs").ok).toBe(true);
    expect(checkSourceUrl("https://docs.langchain.com/oss/python/langchain/agents").ok).toBe(true);
    expect(checkSourceUrl("https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/welcome.html").ok).toBe(true);
    expect(checkSourceUrl("https://docs.aws.amazon.com/boto3/latest/guide/credentials.html").ok).toBe(true);
    expect(checkSourceUrl("https://tailwindcss.com/docs/installation").ok).toBe(false);
  });

  it("rejects http, unknown hosts, and unofficial GitHub repos", () => {
    expect(checkSourceUrl("http://react.dev/reference/react/useState").ok).toBe(false);
    const badHost = checkSourceUrl("https://random-blog.example/react-hooks");
    expect(badHost.ok).toBe(false);
    const badGh = checkSourceUrl("https://github.com/someone/unrelated/blob/main/README.md");
    expect(badGh.ok).toBe(false);
    expect(checkSourceUrl("https://github.com/facebook/react/blob/main/README.md").ok).toBe(true);
  });

  it("rejects short bodies, bad wallets, and duplicate-hash material is stable", () => {
    const wallet = "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7";
    expect(isSolanaAddress(wallet)).toBe(true);
    expect(isSolanaAddress("not-an-address")).toBe(false);
    const short = checkSnippetFields({
      wallet,
      library: "react",
      libraryVersion: "19.0.0",
      title: "Hello",
      body: "too short",
      sourceUrl: "https://react.dev/reference/react/useState",
    });
    expect(short.ok).toBe(false);
    const a = contentHash({
      library: "react",
      libraryVersion: "19",
      title: "t",
      body: "b",
      sourceUrl: "https://react.dev/x",
    });
    const b = contentHash({
      library: "react",
      libraryVersion: "19",
      title: "t",
      body: "b",
      sourceUrl: "https://react.dev/x",
    });
    expect(a).toBe(b);
  });

  it("applies reputation deltas", () => {
    expect(reputationDelta("fact_used_submitter")).toBe(2);
    expect(reputationDelta("snippet_rejected")).toBe(-2);
    expect(reputationDelta("verification_accepted")).toBe(1);
  });
});
