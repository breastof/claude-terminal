const assert = require("assert");
const { getAutoAssignedRole } = require("../symphony-workflows");

// Case 1: Sub-epic (parent_id set, created by CTO) → must route to PM
{
  const task = { type: "epic", status: "backlog", parent_id: 5, children_count: 0, tags: [] };
  const role = getAutoAssignedRole(task);
  assert.strictEqual(role, "pm", `Sub-epic should route to pm, got: ${role}`);
  console.log("✓ Case 1 PASS: sub-epic (parent_id set) → pm");
}

// Case 2: Root epic (no parent, no children) → must route to CTO
{
  const task = { type: "epic", status: "backlog", parent_id: null, children_count: 0, tags: [] };
  const role = getAutoAssignedRole(task);
  assert.strictEqual(role, "cto", `Root epic should route to cto, got: ${role}`);
  console.log("✓ Case 2 PASS: root epic (no parent, no children) → cto");
}

// Case 3: Epic with children already (decomposed) → must route to PM
{
  const task = { type: "epic", status: "backlog", parent_id: null, children_count: 3, tags: [] };
  const role = getAutoAssignedRole(task);
  assert.strictEqual(role, "pm", `Epic with children should route to pm, got: ${role}`);
  console.log("✓ Case 3 PASS: epic with children → pm");
}

console.log("\nAll assertions passed.");
