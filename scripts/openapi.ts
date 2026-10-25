import ts from "typescript";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  responseContracts,
  binaryContracts,
  envelope,
  errorContract,
  responseJSON,
  responseDefinitions,
} from "../apps/api/contracts.js";
// Build-time extraction executes only this repository's static Zod expressions.
// It never imports the API or opens its database and does not inspect user input.
const paths: Record<string, any> = {};
for (const file of readdirSync("apps/api").filter((f) => f.endsWith(".ts"))) {
  const text = readFileSync(`apps/api/${file}`, "utf8"),
    source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
    schemas: Record<string, z.ZodType> = {};
  function evaluate(expr: ts.Expression) {
    return Function(
      "z",
      ...Object.keys(schemas),
      `return (${expr.getText(source)});`,
    )(z, ...Object.values(schemas)) as z.ZodType;
  }
  function collect(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      /^z\s*\./.test(node.initializer.getText(source))
    ) {
      try {
        const value = evaluate(node.initializer);
        if (value instanceof z.ZodType) schemas[node.name.text] = value;
      } catch {}
    }
    ts.forEachChild(node, collect);
  }
  collect(source);
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "app" &&
      ["get", "post", "patch", "delete"].includes(node.expression.name.text) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const method = node.expression.name.text,
        route = node.arguments[0].text;
      if (!route.includes("*")) {
        const path = route.replace(/:([A-Za-z]+)/g, "{$1}"),
          operation: any = {
            operationId: `${method}_${route.replace(/[^A-Za-z0-9]+/g, "_")}`,
            tags: [route.split("/")[2] ?? "health"],
            responses: {
              "200": {
                description: "Success",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["data"],
                      properties: { data: {} },
                    },
                  },
                },
              },
              "400": { description: "Invalid input or business constraint" },
              "401": { description: "Missing or expired session" },
              "403": { description: "Permission denied" },
              "413": { description: "Input or resource limit" },
              "429": { description: "Busy or rate limited" },
            },
          };
        const response = responseContracts[`${method.toUpperCase()} ${route}`];
        const binary = binaryContracts[`${method.toUpperCase()} ${route}`];
        if (!response && !binary && route !== "/v1/openapi.json")
          throw Error(`RESPONSE_CONTRACT_MISSING: ${method} ${route}`);
        if (response)
          operation.responses["200"].content["application/json"].schema =
            responseJSON(envelope(response));
        else if (route === "/v1/openapi.json")
          operation.responses["200"].content["application/json"].schema = {
            $ref: "https://spec.openapis.org/oas/3.1/schema/2022-10-07",
          };
        for (const status of [
          "400",
          "401",
          "403",
          "404",
          "413",
          "429",
          "500",
          "503",
        ])
          operation.responses[status] = {
            description:
              status === "500"
                ? "Internal or response contract error"
                : "Request rejected",
            content: {
              "application/json": { schema: responseJSON(errorContract) },
            },
          };
        if (route === "/health/ready")
          operation.responses["503"] = {
            description: "Dependency not ready",
            content: {
              "application/json": { schema: responseJSON(envelope(response!)) },
            },
          };
        const publicRoute =
          route.startsWith("/health/") ||
          [
            "/v1/identities",
            "/v1/auth/challenge",
            "/v1/auth/verify",
            "/v1/demo/login",
            "/v1/chain/status",
            "/v1/openapi.json",
          ].includes(route) ||
          route.startsWith("/v1/export-download/");
        if (!publicRoute) operation.security = [{ bearerAuth: [] }];
        operation.parameters = [...route.matchAll(/:([A-Za-z]+)/g)].map(
          (m) => ({
            name: m[1],
            in: "path",
            required: true,
            schema: { type: "string", maxLength: 256 },
          }),
        );
        const parseNodes: ts.CallExpression[] = [];
        function parseCalls(child: ts.Node) {
          if (
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === "parse" &&
            child.arguments[0] &&
            /req\.(?:body|query)/.test(child.arguments[0].getText(source))
          )
            parseNodes.push(child);
          ts.forEachChild(child, parseCalls);
        }
        node.arguments.slice(1).forEach(parseCalls);
        for (const parse of parseNodes) {
          const schema = evaluate(
              (parse.expression as ts.PropertyAccessExpression).expression,
            ),
            json = z.toJSONSchema(schema, {
              target: "draft-2020-12",
              unrepresentable: "any",
              io: "input",
            }) as any;
          delete json.$schema;
          if (parse.arguments[0].getText(source).includes("req.query"))
            for (const [name, property] of Object.entries(
              json.properties ?? {},
            ))
              operation.parameters.push({
                name,
                in: "query",
                required: (json.required ?? []).includes(name),
                schema: property,
              });
          else
            operation.requestBody = {
              required: true,
              content: { "application/json": { schema: json } },
            };
        }
        if (method === "post" && !operation.requestBody) {
          if (["/v1/assets", "/v1/verify", "/v1/verify/c2pa"].includes(route))
            operation.requestBody = {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    required: ["file"],
                    properties: { file: { type: "string", format: "binary" } },
                  },
                },
              },
            };
          else
            operation.requestBody = {
              required: false,
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: false },
                },
              },
            };
        }
        if (
          route.endsWith("/content") ||
          route === "/v1/bundles" ||
          route.startsWith("/v1/export-download/")
        )
          operation.responses["200"] = {
            description: "Authorized binary response",
            content: {
              [binary ?? "application/octet-stream"]: {
                schema: { type: "string", format: "binary" },
              },
            },
          };
        (paths[path] ??= {})[method] = operation;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const doc = {
  openapi: "3.1.0",
  info: {
    title: "ContentProof API",
    version: "1.1.0",
    description:
      "Generated request schemas and strict domain response contracts. The same response contracts are enforced before JSON serialization; binary and OpenAPI document responses are declared separately.",
  },
  servers: [{ url: "/" }],
  components: {
    schemas: responseDefinitions,
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  paths,
};
writeFileSync("docs/openapi.json", JSON.stringify(doc, null, 2));
console.log(
  `OpenAPI generated for ${Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0)} operations.`,
);
