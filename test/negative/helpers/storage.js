// Spec 112 (FR-004/FR-006) — storage helpers for the negative-path suites.
//
// A handful of guards are DEFENCE IN DEPTH: every public writer already refuses the state the guard
// rejects (e.g. `setFeeNetting(true, address(0), …)` reverts, so `FeeRecipientUnset` can only fire if
// storage got there some other way — a botched upgrade, a future setter that forgets the check). The
// only honest way to exercise such a guard from a test is to put the contract in that state directly
// with `hardhat_setStorageAt` and assert the guard still holds.
//
// Slots are NEVER hardcoded here: they are read from the compiler's own `storageLayout` output for the
// named contract (the OpenZeppelin upgrades plugin adds it to every build), so a layout change moves the
// slot the test writes rather than silently writing the wrong word.

const hre = require("hardhat");
const { ethers } = hre;

/**
 * Locate a top-level state variable in `fqName`'s storage layout.
 * @param {string} fqName e.g. "contracts/pools/WagerPool.sol:WagerPool"
 * @param {string} label  the variable name as declared
 * @returns {Promise<{slot: bigint, offset: number, numberOfBytes: number}>}
 */
async function locateVar(fqName, label) {
  const [source, name] = fqName.split(":");
  const buildInfo = await hre.artifacts.getBuildInfo(fqName);
  if (!buildInfo) throw new Error(`no build info for ${fqName}`);
  const out = buildInfo.output.contracts[source]?.[name];
  const layout = out?.storageLayout;
  if (!layout) {
    throw new Error(
      `storageLayout missing for ${fqName} — the compiler output selection no longer includes it, so this ` +
        `test cannot locate '${label}' safely. Refusing to guess a slot.`
    );
  }
  const entry = layout.storage.find((s) => s.label === label);
  if (!entry) throw new Error(`'${label}' not found in ${fqName} storage layout`);
  const type = layout.types[entry.type];
  return { slot: BigInt(entry.slot), offset: entry.offset, numberOfBytes: Number(type.numberOfBytes) };
}

async function readWord(address, slot) {
  return BigInt(await ethers.provider.getStorage(address, slot));
}

async function writeWord(address, slot, value) {
  await hre.network.provider.send("hardhat_setStorageAt", [
    address,
    ethers.toQuantity(slot),
    ethers.zeroPadValue(ethers.toBeHex(value), 32),
  ]);
}

/**
 * Overwrite ONE packed variable in place, preserving every other byte of its slot.
 * @param {string} address contract (or proxy) address
 * @param {string} fqName  contract whose layout governs `address`'s storage
 * @param {string} label   variable name
 * @param {bigint|number|boolean} value new value (booleans → 0/1, addresses → BigInt(addr))
 */
async function setPackedVar(address, fqName, label, value) {
  const { slot, offset, numberOfBytes } = await locateVar(fqName, label);
  if (numberOfBytes > 32) throw new Error(`'${label}' spans more than one slot; not a packed scalar`);
  const v = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(value);
  const width = BigInt(numberOfBytes) * 8n;
  const shift = BigInt(offset) * 8n;
  const mask = ((1n << width) - 1n) << shift;
  const word = await readWord(address, slot);
  await writeWord(address, slot, (word & ~mask) | ((v << shift) & mask));
}

module.exports = { locateVar, setPackedVar, readWord, writeWord };
