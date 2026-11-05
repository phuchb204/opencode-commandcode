import { describe, expect, it } from "vitest"
import { normalizePlanId, planAllows, planLabel, planMonthlyCredits } from "../src/plan.js"

describe("plan helpers", () => {
  it("normalizes aliases", () => {
    expect(normalizePlanId("goat")).toBe("individual-goat")
    expect(normalizePlanId("individual-goat")).toBe("individual-goat")
    expect(normalizePlanId("MAX-20X")).toBe("individual-max")
    expect(normalizePlanId("unknown")).toBeUndefined()
  })

  it("labels known and unknown plans", () => {
    expect(planLabel("individual-goat")).toBe("GOAT")
    expect(planLabel("teams-pro")).toBe("Teams Pro")
    expect(planLabel(undefined)).toBe("Unknown")
  })

  it("allows the current plan and earlier plans", () => {
    expect(planAllows("individual-goat", "individual-go")).toBe(true)
    expect(planAllows("individual-goat", "individual-goat")).toBe(true)
    expect(planAllows("individual-goat", "individual-pro")).toBe(false)
    expect(planAllows("individual-goat", "individual-max")).toBe(false)
    expect(planAllows("individual-max", "individual-pro")).toBe(true)
  })

  it("fails open for unknown plans and minimums", () => {
    expect(planAllows(undefined, "individual-max")).toBe(true)
    expect(planAllows("individual-goat", undefined)).toBe(true)
    expect(planAllows("individual-goat", "teams-pro")).toBe(true)
  })

  it("exposes the monthly credit pool", () => {
    expect(planMonthlyCredits("individual-goat")).toBe(70)
    expect(planMonthlyCredits("go")).toBe(10)
  })
})
