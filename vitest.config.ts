import { defineConfig } from "vitest/config"

const runRulesTests =
  process.env.RUN_RULES_TESTS === "1" || Boolean(process.env.FIRESTORE_EMULATOR_HOST)

export default defineConfig({
  test: {
    exclude: runRulesTests
      ? ["node_modules/**", ".next/**"]
      : ["node_modules/**", ".next/**", "firestore.rules.test.ts"],
  },
})
