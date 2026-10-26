// SPDX-License-Identifier: MIT
//
// Ordering + timing primitives for the adversarial escrow suites (spec 112, User Story 5 / FR-011).
//
// Coverage tools measure which lines ran, not which ORDER an attacker can impose on them (#1667 sat
// behind 100% statement coverage). These helpers let a test state an ordering explicitly:
//
//   - `sameBlock(...)`  puts a victim's tx and an attacker's front-run into ONE block, ordered the way
//                       a block builder orders them (higher priority fee first), exactly as a mempool
//                       watcher would land them;
//   - `at(ts, fn)`      runs one tx at an exact `block.timestamp`, for deadline-boundary assertions;
//   - `balancesOf(...)` snapshots token balances so a scenario can assert conservation.

const { ethers, network } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const GAS = 3_000_000n;

/**
 * Send several txs into the mempool with automine OFF and mine them in one block.
 *
 * Each entry is `{ send: (overrides) => Promise<TransactionResponse>, tip: bigint }`. Hardhat's default
 * mempool order is fee priority, so the entry with the larger `tip` is mined first — the attacker
 * "front-runs" by paying more, precisely the real-world shape of the race. Returns the responses in the
 * order given; a reverted one can be passed to `revertedWithCustomError`.
 */
async function sameBlock(entries) {
  const base = (await ethers.provider.getBlock('latest')).baseFeePerGas ?? 0n;
  await network.provider.send('evm_setAutomine', [false]);
  const sent = [];
  try {
    for (const e of entries) {
      sent.push(
        await e.send({
          gasLimit: GAS,
          maxPriorityFeePerGas: e.tip,
          maxFeePerGas: base * 4n + e.tip,
        })
      );
    }
    await network.provider.send('evm_mine', []);
  } finally {
    await network.provider.send('evm_setAutomine', [true]);
  }
  return sent;
}

/** Index of each tx within its (shared) block — proves the ordering the scenario claims. */
async function positions(responses) {
  const out = [];
  for (const r of responses) {
    const rc = await ethers.provider.getTransactionReceipt(r.hash);
    out.push({ block: rc.blockNumber, index: rc.index, status: rc.status });
  }
  return out;
}

/**
 * The custom error a MINED, reverted tx raised, decoded against `contract`'s ABI.
 *
 * hardhat-chai-matchers' `revertedWithCustomError` cannot read the revert data of a tx that was already
 * mined in a manual (automine-off) block, so a same-block race is asserted through the node's own trace
 * instead: `debug_traceTransaction` returns the exact return data, which is decoded here. Returns
 * `{ status, name, args }`; a tx that succeeded returns `name: null`.
 */
async function minedRevert(contract, response) {
  const rc = await ethers.provider.getTransactionReceipt(response.hash);
  if (rc.status === 1) return { status: 1, name: null, args: null };
  const trace = await network.provider.send('debug_traceTransaction', [
    response.hash,
    { disableMemory: true, disableStack: true, disableStorage: true },
  ]);
  const data = trace.returnValue.startsWith('0x') ? trace.returnValue : `0x${trace.returnValue}`;
  const parsed = contract.interface.parseError(data);
  return { status: 0, name: parsed ? parsed.name : `<undecoded ${data}>`, args: parsed ? parsed.args : null };
}

/** Mine `fn()`'s tx at exactly `block.timestamp == ts`. */
async function at(ts, fn) {
  await time.setNextBlockTimestamp(ts);
  return fn();
}

/** { label: balance } for every holder, read from `token`. */
async function balancesOf(token, holders) {
  const out = {};
  for (const [label, addr] of Object.entries(holders)) {
    out[label] = await token.balanceOf(typeof addr === 'string' ? addr : await addr.getAddress());
  }
  return out;
}

module.exports = { sameBlock, positions, minedRevert, at, balancesOf };
