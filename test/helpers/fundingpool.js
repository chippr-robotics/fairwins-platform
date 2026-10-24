// SPDX-License-Identifier: MIT
//
// Deploy + intent-signing helpers for the FundingPool tests (spec 103). Mirrors test/helpers/wagerpool.js:
// the factory clones an immutable {FundingPool}; contributors put in any amount; the organizer closes;
// organizer / majority / settle deadline flip the pool to refunding. Two ABSOLUTE deadlines
// (contributeDeadline, settleDeadline).

const { ethers, upgrades } = require('hardhat');

const ZERO = ethers.ZeroAddress;
const usdc = (n) => ethers.parseUnits(String(n), 6);

const STATE = { Open: 0n, Closed: 1n, Refunding: 2n };
const REASON = { Organizer: 1n, Majority: 2n, Deadline: 3n };

/** Deploy a FundingPoolFactory proxy with an immutable FundingPool template (test mode by default). */
async function deployFundingFactory({
  admin,
  screeningRequired = false,
  sanctionsGuard = ZERO,
  membershipManager = ZERO,
} = {}) {
  const [deployer] = await ethers.getSigners();
  const adminAddr = admin || deployer.address;

  const Pool = await ethers.getContractFactory('FundingPool');
  const poolImpl = await Pool.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await ethers.getContractFactory('FundingPoolFactory');
  const factory = await upgrades.deployProxy(
    Factory,
    [adminAddr, await poolImpl.getAddress(), sanctionsGuard, membershipManager, screeningRequired],
    { kind: 'uups' }
  );
  await factory.waitForDeployment();
  return { factory, poolImpl };
}

/** Deploy a MockUSDCPermit token and mint `amount` (whole USDC) to each signer in `to`. */
async function deployToken(to = [], amount = 1000) {
  const Token = await ethers.getContractFactory('MockUSDCPermit');
  const token = await Token.deploy();
  await token.waitForDeployment();
  for (const acct of to) {
    await token.mint(acct.address ?? acct, usdc(amount));
  }
  return token;
}

/** Sensible default CreateFundingPoolParams. */
async function defaultParams(token, overrides = {}) {
  const now = (await ethers.provider.getBlock('latest')).timestamp;
  return {
    token: await token.getAddress(),
    goal: usdc(100),
    purpose: "Dana's surprise party",
    contributeDeadline: now + 7 * 24 * 3600,
    settleDeadline: now + 37 * 24 * 3600,
    ...overrides,
  };
}

/** Create a pool and return its {FundingPool} instance + id + wordIndices. */
async function createPool(factory, organizer, params) {
  const rc = await (await factory.connect(organizer).createPool(params)).wait();
  const ev = rc.logs
    .map((l) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === 'PoolCreated');
  const pool = await ethers.getContractAt('FundingPool', ev.args.pool);
  return { pool, poolId: ev.args.poolId, wordIndices: ev.args.wordIndices, address: ev.args.pool };
}

/** approve + contribute as `signer`. */
async function contribute(pool, token, signer, amount) {
  await token.connect(signer).approve(await pool.getAddress(), amount);
  return pool.connect(signer).contribute(amount);
}

// ---------------------------------------------------------------------------
// EIP-712 intent signing (relayer twins)
// ---------------------------------------------------------------------------

async function eip712Domain(pool) {
  const { chainId } = await ethers.provider.getNetwork();
  return {
    name: 'FairWins FundingPool',
    version: '1',
    chainId: Number(chainId),
    verifyingContract: await pool.getAddress(),
  };
}

function randNonce() {
  return ethers.hexlify(ethers.randomBytes(32));
}

const TAIL = [
  { name: 'nonce', type: 'bytes32' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
];

async function signIntent(pool, signer, primaryType, fields, message, opts = {}) {
  const now = (await ethers.provider.getBlock('latest')).timestamp;
  const window = opts.window ?? 3600;
  const nonce = opts.nonce ?? randNonce();
  const validAfter = opts.validAfter ?? now - 60;
  const validBefore = opts.validBefore ?? now + window;
  const full = { ...message, nonce, validAfter, validBefore };
  const domain = await eip712Domain(pool);
  const sig = await signer.signTypedData(domain, { [primaryType]: fields }, full);
  return { sig, nonce, validAfter, validBefore };
}

const signClose = (pool, signer, opts) =>
  signIntent(pool, signer, 'CloseFundingPool', [{ name: 'organizer', type: 'address' }, ...TAIL], { organizer: signer.address }, opts);
const signCancel = (pool, signer, opts) =>
  signIntent(pool, signer, 'CancelFundingPool', [{ name: 'organizer', type: 'address' }, ...TAIL], { organizer: signer.address }, opts);
const signVoteRefund = (pool, signer, opts) =>
  signIntent(pool, signer, 'VoteRefund', [{ name: 'contributor', type: 'address' }, ...TAIL], { contributor: signer.address }, opts);
const signClaimRefund = (pool, signer, opts) =>
  signIntent(pool, signer, 'ClaimRefund', [{ name: 'contributor', type: 'address' }, ...TAIL], { contributor: signer.address }, opts);

/** Sign a CreateFundingPool intent against the FACTORY's own domain. */
async function signCreatePool(factory, signer, params, opts = {}) {
  const { chainId } = await ethers.provider.getNetwork();
  const now = (await ethers.provider.getBlock('latest')).timestamp;
  const nonce = opts.nonce ?? randNonce();
  const validAfter = opts.validAfter ?? now - 60;
  const validBefore = opts.validBefore ?? now + (opts.window ?? 3600);
  const domain = {
    name: 'FairWins FundingPoolFactory',
    version: '1',
    chainId: Number(chainId),
    verifyingContract: await factory.getAddress(),
  };
  const types = {
    CreateFundingPool: [
      { name: 'organizer', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'goal', type: 'uint256' },
      { name: 'purposeHash', type: 'bytes32' },
      { name: 'contributeDeadline', type: 'uint64' },
      { name: 'settleDeadline', type: 'uint64' },
      ...TAIL,
    ],
  };
  const message = {
    organizer: signer.address,
    token: params.token,
    goal: params.goal,
    purposeHash: ethers.keccak256(ethers.toUtf8Bytes(params.purpose)),
    contributeDeadline: params.contributeDeadline,
    settleDeadline: params.settleDeadline,
    nonce,
    validAfter,
    validBefore,
  };
  const sig = await signer.signTypedData(domain, types, message);
  return { sig, nonce, validAfter, validBefore };
}

/** Sign an EIP-3009 ReceiveWithAuthorization for a MockUSDCPermit-style token. */
async function signReceiveAuth(token, from, to, value, opts = {}) {
  const { chainId } = await ethers.provider.getNetwork();
  const now = (await ethers.provider.getBlock('latest')).timestamp;
  const nonce = opts.nonce ?? randNonce();
  const validAfter = opts.validAfter ?? 0;
  const validBefore = opts.validBefore ?? now + (opts.window ?? 3600);
  const domain = { name: 'USD Coin', version: '1', chainId: Number(chainId), verifyingContract: await token.getAddress() };
  const types = {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const sig = await from.signTypedData(domain, types, { from: from.address, to, value, validAfter, validBefore, nonce });
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s, nonce, validAfter, validBefore };
}

module.exports = {
  ZERO,
  usdc,
  STATE,
  REASON,
  deployFundingFactory,
  deployToken,
  defaultParams,
  createPool,
  contribute,
  eip712Domain,
  randNonce,
  signIntent,
  signClose,
  signCancel,
  signVoteRefund,
  signClaimRefund,
  signCreatePool,
  signReceiveAuth,
};
