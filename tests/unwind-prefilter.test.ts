import { describe, expect, it } from "vitest";
import {
  proveUnwindPrefilter,
} from "../src/passes/unwind-proofs.js";
import {
  UnwindPrefilterPass,
} from "../src/passes/unwind-prefilter.js";

describe("proveUnwindPrefilter", () =>
{
  it("proves synthesis for simple string path unwind followed by child path match", () =>
  {
    const unwind = { $unwind: "$orders" };
    const match = { $match: { "orders.total": { $gt: 50 } } };

    const proof = proveUnwindPrefilter(unwind, match);
    expect(proof).not.toBeNull();
    expect(proof?.prefilterStage).toEqual({
      $match: {
        orders: {
          $elemMatch: {
            total: { $gt: 50 },
          },
        },
      },
    });
  });

  it("proves synthesis for object-form unwind with preserveNullAndEmptyArrays: false", () =>
  {
    const unwind = {
      $unwind: {
        path: "$items",
        preserveNullAndEmptyArrays: false,
      },
    };
    const match = {
      $match: {
        "items.status": "available",
        "items.qty": { $gte: 1 },
      },
    };

    const proof = proveUnwindPrefilter(unwind, match);
    expect(proof).not.toBeNull();
    expect(proof?.prefilterStage).toEqual({
      $match: {
        items: {
          $elemMatch: {
            status: "available",
            qty: { $gte: 1 },
          },
        },
      },
    });
  });

  it("extracts only child conditions when match contains other unrelated fields", () =>
  {
    const unwind = { $unwind: "$items" };
    const match = {
      $match: {
        "items.status": "active",
        orgId: "corp1",
      },
    };

    const proof = proveUnwindPrefilter(unwind, match);
    expect(proof).not.toBeNull();
    expect(proof?.prefilterStage).toEqual({
      $match: {
        items: {
          $elemMatch: {
            status: "active",
          },
        },
      },
    });
  });

  it("rejects when preserveNullAndEmptyArrays is true", () =>
  {
    const unwind = {
      $unwind: {
        path: "$items",
        preserveNullAndEmptyArrays: true,
      },
    };
    const match = { $match: { "items.status": "active" } };

    expect(proveUnwindPrefilter(unwind, match)).toBeNull();
  });

  it("rejects when downstream match references includeArrayIndex", () =>
  {
    const unwind = {
      $unwind: {
        path: "$items",
        includeArrayIndex: "itemIndex",
      },
    };
    const match = {
      $match: {
        "items.status": "active",
        itemIndex: { $gt: 0 },
      },
    };

    expect(proveUnwindPrefilter(unwind, match)).toBeNull();
  });

  it("permits includeArrayIndex when match does not reference it", () =>
  {
    const unwind = {
      $unwind: {
        path: "$items",
        includeArrayIndex: "itemIndex",
      },
    };
    const match = {
      $match: {
        "items.status": "active",
      },
    };

    const proof = proveUnwindPrefilter(unwind, match);
    expect(proof).not.toBeNull();
    expect(proof?.prefilterStage).toEqual({
      $match: {
        items: {
          $elemMatch: {
            status: "active",
          },
        },
      },
    });
  });

  it("rejects when match has no conditions on unwound array", () =>
  {
    const unwind = { $unwind: "$items" };
    const match = { $match: { status: "active", score: 100 } };

    expect(proveUnwindPrefilter(unwind, match)).toBeNull();
  });

  it("rejects when match contains non-deterministic expressions", () =>
  {
    const unwind = { $unwind: "$items" };
    const match = {
      $match: {
        "items.val": { $expr: { $gt: [{ $rand: {} }, 0.5] } },
      },
    };

    expect(proveUnwindPrefilter(unwind, match)).toBeNull();
  });

  it("handles null prototype and custom class objects gracefully", () =>
  {
    const nullProtoMatch = Object.create(null);
    nullProtoMatch["orders.total"] = { $gt: 50 };

    const proof = proveUnwindPrefilter({ $unwind: "$orders" }, { $match: nullProtoMatch });
    expect(proof).not.toBeNull();

    class CustomClass {}
    expect(proveUnwindPrefilter(new CustomClass(), { $match: {} })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: "$orders" }, new CustomClass())).toBeNull();
  });

  it("rejects invalid unwind or match stages", () =>
  {
    expect(proveUnwindPrefilter(null, { $match: {} })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: "$a" }, null)).toBeNull();
    expect(proveUnwindPrefilter("not-object", { $match: {} })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: 123 }, { $match: {} })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: "invalid-path-no-dollar" }, { $match: {} })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: { path: 123 } }, { $match: {} })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: { path: "no-dollar" } }, { $match: {} })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: "$a", extra: 1 }, { $match: {} })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: "$a" }, { $match: "not-object" })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: "$a" }, { notMatch: {} })).toBeNull();
    expect(proveUnwindPrefilter({ $unwind: "$a" }, { $match: {}, extra: 1 })).toBeNull();
  });
});

describe("UnwindPrefilterPass", () =>
{
  const pass = new UnwindPrefilterPass();

  it("has expected pass name", () =>
  {
    expect(pass.name).toBe("unwind-prefilter");
  });

  it("inserts synthesized prefilter ahead of $unwind and keeps downstream $match intact", () =>
  {
    const pipeline = [
      { $match: { orgId: "123" } },
      { $unwind: "$items" },
      { $match: { "items.available": true } },
    ];

    const result = pass.execute(pipeline);
    expect(result).toEqual([
      { $match: { orgId: "123" } },
      { $match: { items: { $elemMatch: { available: true } } } },
      { $unwind: "$items" },
      { $match: { "items.available": true } },
    ]);
  });

  it("is idempotent and does not duplicate prefilter if already present", () =>
  {
    const pipeline = [
      { $match: { orgId: "123" } },
      { $match: { items: { $elemMatch: { available: true } } } },
      { $unwind: "$items" },
      { $match: { "items.available": true } },
    ];

    const result = pass.execute(pipeline);
    expect(result).toEqual(pipeline);
  });

  it("leaves pipelines without applicable unwind unchanged", () =>
  {
    const pipeline = [
      { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
      { $match: { "items.available": true } },
    ];

    const result = pass.execute(pipeline);
    expect(result).toEqual(pipeline);
  });
});
