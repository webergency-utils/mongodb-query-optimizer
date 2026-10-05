import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(process.cwd(), ".github/workflows/ci.yml");

describe("settled MongoDB 8 CI contract", () =>
{
  it("uses Node 24 and the repository URI secret without local MongoDB setup", async () =>
  {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("node-version: 24");
    expect(workflow).toContain(
      "MONGODB_URI: ${{ secrets.MONGODB_QUERY_OPTIMIZER_TEST_URI }}",
    );
    expect(workflow.match(/MONGODB_QUERY_OPTIMIZER_TEST_URI/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/mongodb-7|7\.0/i);
    expect(workflow).not.toMatch(/\bservices:|\bdocker\b|\bapt-get\b|\bbrew\b/);
    expect(workflow).not.toMatch(/mongodb(?:\+srv)?:\/\//i);
    expect(workflow).not.toContain("environment: mongodb-query-optimizer-tests");
  });

  it("runs the complete command path with immutable action references", async () =>
  {
    const workflow = await readFile(workflowPath, "utf8");
    const actionReferences = Array.from(
      workflow.matchAll(/uses:\s+\S+@(\S+)/g),
      (match) => match[1]!,
    );

    expect(workflow).toContain("run: npm run test:all");
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences)
    {
      expect(reference).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
