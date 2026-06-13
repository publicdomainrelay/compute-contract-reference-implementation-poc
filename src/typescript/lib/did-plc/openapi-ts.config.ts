import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./openapi.fixed.yaml",
  output: {
    path: "./generated",
    module: {
      extension: ".ts",
    },
  },
  plugins: [
    "@hey-api/client-fetch",
    "@hey-api/sdk",
    {
      name: "@hey-api/typescript",
      enums: "typescript",
    },
  ],
});
