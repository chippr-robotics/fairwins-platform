"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Throwaway repo tree under os.tmpdir(): { "contracts/x/A.sol": "...", ... } -> root dir. */
function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-gates-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

module.exports = { makeTree };
