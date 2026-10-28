import { describe, expect, it } from "vitest";
import {
  declaredVariables,
  findObject,
  identifier,
  qualifierBefore,
  resolveQualifier,
  statementAround,
  tableReferences,
  type CatalogObject,
} from "./sql-completion";

const objects: CatalogObject[] = [
  { schema: "dbo", name: "Customer", objectId: 1, type: "USER_TABLE" },
  { schema: "sales", name: "Customer", objectId: 2, type: "USER_TABLE" },
  { schema: "sales", name: "Order Details", objectId: 3, type: "USER_TABLE" },
  { schema: "dbo", name: "CustomerNames", objectId: 4, type: "VIEW" },
];

describe("qualifierBefore", () => {
  it("reads the name before the dot, with what is typed after it", () => {
    expect(qualifierBefore("SELECT c.")).toBe("c");
    expect(qualifierBefore("SELECT c.Na")).toBe("c");
    expect(qualifierBefore("FROM dbo.[Cu")).toBe("dbo");
    expect(qualifierBefore("SELECT [Order Details].")).toBe("Order Details");
    expect(qualifierBefore("FROM Sales.dbo.")).toBe("dbo");
  });
  it("is null away from a dot", () => {
    expect(qualifierBefore("SELECT Na")).toBeNull();
    expect(qualifierBefore("SELECT 1.5")).toBeNull();
  });
});

describe("tableReferences", () => {
  it("reads schema, name and alias", () => {
    expect(tableReferences("SELECT * FROM dbo.Customer AS c JOIN sales.[Order Details] d ON 1=1")).toEqual([
      { schema: "dbo", name: "Customer", alias: "c" },
      { schema: "sales", name: "Order Details", alias: "d" },
    ]);
  });
  it("takes no keyword for an alias", () => {
    expect(tableReferences("SELECT * FROM sales.Customer\nWHERE Customer.Id = 1")).toEqual([
      { schema: "sales", name: "Customer", alias: null },
    ]);
    expect(tableReferences("FROM dbo.Customer INNER JOIN dbo.CustomerNames ON 1=1")[0].alias).toBeNull();
  });
  it("reads three-part names, UPDATE, INSERT INTO and MERGE", () => {
    expect(tableReferences("SELECT * FROM Shop.sales.Customer x")).toEqual([
      { schema: "sales", name: "Customer", alias: "x" },
    ]);
    expect(tableReferences("UPDATE Customer SET Name = 1").map((r) => r.name)).toEqual(["Customer"]);
    expect(tableReferences("INSERT INTO dbo.Customer (Id) VALUES (1)")[0]).toEqual({
      schema: "dbo",
      name: "Customer",
      alias: null,
    });
    expect(tableReferences("MERGE INTO dbo.Customer AS t USING sales.Customer AS s ON 1=1").map((r) => r.alias)).toEqual([
      "t",
      "s",
    ]);
  });
  it("leaves out table variables and temporary tables", () => {
    expect(tableReferences("SELECT * FROM @rows r JOIN #temp t ON 1=1")).toEqual([]);
  });
});

describe("resolveQualifier", () => {
  const refs = tableReferences("SELECT * FROM sales.Customer c JOIN dbo.CustomerNames ON 1=1");
  it("follows an alias to its table", () => {
    expect(resolveQualifier("c", refs, objects)).toEqual({ columnsOf: objects[1] });
    expect(resolveQualifier("C", refs, objects)).toEqual({ columnsOf: objects[1] });
  });
  it("takes a table named in the script, then any table by name", () => {
    expect(resolveQualifier("CustomerNames", refs, objects)).toEqual({ columnsOf: objects[3] });
    expect(resolveQualifier("Customer", [], objects)).toEqual({ columnsOf: objects[0] });
  });
  it("takes a schema when no table has the name", () => {
    expect(resolveQualifier("sales", refs, objects)).toEqual({ schema: "sales" });
  });
  it("is null for an unknown name", () => {
    expect(resolveQualifier("nothing", refs, objects)).toBeNull();
  });
});

describe("findObject", () => {
  it("uses the schema when given, else prefers dbo", () => {
    expect(findObject(objects, "customer", "SALES")?.objectId).toBe(2);
    expect(findObject(objects, "Customer", null)?.objectId).toBe(1);
    expect(findObject(objects, "Order Details", null)?.objectId).toBe(3);
  });
});

describe("identifier", () => {
  it("leaves regular names plain and brackets the rest", () => {
    expect(identifier("Customer")).toBe("Customer");
    expect(identifier("Order Details")).toBe("[Order Details]");
    expect(identifier("Order")).toBe("[Order]");
    expect(identifier("1st")).toBe("[1st]");
    expect(identifier("a]b")).toBe("[a]]b]");
  });
});

describe("declaredVariables", () => {
  it("lists each variable once, without system functions", () => {
    expect(declaredVariables("DECLARE @Id int, @from date; SELECT @id, @@ROWCOUNT, a@b.c")).toEqual(["@Id", "@from"]);
  });
});

describe("statementAround", () => {
  const text = "SELECT 1 FROM a;\nSELECT 2 FROM b\nGO\nSELECT 3 FROM c";
  it("is the statement the cursor is in", () => {
    expect(statementAround(text, 3).trim()).toBe("SELECT 1 FROM a");
    expect(statementAround(text, text.indexOf("2")).trim()).toBe("SELECT 2 FROM b");
    expect(statementAround(text, text.length).trim()).toBe("SELECT 3 FROM c");
  });
});
