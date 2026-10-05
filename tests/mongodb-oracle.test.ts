import { describe, expect, it } from "vitest";
import {
  MONGODB_ORACLE_DATABASE,
  MONGODB_ORACLE_WRITE_ATTESTATION,
  assertReadOnlyPipeline,
  bindPipelineNamespaces,
  buildPhysicalCollectionNames,
  compareObservations,
  isCurrentLeaseOwner,
  validateMongoOracleEnvironment,
} from "./helpers/mongodb-oracle.js";

const validEnvironment = (): Record<string, string> => ({
  MONGODB_URI: "mongodb://127.0.0.1/?authSource=admin",
  MONGODB_TEST_DATABASE: MONGODB_ORACLE_DATABASE,
  MONGODB_TEST_RUN_ID: "run-123_abc",
  MONGODB_TEST_WRITE_ATTESTATION: MONGODB_ORACLE_WRITE_ATTESTATION,
});

const success = (...documents: Record<string, unknown>[]) => ({
  status: "success" as const,
  documents,
});

const failure = (
  code: number,
  codeName: string,
  labels: string[] = [],
) => ({
  status: "error" as const,
  error: {
    code,
    codeName,
    labels,
  },
});

describe("MongoDB oracle configuration guards", () =>
{
  it("accepts only the exact target database and a strict run ID", () =>
  {
    const configuration = validateMongoOracleEnvironment(validEnvironment());

    expect(configuration.database).toBe(MONGODB_ORACLE_DATABASE);
    expect(configuration.runId).toBe("run-123_abc");
  });

  it("accepts an absent URI database without treating authSource as the target", () =>
  {
    const environment = validEnvironment();
    environment.MONGODB_URI = "mongodb://127.0.0.1/?authSource=another_database";

    expect(validateMongoOracleEnvironment(environment).database)
      .toBe(MONGODB_ORACLE_DATABASE);
  });

  it.each([
    "",
    "webergency_mongodb_query_optimizer_suffix",
    "prefix_webergency_mongodb_query_optimizer",
    "WEBERGENCY_MONGODB_QUERY_OPTIMIZER",
    " webergency_mongodb_query_optimizer",
    "admin",
  ])("rejects an unauthorized environment database: %s", (database) =>
  {
    const environment = validEnvironment();
    environment.MONGODB_TEST_DATABASE = database;

    expect(() => validateMongoOracleEnvironment(environment))
      .toThrow("MongoDB oracle configuration rejected");
  });

  it.each([
    "mongodb://127.0.0.1/other",
    "mongodb://127.0.0.1/admin?authSource=webergency_mongodb_query_optimizer",
    "mongodb://127.0.0.1/WEBERGENCY_MONGODB_QUERY_OPTIMIZER",
    "mongodb://127.0.0.1/%20webergency_mongodb_query_optimizer",
  ])("rejects a non-exact URI database: %s", (uri) =>
  {
    const environment = validEnvironment();
    environment.MONGODB_URI = uri;

    expect(() => validateMongoOracleEnvironment(environment))
      .toThrow("MongoDB oracle configuration rejected");
  });

  it.each([
    "",
    "UPPERCASE",
    "contains space",
    "contains.dot",
    "-starts-with-dash",
    "ends-with-dash-",
    "a".repeat(41),
  ])("rejects an unsanitized run ID: %s", (runId) =>
  {
    const environment = validEnvironment();
    environment.MONGODB_TEST_RUN_ID = runId;

    expect(() => validateMongoOracleEnvironment(environment))
      .toThrow("MongoDB oracle configuration rejected");
  });

  it("requires the exact explicit write attestation", () =>
  {
    for (const attestation of ["", "yes", `${MONGODB_ORACLE_WRITE_ATTESTATION} `])
    {
      const environment = validEnvironment();
      environment.MONGODB_TEST_WRITE_ATTESTATION = attestation;

      expect(() => validateMongoOracleEnvironment(environment))
        .toThrow("MongoDB oracle configuration rejected");
    }
  });

  it("sanitizes every rejected configuration error", () =>
  {
    const username = "unit-user-token";
    const password = "unit-password-token";
    const host = "unit-host-token.invalid";
    const environment = validEnvironment();
    environment.MONGODB_URI = [
      "mongodb://",
      username,
      ":",
      password,
      "@",
      host,
      "/wrong_database?authSource=admin&replicaSet=unit-option-token",
    ].join("");

    let message = "";
    try
    {
      validateMongoOracleEnvironment(environment);
    }
    catch (error)
    {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      "MongoDB oracle configuration rejected: MONGODB_URI database is not authorized",
    );
    expect(message).not.toContain(username);
    expect(message).not.toContain(password);
    expect(message).not.toContain(host);
    expect(message).not.toContain("unit-option-token");
  });
});

describe("MongoDB oracle namespace and ownership guards", () =>
{
  it("binds every namespace-bearing field recursively without mutating logical input", () =>
  {
    const pipeline = [
      {
        $lookup: {
          from: "orders",
          pipeline: [
            { $unionWith: "archive" },
            {
              $graphLookup: {
                from: "people",
                startWith: "$manager",
                connectFromField: "manager",
                connectToField: "_id",
                as: "chain",
              },
            },
          ],
          as: "orders",
        },
      },
      {
        $facet: {
          nested: [
            {
              $unionWith: {
                coll: "archive",
                pipeline: [
                  {
                    $lookup: {
                      from: "orders",
                      pipeline: [{ $match: { active: true } }],
                      as: "nestedOrders",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ];
    const snapshot = structuredClone(pipeline);
    const bound = bindPipelineNamespaces(pipeline, {
      main: "physical_main",
      orders: "physical_orders",
      archive: "physical_archive",
      people: "physical_people",
    });

    expect(bound[0].$lookup.from).toBe("physical_orders");
    expect(bound[0].$lookup.pipeline[0].$unionWith).toBe("physical_archive");
    expect(bound[0].$lookup.pipeline[1].$graphLookup.from).toBe("physical_people");
    expect(bound[1].$facet.nested[0].$unionWith.coll).toBe("physical_archive");
    expect(
      bound[1].$facet.nested[0].$unionWith.pipeline[0].$lookup.from,
    ).toBe("physical_orders");
    expect(pipeline).toEqual(snapshot);
  });

  it("rejects write-capable stages at any nesting depth", () =>
  {
    expect(() => assertReadOnlyPipeline([{ $out: "result" }]))
      .toThrow("write-capable");
    expect(() => assertReadOnlyPipeline([
      {
        $facet: {
          unsafe: [{ $merge: { into: "result" } }],
        },
      },
    ])).toThrow("write-capable");
    expect(() => assertReadOnlyPipeline([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $out: "result" }],
          as: "orders",
        },
      },
    ])).toThrow("write-capable");
  });

  it("creates disjoint run, case, and side collection names", () =>
  {
    const common = {
      runId: "run-1",
      runToken: "a".repeat(24),
      caseId: "match-all-or",
      caseToken: "b".repeat(16),
      logicalCollectionIds: ["main", "orders"],
    };
    const original = buildPhysicalCollectionNames({
      ...common,
      side: "original",
    });
    const optimized = buildPhysicalCollectionNames({
      ...common,
      side: "optimized",
    });
    const anotherCase = buildPhysicalCollectionNames({
      ...common,
      caseId: "multikey-in",
      side: "original",
    });

    expect(new Set(Object.values(original)).size).toBe(2);
    expect(Object.values(original)).not.toEqual(Object.values(optimized));
    expect(Object.values(original)).not.toEqual(Object.values(anotherCase));
    for (const name of [
      ...Object.values(original),
      ...Object.values(optimized),
      ...Object.values(anotherCase),
    ])
    {
      expect(name).toMatch(/^wqo_[a-z0-9_]+$/);
      expect(name.length).toBeLessThanOrEqual(120);
    }
  });

  it("recognizes only a live lease owned by the exact current token", () =>
  {
    const lease = {
      ownerToken: "owner-token",
      leaseExpiresAt: new Date("2026-09-04T13:00:00.000Z"),
    };

    expect(isCurrentLeaseOwner(
      lease,
      "owner-token",
      new Date("2026-09-04T12:59:59.999Z"),
    )).toBe(true);
    expect(isCurrentLeaseOwner(
      lease,
      "stale-token",
      new Date("2026-09-04T12:59:59.999Z"),
    )).toBe(false);
    expect(isCurrentLeaseOwner(
      lease,
      "owner-token",
      new Date("2026-09-04T13:00:00.000Z"),
    )).toBe(false);
  });
});

describe("MongoDB oracle observation comparison", () =>
{
  it("preserves order, missing fields, nulls, and embedded key order", () =>
  {
    expect(compareObservations({
      mode: "ordered-bson",
      original: success({ value: 1 }, { value: 2 }),
      optimized: success({ value: 2 }, { value: 1 }),
    }).equal).toBe(false);
    expect(compareObservations({
      mode: "ordered-bson",
      original: success({ value: null }),
      optimized: success({}),
    }).equal).toBe(false);
    expect(compareObservations({
      mode: "ordered-bson",
      original: success({ embedded: { a: 1, b: 2 } }),
      optimized: success({ embedded: { b: 2, a: 1 } }),
    }).equal).toBe(false);
  });

  it("compares multisets without losing multiplicity", () =>
  {
    expect(compareObservations({
      mode: "multiset",
      original: success({ value: 1 }, { value: 2 }),
      optimized: success({ value: 2 }, { value: 1 }),
    }).equal).toBe(true);
    expect(compareObservations({
      mode: "multiset",
      original: success({ value: 1 }, { value: 1 }),
      optimized: success({ value: 1 }),
    }).equal).toBe(false);
  });

  it("compares stable server error identity and normalizes only generated namespaces", () =>
  {
    const originalNamespace = "wqo_run_case_original_main";
    const optimizedNamespace = "wqo_run_case_optimized_main";
    expect(compareObservations({
      mode: "acceptance-error",
      original: failure(26, `NamespaceNotFound:${originalNamespace}`, ["Retryable"]),
      optimized: failure(26, `NamespaceNotFound:${optimizedNamespace}`, ["Retryable"]),
      generatedNamespaces: [originalNamespace, optimizedNamespace],
    }).equal).toBe(true);
    expect(compareObservations({
      mode: "acceptance-error",
      original: failure(26, "NamespaceNotFound", ["Retryable"]),
      optimized: failure(26, "NamespaceNotFound", ["TransientTransactionError"]),
    }).equal).toBe(false);
    expect(compareObservations({
      mode: "acceptance-error",
      original: success({ value: 1 }),
      optimized: success({ value: 999 }),
    }).equal).toBe(true);
  });

  it("requires structural barriers to retain the BSON form", () =>
  {
    expect(compareObservations({
      mode: "structural-barrier",
      original: success({ accepted: true }),
      optimized: success({ accepted: true }),
      originalForm: [{ $project: { value: { $rand: {} } } }],
      optimizedForm: [{ $project: { value: { $rand: {} } } }],
    }).equal).toBe(true);
    expect(compareObservations({
      mode: "structural-barrier",
      original: success({ accepted: true }),
      optimized: success({ accepted: true }),
      originalForm: [{ $project: { value: { $rand: {} } } }],
      optimizedForm: [{ $project: { value: 1 } }],
    }).equal).toBe(false);

    expect(compareObservations({
      mode: "structural-barrier",
      original: failure(9, "FailedToParse"),
      optimized: failure(9, "FailedToParse"),
      originalForm: [{ $limit: "2" }],
      optimizedForm: [{ $limit: 2 }],
    }).equal).toBe(false);
  });
});
