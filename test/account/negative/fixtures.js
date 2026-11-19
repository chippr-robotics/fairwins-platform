/**
 * Spec 112 (FR-004) — shared fixtures for the account-stack negative-path suites.
 *
 * Deploys the vendored CoinbaseSmartWallet exactly as test/account/wallet.test.js
 * and test/integration/passkey-account.e2e.test.js do (implementation + factory +
 * createAccount), and adds the two things a negative suite needs that those do
 * not: a signer standing at the HARDCODED EntryPoint v0.6 address (impersonated,
 * so EntryPoint-only branches can be driven without deploying an EntryPoint), and
 * an owner whose key can sign a raw 32-byte digest (validateUserOp checks
 * `ecrecover(hash)` with no EIP-191 prefix, which a Hardhat JSON-RPC signer
 * cannot produce).
 *
 * The owner key below is generated per fixture with `ethers.Wallet.createRandom`
 * and lives only in test memory; nothing here reads or writes key material.
 */

const { ethers, network } = require('hardhat');
const { AbiCoder } = require('ethers');

const abi = AbiCoder.defaultAbiCoder();

/** EntryPoint v0.6 — `CoinbaseSmartWallet.entryPoint()` returns this constant. */
const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const REPLAYABLE_NONCE_KEY = 8453n;
const SIGNATURE_WRAPPER_TUPLE = 'tuple(uint256 ownerIndex, bytes signatureData)';

/** MultiOwnable storage root (ERC-7201 slot, MultiOwnable.sol). */
const MULTI_OWNABLE_STORAGE = BigInt('0x97e2c6aad4ce5d562ebfaa00db6b9e0fb66ea5d8162ed5b243f51a2e03086f00');

const addrOwnerBytes = (addr) => abi.encode(['address'], [addr]);

/** Nonce whose upper 192 bits (the EntryPoint "key") are `key`. */
const nonceWithKey = (key, seq = 0n) => (BigInt(key) << 64n) | BigInt(seq);

function wrapSignature(ownerIndex, signatureData) {
  return abi.encode([SIGNATURE_WRAPPER_TUPLE], [{ ownerIndex, signatureData }]);
}

/** Raw (un-prefixed) secp256k1 signature over a 32-byte digest, r‖s‖v. */
function signDigest(wallet, digest) {
  return wallet.signingKey.sign(digest).serialized;
}

function baseUserOp(sender, overrides = {}) {
  return {
    sender,
    nonce: 0n,
    initCode: '0x',
    callData: '0x',
    callGasLimit: 100000n,
    verificationGasLimit: 200000n,
    preVerificationGas: 50000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    paymasterAndData: '0x',
    signature: '0x',
    ...overrides,
  };
}

/** A Hardhat signer at the EntryPoint v0.6 address (no code there on the local chain). */
async function impersonateEntryPoint() {
  await network.provider.request({ method: 'hardhat_impersonateAccount', params: [ENTRY_POINT_V06] });
  await network.provider.request({
    method: 'hardhat_setBalance',
    params: [ENTRY_POINT_V06, '0x' + ethers.parseEther('10').toString(16)],
  });
  return ethers.getSigner(ENTRY_POINT_V06);
}

async function deployAccountFixture() {
  const [deployer, driver, stranger, other] = await ethers.getSigners();
  // Raw-digest signing owner (index 0) + a Hardhat signer owner able to send txs (index 1).
  const keyOwner = ethers.Wallet.createRandom();

  const Wallet = await ethers.getContractFactory('CoinbaseSmartWallet');
  const impl = await Wallet.deploy();
  const Factory = await ethers.getContractFactory('CoinbaseSmartWalletFactory');
  const factory = await Factory.deploy(await impl.getAddress());

  const owners = [addrOwnerBytes(keyOwner.address), addrOwnerBytes(driver.address)];
  await factory.createAccount(owners, 0);
  const account = Wallet.attach(await factory['getAddress(bytes[],uint256)'](owners, 0));
  const accountAddr = await account.getAddress();

  const entryPoint = await impersonateEntryPoint();

  return { deployer, driver, stranger, other, keyOwner, impl, factory, Wallet, account, accountAddr, owners, entryPoint };
}

/**
 * Storage slot of the first data word of `ownerAtIndex[index]` (a 32-byte `bytes`
 * value is stored "long form": length*2+1 at the mapping slot, data at keccak(slot)).
 */
function ownerDataSlot(index) {
  const mappingSlot = MULTI_OWNABLE_STORAGE + 2n; // struct field #2: ownerAtIndex
  const elementSlot = ethers.keccak256(abi.encode(['uint256', 'uint256'], [index, mappingSlot]));
  return ethers.keccak256(elementSlot);
}

module.exports = {
  ENTRY_POINT_V06,
  REPLAYABLE_NONCE_KEY,
  abi,
  addrOwnerBytes,
  nonceWithKey,
  wrapSignature,
  signDigest,
  baseUserOp,
  impersonateEntryPoint,
  deployAccountFixture,
  ownerDataSlot,
};
